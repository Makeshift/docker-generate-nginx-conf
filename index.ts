import { Glob } from 'bun'
import Docker from 'dockerode'
import renderTemplate from 'es6-template-strings'
import path from 'node:path'
import type { AppConfig, DockerEvent } from './types.ts'

const config: AppConfig = {
  dockerConf: process.env.docker_conf ? JSON.parse(process.env.docker_conf) : { socketPath: '/var/run/docker_conf.sock' },
  confDir: process.env.conf_dir ?? '/conf',
  suffix: process.env.suffix ?? 'standard',
  template: process.env.template ?? './templates/template.vhost',
  destination: process.env.destination,
}

async function connectToDocker(): Promise<Docker> {
  try {
    const client = new Docker(config.dockerConf)
    await client.ping()
    return client
  } catch (e) {
    console.error('Failed to connect to Docker:')
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
        console.error('Failed to parse Docker event:', line)
        return false
      }
    })

    if (shouldRestart) {
      if (startTimeout) clearTimeout(startTimeout)
      startTimeout = setTimeout(() => {
        startTimeout = null
        void start().catch(console.error)
      }, 5000)
    }
  })
  stream.on('error', (err) => {
    console.error('Docker event stream error:', err)
    process.exit(1)
  })
}

async function start (): Promise<void> {
  const containers = await docker.listContainers()
  const generatedFiles = await generateAllFiles(containers)

  if (generatedFiles.some(file => file.changed)) {
    await cleanOldFiles(generatedFiles.map(file => file.fileName))
    await sendSigHup(containers)
  }
}

async function cleanOldFiles (omitFiles: string[]): Promise<void> {
  const glob = new Glob(`*.${config.suffix}.conf`)
  const files = await Array.fromAsync(glob.scan({ cwd: config.confDir, absolute: true }))
  const deleteFiles = files
    .filter(fileName => {
      if (omitFiles.includes(path.basename(fileName))) {
        return false
      }
      return true
    })

  await Promise.allSettled(deleteFiles.map(f => Bun.file(f).delete()))
}

async function sendSigHup (containers: Docker.ContainerInfo[]): Promise<void> {
  const notify = containers.filter(container => 'proxy.notify' in container.Labels)
  if (notify.length > 0) {
    console.log(`Found ${notify.length} containers to SIGHUP: ${notify.map(container => container.Names[0]).join(', ')}`)
    await Promise.allSettled(notify.map(async container => {
      await docker.getContainer(container.Id).kill({ signal: 'HUP' })
    }))
  }
}

async function generateAllFiles (containers: Docker.ContainerInfo[]): Promise<HostGenResult[]> {
  console.log('Getting list of containers')
  const results = await Promise.allSettled(containers.map(async container => {
    if ('proxy.hosts' in container.Labels) {
      const containerName = getContainerName(container)
      console.log(`Found container for proxying ${containerName}`)
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
      console.log(`No changes detected for ${vhostFilePath}, skipping write.`)
      return ret
    }

    await Bun.write(vhostFilePath, renderedVhost)
    return { ...ret, changed: true }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      console.error(`Could not find template file ${templateFile} requested by ${singleServerName}, skipping...`)
    } else {
      console.error(error)
    }
    return ret
  }
}

function getContainerName(container: Docker.ContainerInfo): string {
  if (container.Names.length > 1) {
    console.warn(`Container ${container.Id} has multiple names: ${container.Names.join(', ')}`)
  }
  const name = container.Names[0]?.split('/')[1]
  if (!name) {
    console.warn(`Container ${container.Id} has no parseable name`)
  }
  return name ?? ''
}

void start().catch(console.error)
void watchDockerEvents().catch(console.error)
