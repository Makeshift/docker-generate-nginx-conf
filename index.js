const config = {
    docker_conf: process.env["docker_conf"] ? JSON.parse(process.env["docker_conf"]) : {socketPath: '/var/run/docker_conf.sock'},
    conf_dir: process.env["conf_dir"] || "/conf",
    suffix: process.env["suffix"] || "standard",
    template: process.env["template"] || "./template.vhost",
    destination: process.env["destination"]
}

const fs = require('fs').promises;
const path = require('path');
const {Docker} = require('node-docker-api');
const {execSync} = require('child_process');

const promisifyStream = stream => new Promise((resolve, reject) => {
    stream.on('data', data => ["die", "start"].includes(JSON.parse(data.toString()).status) ? setTimeout(start, 5000) : "")
    stream.on('end', resolve)
    stream.on('error', reject)
})

const docker = new Docker(config.docker_conf)

docker.events()
    .then(stream => promisifyStream(stream))
    .catch(error => console.log(error));

async function start() {
    //rm all files
    await deleteConfigFiles();
    //Generate new ones
    await generateAllFiles();
    //Send sighup
    await sendSigHup();
}

async function deleteConfigFiles() {
    let files = await fs.readdir(path.normalize(config.conf_dir));
    await Promise.all(files.map(async file => {
        if (file.endsWith(`.${config.suffix}.conf`)) {
            await fs.unlink(path.join(config.conf_dir, file));
        }
    }))
}

async function sendSigHup() {
    let notify = (await docker.container.list()).filter(container => "proxy.notify" in container.data.Labels);
    console.log(notify)
    await Promise.all(notify.map(async container => await container.kill({signal: "HUP"})));
}

async function generateAllFiles() {
    console.log("Getting list of containers")
    let containers = await docker.container.list();
    await Promise.all(containers.map(async container => {
        if ("proxy.hosts" in container.data.Labels) {
            console.log(`Found container for proxying ${container.data.Names[0]}`)
            await generateHostFile(container)
        }
    }))
}

async function generateHostFile(container) {
    //console.log(container.data.NetworkSettings.Networks)
    let serverNamesArray = container.data.Labels["proxy.hosts"].split(",")
    let server_names = serverNamesArray.join("  ");
    let containerPort = Number(container.data.Labels["proxy.port"]) || 80;
    //External
    let proxy_pass;

    let isHostNetworking = 'host' in container.data.NetworkSettings.Networks;

    if (config.destination) {
        //External
        let ports = container.data.Ports.filter(port => port.PrivatePort === containerPort);
        //If there's a private port that matches our container port, then we grab the public port
        //Else, we use the given container port as it's probably in host networking mode
        let hostPort = ports.length > 0 ? ports[0].PublicPort : containerPort;

        proxy_pass = `http://${config.destination}:${hostPort}`;
    } else if (isHostNetworking) {
        //Local host networking
        //Do some hackery to get the host IP
        let hostIp = execSync("route | awk '/^default/ { print $2 }'").toString().trim();
        proxy_pass = `http://${hostIp}:${containerPort}`
    } else {
        //Local and in same network
        proxy_pass = `http://${container.data.Names[0].split("/")[1]}:${containerPort}`
    }
    let templateFile = "proxy.template" in container.data.Labels ? container.data.Labels["proxy.template"] : config.template;
    let template = (await fs.readFile(templateFile)).toString();
    let vhost = template.interpolate({
        server_names: server_names,
        proxy_pass: proxy_pass,
        is_public: "proxy.isPublic" in container.data.Labels ? "allow 0.0.0.0/0;" : "",
    })
    console.log(vhost)
    await fs.writeFile(`${path.join(config.conf_dir, serverNamesArray[0])}.${config.suffix}.conf`, vhost);
}

String.prototype.interpolate = function (params) {
    const names = Object.keys(params);
    const vals = Object.values(params);
    return new Function(...names, `return \`${this}\`;`)(...vals);
}

start()