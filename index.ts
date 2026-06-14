import { Glob } from 'bun'
import Docker from 'dockerode'
import renderTemplate from 'es6-template-strings'
import path from 'node:path'
import pino from 'pino'
import type { AppConfig, DockerEvent } from './types.ts'

const logger = pino({
  name: 'docker-nginx-generator',
  level: process.env.LOG_LEVEL ?? 'info',
  transport: {
    target: 'pino-pretty',
  },
})

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

function loggableError (error: unknown): Error | string {
  return error instanceof Error ? error : String(error)
}

const config: AppConfig = {
  dockerConf: JSON.parse(resolveEnvVar('{ "socketPath": "/var/run/docker.sock" }', 'DOCKER_CONF', 'docker_conf')),
  confDir: resolveEnvVar('/conf', 'VHOST_PATH', 'conf_dir'),
  suffix: resolveEnvVar('standard', 'GEN_FILE_SUFFIX', 'suffix'),
  template: resolveEnvVar('./templates/template.vhost', 'DEFAULT_TEMPLATE', 'template'),
  destination: resolveEnvVar(undefined, 'REMOTE_DESTINATION', 'destination'),
}

async function connectToDocker(): Promise<Docker> {
  try {
    const client = new Docker(config.dockerConf)
    logger.debug({ dockerConf: config.dockerConf }, 'Connecting to Docker')
    await client.ping()
    logger.info('Connected to Docker')
    return client
  } catch (e) {
    logger.error({ dockerConf: config.dockerConf, err: loggableError(e) }, 'Failed to connect to Docker')
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
        logger.error({ line }, 'Failed to parse Docker event')
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
        void start().catch((error: unknown) => {
          logger.error({ err: loggableError(error) }, 'Config generation failed')
        })
      }, 5000)
    }
  })
  stream.on('error', (err) => {
    logger.error({ err }, 'Docker event stream error')
    process.exit(1)
  })
}

async function start (): Promise<void> {
  logger.debug('Starting config generation')
  const containers = await docker.listContainers()
  logger.debug({ containerCount: containers.length }, 'Found containers')
  const generatedFiles = await generateAllFiles(containers)
  await cleanOldFiles(generatedFiles.map(file => file.fileName))
  if (generatedFiles.some(file => file.changed)) {
    await sendSigHup(containers)
  }
}

async function cleanOldFiles (omitFiles: string[]): Promise<boolean> {
  const glob = new Glob(`*.${config.suffix}.conf`)
  const files = await Array.fromAsync(glob.scan({ cwd: config.confDir, absolute: true }))
  const deleteFiles = files.filter(fileName => !omitFiles.includes(fileName))

  if (deleteFiles.length > 0) {
    logger.info({ fileCount: deleteFiles.length, files: deleteFiles }, 'Deleting stale config files')
    await Promise.allSettled(deleteFiles.map(f => Bun.file(f).delete()))
    return true
  }
  logger.debug('No stale config files to delete')
  return false
}

async function sendSigHup (containers: Docker.ContainerInfo[]): Promise<void> {
  const notify = containers.filter(container => 'proxy.notify' in container.Labels)
  if (notify.length > 0) {
    logger.info({ containerCount: notify.length, containers: notify.map(container => container.Names[0]) }, 'Sending SIGHUP to containers')
    await Promise.allSettled(notify.map(async container => {
      await docker.getContainer(container.Id).kill({ signal: 'HUP' })
    }))
  } else {
    logger.debug('No containers with proxy.notify label, skipping SIGHUP')
  }
}

async function generateAllFiles (containers: Docker.ContainerInfo[]): Promise<HostGenResult[]> {
  logger.debug({ containerCount: containers.length }, 'Scanning containers for proxy.hosts label')
  const results = await Promise.allSettled(containers.map(async container => {
    if ('proxy.hosts' in container.Labels) {
      const containerName = getContainerName(container)
      logger.debug({ containerName }, 'Found container for proxying')
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

    const existingVhost = await Bun.file(vhostFilePath).text().catch(() => undefined)

    if (existingVhost === renderedVhost) {
      logger.debug({ vhostFilePath }, 'No changes detected, skipping write')
      return ret
    }

    logger.info({ vhostFilePath, singleServerName, proxyPass, isPublic: isPublic !== '' }, 'Writing vhost')

    await Bun.write(vhostFilePath, renderedVhost)
    return { ...ret, changed: true }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      logger.error({ templateFile, singleServerName }, 'Could not find template file, skipping')
    } else {
      logger.error({ err: loggableError(error) }, 'Failed to generate host file')
    }
    return ret
  }
}

function getContainerName(container: Docker.ContainerInfo): string {
  if (container.Names.length > 1) {
    logger.warn({ containerId: container.Id, names: container.Names }, 'Container has multiple names')
  }
  const name = container.Names[0]?.split('/')[1]
  if (!name) {
    logger.warn({ containerId: container.Id }, 'Container has no parseable name')
  }
  return name ?? ''
}

void start().catch((error: unknown) => {
  logger.error({ err: loggableError(error) }, 'Config generation failed')
})
void watchDockerEvents().catch((error: unknown) => {
  logger.error({ err: loggableError(error) }, 'Failed to watch Docker events')
})
