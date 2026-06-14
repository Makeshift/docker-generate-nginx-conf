import { Glob } from 'bun'
import Docker from 'dockerode'
import renderTemplate from 'es6-template-strings'
import log from 'log'
import path from 'node:path'
import type { AppConfig, DockerEvent } from './types.ts'

const logger = log.get('docker-nginx-generator')

function resolveEnvVar (defaultValue: string, ...envVarNames: string[]): string
function resolveEnvVar (defaultValue: string | undefined, ...envVarNames: string[]): string | undefined
function resolveEnvVar (defaultValue: string | undefined, ...envVarNames: string[]): string | undefined {
  const value = defaultValue
  for (const envVarName of envVarNames) {
    if (process.env[envVarName] !== undefined) {
      return process.env[envVarName]
    }
  }
  return value
}

const config: AppConfig = {
  dockerConf: JSON.parse(resolveEnvVar('{ "socketPath": "/var/run/docker_conf.sock" }', 'DOCKER_CONF', 'docker_conf')),
  confDir: resolveEnvVar('/conf', 'VHOST_PATH', 'conf_dir'),
  suffix: resolveEnvVar('standard', 'GEN_FILE_SUFFIX', 'suffix'),
  template: resolveEnvVar('./templates/template.vhost', 'DEFAULT_TEMPLATE', 'template'),
  destination: resolveEnvVar(undefined, 'REMOTE_DESTINATION', 'destination'),
}

async function connectToDocker(): Promise<Docker> {
  try {
    const client = new Docker(config.dockerConf)
    logger.debug('Connecting to Docker at %j', config.dockerConf)
    await client.ping()
    logger.notice('Connected to Docker')
    return client
  } catch (e) {
    logger.error('Failed to connect to Docker at %j', config.dockerConf)
    throw e
  }
}

const docker = await connectToDocker()

let startTimeout: ReturnType<typeof setTimeout> | null = null

async function watchDockerEvents (): Promise<void> {
  const stream = await docker.getEvents()
  stream.on('data', (data: Buffer | string) => {
    const shouldRestart = data.toString().split('\n').some(line => {
      if (!line.trim()) return false
      try {
        const event = JSON.parse(line) as DockerEvent
        return event.status !== undefined && ['die', 'start'].includes(event.status)
      } catch {
        logger.error('Failed to parse Docker event: %s', line)
        return false
      }
    })

    if (shouldRestart) {
      if (startTimeout) {
        logger.debug('Debounce reset, delaying restart')
        clearTimeout(startTimeout)
      }
      startTimeout = setTimeout(() => {
        startTimeout = null
        logger.debug('Debounce fired, triggering start')
        void start().catch(console.error)
      }, 5000)
    }
  })
  stream.on('error', (err) => {
    logger.error('Docker event stream error: %O', err)
    process.exit(1)
  })
}

async function start (): Promise<void> {
  logger.debug('Starting config generation')
  const containers = await docker.listContainers()
  logger.debug('Found %d total containers', containers.length)
  const generatedFiles = await generateAllFiles(containers)
  await cleanOldFiles(generatedFiles.map(file => file.fileName))
  if (generatedFiles.some(file => file.changed)) {
    await sendSigHup(containers)
  }
}

async function cleanOldFiles (omitFiles: string[]): Promise<void> {
  const glob = new Glob(`*.${config.suffix}.conf`)
  const files = await Array.fromAsync(glob.scan({ cwd: config.confDir, absolute: true }))
  const deleteFiles = files.filter(fileName => !omitFiles.includes(fileName))

  if (deleteFiles.length > 0) {
    logger.notice('Deleting %d stale config file(s): %s', deleteFiles.length, deleteFiles.join(', '))
  } else {
    logger.debug('No stale config files to delete')
  }

  await Promise.allSettled(deleteFiles.map(f => Bun.file(f).delete()))
}

