import renderTemplate from 'es6-template-strings'
import { Docker } from 'node-docker-api'
import { execSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { AppConfig, DockerConnectionOptions, DockerEvent, ProxyContainer } from './types.ts'

const defaultDockerConfig: DockerConnectionOptions = { socketPath: '/var/run/docker_conf.sock' }

const parseDockerConfig = (value: string): DockerConnectionOptions => JSON.parse(value) as DockerConnectionOptions

const config: AppConfig = {
  docker_conf: process.env.docker_conf ? parseDockerConfig(process.env.docker_conf) : defaultDockerConfig,
  conf_dir: process.env.conf_dir ?? '/conf',
  suffix: process.env.suffix ?? 'standard',
  template: process.env.template ?? './templates/template.vhost',
  destination: process.env.destination,
}

let dockerHostIP: string | undefined

const docker = new Docker(config.docker_conf)

const promisifyStream = (stream: Readable): Promise<void> => new Promise((resolve, reject) => {
  stream.on('data', (data: Buffer | string) => {
    const event = parseDockerEvent(data)

    if (event.status && ['die', 'start'].includes(event.status)) {
      setTimeout(() => {
        void start().catch(logError)
      }, 5000)
    }
  })
  stream.on('end', resolve)
  stream.on('error', reject)
})

docker.events()
  .then(stream => promisifyStream(stream as Readable))
  .catch(logError)

function parseDockerEvent (data: Buffer | string): DockerEvent {
  return JSON.parse(data.toString()) as DockerEvent
}

function logError (error: unknown): void {
  console.log(error)
}

async function start (): Promise<void> {
  await deleteConfigFiles()
  await generateAllFiles()
  await sendSigHup()
}

async function deleteConfigFiles (): Promise<void> {
  const files = await fs.readdir(path.normalize(config.conf_dir))
  await Promise.all(files.map(async file => {
    if (file.endsWith(`.${config.suffix}.conf`)) {
      await fs.unlink(path.join(config.conf_dir, file))
    }
  }))
}

async function sendSigHup (): Promise<void> {
  const notify = (await getContainers()).filter(container => 'proxy.notify' in container.data.Labels)
  if (notify.length > 0) {
    console.log(`Found ${notify.length} containers to SIGHUP: ${notify.map(container => container.data.Names[0]).join(', ')}`)
    await Promise.all(notify.map(async container => await container.kill({ signal: 'HUP' })))
  }
}

async function generateAllFiles (): Promise<void> {
  console.log('Getting list of containers')
  const containers = await getContainers()
  await Promise.all(containers.map(async container => {
    if ('proxy.hosts' in container.data.Labels) {
      const containerName = getContainerName(container)
      console.log(`Found container for proxying ${containerName}`)
      await generateHostFile(container)
    }
  }))
}

async function generateHostFile (container: ProxyContainer): Promise<void> {
  const proxyHosts = container.data.Labels['proxy.hosts']

  if (!proxyHosts) {
    return
  }

  const serverNamesArray = proxyHosts.split(',')
  const singleServerName = serverNamesArray[0]

  if (!singleServerName) {
    return
  }

  const serverNames = serverNamesArray.join('  ')
  const containerPort = Number(container.data.Labels['proxy.port']) || 80
  let proxyPass: string
  let remoteIp: string | undefined

  const isHostNetworking = 'host' in container.data.NetworkSettings.Networks

  if (config.destination) {
    const ports = container.data.Ports.filter(port => port.PrivatePort === containerPort)
    const hostPort = ports.length > 0 ? ports[0]?.PublicPort : containerPort

    proxyPass = `${config.destination}:${hostPort}`
    remoteIp = config.destination
  } else if (isHostNetworking) {
    dockerHostIP ??= execSync('route | awk \'/^default/ { print $2 }\'').toString().trim()
    proxyPass = `http://${dockerHostIP}:${containerPort}`
  } else {
    proxyPass = `${getContainerName(container)}:${containerPort}`
  }

  const templateFile = 'proxy.template' in container.data.Labels ? container.data.Labels['proxy.template'] : config.template
  try {
    const template = (await fs.readFile(templateFile)).toString()
    const isPublic = 'proxy.isPublic' in container.data.Labels ? 'allow 0.0.0.0/0;' : ''
    const vhost = renderTemplate(template, {
      server_names: serverNames,
      proxy_pass: proxyPass,
      is_public: isPublic,
      single_server_name: singleServerName,
      remote_ip: remoteIp,
    })
    const vhostFile = `${path.join(config.conf_dir, singleServerName)}.${config.suffix}.conf`
    console.log(`Writing new vhost file -> ${vhostFile} for ${singleServerName} @ ${proxyPass} (Public: ${isPublic})`)
    await fs.writeFile(vhostFile, vhost)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      console.log(`Could not find template file ${templateFile} requested by ${singleServerName}, skipping...`)
    } else {
      console.log(error)
    }
  }
}

async function getContainers (): Promise<ProxyContainer[]> {
  return await docker.container.list() as ProxyContainer[]
}

function getContainerName (container: ProxyContainer): string {
  return container.data.Names[0]?.split('/')[1] ?? ''
}

void start().catch(logError)
