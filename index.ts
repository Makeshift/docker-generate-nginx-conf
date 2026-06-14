import { Glob } from 'bun'
import Docker from 'dockerode'
import renderTemplate from 'es6-template-strings'
import path from 'node:path'
import type { AppConfig, DockerEvent } from './types.ts'

const config: AppConfig = {
  docker_conf: process.env.docker_conf ? JSON.parse(process.env.docker_conf) : { socketPath: '/var/run/docker_conf.sock' },
  conf_dir: process.env.conf_dir ?? '/conf',
  suffix: process.env.suffix ?? 'standard',
  template: process.env.template ?? './templates/template.vhost',
  destination: process.env.destination,
}

const dockerHostIP = 'host.docker.internal'

const docker = new Docker(config.docker_conf)

async function watchDockerEvents (): Promise<void> {
  const stream = await docker.getEvents()
  stream.on('data', (data: Buffer | string) => {
    const event = JSON.parse(data.toString()) as DockerEvent

    if (event.status && ['die', 'start'].includes(event.status)) {
      setTimeout(() => {
        void start().catch(console.error)
      }, 5000)
    }
  })
  stream.on('error', console.error)
}

async function start (): Promise<void> {
  await deleteConfigFiles()
  await generateAllFiles()
  await sendSigHup()
}

async function deleteConfigFiles (): Promise<void> {
  const glob = new Glob(`*.${config.suffix}.conf`)
  const deletes: Array<Promise<void>> = []
  for await (const file of glob.scan(path.normalize(config.conf_dir))) {
    deletes.push(Bun.file(path.join(config.conf_dir, file)).delete())
  }
  await Promise.allSettled(deletes)
}

async function sendSigHup (): Promise<void> {
  const notify = (await docker.listContainers()).filter(container => 'proxy.notify' in container.Labels)
  if (notify.length > 0) {
    console.log(`Found ${notify.length} containers to SIGHUP: ${notify.map(container => container.Names[0]).join(', ')}`)
    await Promise.allSettled(notify.map(async container => {
      await docker.getContainer(container.Id).kill({ signal: 'HUP' })
    }))
  }
}

async function generateAllFiles (): Promise<void> {
  console.log('Getting list of containers')
  const containers = await docker.listContainers()
  await Promise.allSettled(containers.map(async container => {
    if ('proxy.hosts' in container.Labels) {
      const containerName = getContainerName(container)
      console.log(`Found container for proxying ${containerName}`)
      await generateHostFile(container)
    }
  }))
}

async function generateHostFile (container: Docker.ContainerInfo): Promise<void> {
  const proxyHosts = container.Labels['proxy.hosts']

  if (!proxyHosts) {
    return
  }

  const serverNamesArray = proxyHosts.split(',')
  const singleServerName = serverNamesArray[0]

  if (!singleServerName) {
    return
  }

  const serverNames = serverNamesArray.join('  ')
  const containerPort = Number(container.Labels['proxy.port']) || 80
  let proxyPass: string
  let remoteIp: string | undefined

  const isHostNetworking = 'host' in container.NetworkSettings.Networks

  if (config.destination) {
    const ports = container.Ports.filter(port => port.PrivatePort === containerPort)
    const hostPort = ports.length > 0 ? ports[0]?.PublicPort : containerPort

    proxyPass = `${config.destination}:${hostPort}`
    remoteIp = config.destination
  } else if (isHostNetworking) {
    proxyPass = `${dockerHostIP}:${containerPort}`
  } else {
    proxyPass = `${getContainerName(container)}:${containerPort}`
  }

  const templateFile = 'proxy.template' in container.Labels ? container.Labels['proxy.template'] : config.template
  try {
    const template = await Bun.file(templateFile).text()
    const isPublic = 'proxy.isPublic' in container.Labels ? 'allow 0.0.0.0/0;' : ''
    const vhost = renderTemplate(template, {
      server_names: serverNames,
      proxy_pass: proxyPass,
      is_public: isPublic,
      single_server_name: singleServerName,
      remote_ip: remoteIp,
    })
    const vhostFile = `${path.join(config.conf_dir, singleServerName)}.${config.suffix}.conf`
    console.log(`Writing new vhost file -> ${vhostFile} for ${singleServerName} @ ${proxyPass} (Public: ${isPublic})`)
    await Bun.write(vhostFile, vhost)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      console.log(`Could not find template file ${templateFile} requested by ${singleServerName}, skipping...`)
    } else {
      console.log(error)
    }
  }
}

function getContainerName (container: Docker.ContainerInfo): string {
  return container.Names[0]?.split('/')[1] ?? ''
}

void start().catch(console.error)
void watchDockerEvents().catch(console.error)