async function sendSigHup (containers: Docker.ContainerInfo[]): Promise<void> {
  const notify = containers.filter(container => 'proxy.notify' in container.Labels)
  if (notify.length > 0) {
    logger.notice('Sending SIGHUP to %d container(s): %s', notify.length, notify.map(container => container.Names[0]).join(', '))
    await Promise.allSettled(notify.map(async container => {
      await docker.getContainer(container.Id).kill({ signal: 'HUP' })
    }))
  } else {
    logger.debug('No containers with proxy.notify label, skipping SIGHUP')
  }
}

async function generateAllFiles (containers: Docker.ContainerInfo[]): Promise<HostGenResult[]> {
  logger.debug('Scanning %d containers for proxy.hosts label', containers.length)
  const results = await Promise.allSettled(containers.map(async container => {
    if ('proxy.hosts' in container.Labels) {
      const containerName = getContainerName(container)
      logger.debug('Found container for proxying: %s', containerName)
      const fileName = await generateHostFile(container)
      return fileName
    }
  }))

  return results
    .filter(result => result.status === 'fulfilled' && result.value !== undefined)
    .map(result => (result as PromiseFulfilledResult<HostGenResult>).value)
}

interface HostGenResult {
  fileName: string
  changed: boolean
}

/**
 * Writes a vhost file for the given container based on its labels and the provided template.
 * @param container The Docker container information.
 * @returns HostGenResult
 */
async function generateHostFile (container: Docker.ContainerInfo): Promise<HostGenResult> {
  const proxyHosts = container.Labels['proxy.hosts']!
  const serverNamesArray = proxyHosts.split(',')
  const singleServerName = serverNamesArray[0]!
  const serverNames = serverNamesArray.join('  ')
  const containerPort = Number(container.Labels['proxy.port']) || 80
  let proxyPass: string
  let remoteIp: string | undefined

  const isHostNetworking = 'host' in container.NetworkSettings.Networks

  if (config.destination) {
    const ports = container.Ports.filter(port => port.PrivatePort === containerPort)
    const hostPort = ports[0]?.PublicPort ?? containerPort

    proxyPass = `${config.destination}:${hostPort}`
    remoteIp = config.destination
  } else if (isHostNetworking) {
    proxyPass = `host.docker.internal:${containerPort}`
  } else {
    proxyPass = `${getContainerName(container)}:${containerPort}`
  }

  const templateFile = container.Labels['proxy.template'] ?? config.template
  const vhostFilePath = `${path.join(config.confDir, singleServerName)}.${config.suffix}.conf`
  const ret = { fileName: vhostFilePath, changed: false }
  try {
    const template = await Bun.file(templateFile).text()
    const isPublic = 'proxy.isPublic' in container.Labels ? 'allow 0.0.0.0/0;' : ''
    const renderedVhost = renderTemplate(template, {
      server_names: serverNames,
      proxy_pass: proxyPass,
      is_public: isPublic,
      single_server_name: singleServerName,
      remote_ip: remoteIp,
    })

    console.log(`Writing new vhost file -> ${vhostFilePath} for ${singleServerName} @ ${proxyPass} (Public: ${isPublic})`)

    const existingVhost = await Bun.file(vhostFilePath).text().catch(() => undefined)

    if (existingVhost === renderedVhost) {
      logger.debug('No changes detected for %s, skipping write', vhostFilePath)
      return ret
    }

    logger.notice('Writing vhost %s for %s @ %s (public: %s)', vhostFilePath, singleServerName, proxyPass, isPublic || 'no')

    await Bun.write(vhostFilePath, renderedVhost)
    return { ...ret, changed: true }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      logger.error('Could not find template file %s requested by %s, skipping', templateFile, singleServerName)
    } else {
      logger.error('%O', error)
    }
    return ret
  }
}

function getContainerName(container: Docker.ContainerInfo): string {
  if (container.Names.length > 1) {
    logger.warning('Container %s has multiple names: %s', container.Id, container.Names.join(', '))
  }
  const name = container.Names[0]?.split('/')[1]
  if (!name) {
    logger.warning('Container %s has no parseable name', container.Id)
  }
  return name ?? ''
}

void start().catch(console.error)
void watchDockerEvents().catch(console.error)
