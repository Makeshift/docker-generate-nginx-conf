const config = {
  docker_conf: process.env.docker_conf ? JSON.parse(process.env.docker_conf) : { socketPath: '/var/run/docker_conf.sock' },
  conf_dir: process.env.conf_dir || '/conf',
  suffix: process.env.suffix || 'standard',
  template: process.env.template || './templates/template.vhost',
  destination: process.env.destination
}

const fs = require('fs').promises
const path = require('path')
const { Docker } = require('node-docker-api')
const { execSync } = require('child_process')
let dockerHostIP

const promisifyStream = stream => new Promise((resolve, reject) => {
  stream.on('data', data => ['die', 'start'].includes(JSON.parse(data.toString()).status) ? setTimeout(start, 5000) : '')
  stream.on('end', resolve)
  stream.on('error', reject)
})

const docker = new Docker(config.docker_conf)

docker.events()
  .then(stream => promisifyStream(stream))
  .catch(error => console.log(error))

async function start () {
  // rm all files
  await deleteConfigFiles()
  // Generate new ones
  await generateAllFiles()
  // Send sighup
  await sendSigHup()
}

async function deleteConfigFiles () {
  const files = await fs.readdir(path.normalize(config.conf_dir))
  await Promise.all(files.map(async file => {
    if (file.endsWith(`.${config.suffix}.conf`)) {
      await fs.unlink(path.join(config.conf_dir, file))
    }
  }))
}

async function sendSigHup () {
  const notify = (await docker.container.list()).filter(container => 'proxy.notify' in container.data.Labels)
  if (notify.length > 0) {
    console.log(`Found ${notify.length} containers to SIGHUP: ${notify.map(container => container.data.Names[0]).join(', ')}`)
    await Promise.all(notify.map(async container => await container.kill({ signal: 'HUP' })))
  }
}

async function generateAllFiles () {
  console.log('Getting list of containers')
  const containers = await docker.container.list()
  await Promise.all(containers.map(async container => {
    if ('proxy.hosts' in container.data.Labels) {
      const containerName = container.data.Names[0].split('/')[1]
      console.log(`Found container for proxying ${containerName}`)
      await generateHostFile(container)
    }
  }))
}

async function generateHostFile (container) {
  // console.log(container.data.NetworkSettings.Networks)
  const serverNamesArray = container.data.Labels['proxy.hosts'].split(',')
  const serverNames = serverNamesArray.join('  ')
  const containerPort = Number(container.data.Labels['proxy.port']) || 80
  // External
  let proxyPass
  let remoteIp

  const isHostNetworking = 'host' in container.data.NetworkSettings.Networks

  if (config.destination) {
    // External
    const ports = container.data.Ports.filter(port => port.PrivatePort === containerPort)
    // If there's a private port that matches our container port, then we grab the public port
    // Else, we use the given container port as it's probably in host networking mode
    const hostPort = ports.length > 0 ? ports[0].PublicPort : containerPort

    proxyPass = `${config.destination}:${hostPort}`
    remoteIp = config.destination
  } else if (isHostNetworking) {
    // Local host networking
    // Do some hackery to get the host IP
    if (!dockerHostIP) {
      dockerHostIP = execSync("route | awk '/^default/ { print $2 }'").toString().trim()
    }
    proxyPass = `http://${dockerHostIP}:${containerPort}`
  } else {
    // Local and in same network
    proxyPass = `${container.data.Names[0].split('/')[1]}:${containerPort}`
  }
  const templateFile = 'proxy.template' in container.data.Labels ? container.data.Labels['proxy.template'] : config.template
  const template = (await fs.readFile(templateFile)).toString()
  const isPublic = 'proxy.isPublic' in container.data.Labels ? 'allow 0.0.0.0/0;' : ''
  const vhost = template.interpolate({
    server_names: serverNames,
    proxy_pass: proxyPass,
    is_public: isPublic,
    single_server_name: serverNamesArray[0],
    remote_ip: remoteIp
  })
  const vhostFile = `${path.join(config.conf_dir, serverNamesArray[0])}.${config.suffix}.conf`
  console.log(`Writing new vhost file -> ${vhostFile} for ${serverNamesArray[0]} @ ${proxyPass} (Public: ${isPublic})`)
  await fs.writeFile(vhostFile, vhost)
}

// eslint-disable-next-line no-extend-native
String.prototype.interpolate = function (params) {
  const names = Object.keys(params)
  const vals = Object.values(params)
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return \`${this}\`;`)(...vals)
}

start()
