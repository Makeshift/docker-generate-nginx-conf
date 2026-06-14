# Deprecated

This is a very old, deprecated project that isn't really maintained. Traefik is a much better solution now and I recommend it instead.

This repo is kept around for posterity and because one of my Raspberry Pi's is still running it.

## What is?

A simple little docker container that connects to the docker socket (either locally or remotely) and generates Nginx virtual host files based on a template when a container starts or dies.

Q: Why not Traefik?

A: Traefik v1 was great, but didn't meet some of my requirements when it came to having multiple ACME cert methods (eg combining DNS and TLS was a gigantic hassle), and I messed with v2 for about a week straight and at the time of writing it's so horrifically buggy and verbose that I can't deal with it. So, nginx it is.

### How to use

The `docker-compose.yaml` file gives a couple of use cases, including remote docker hosts, different suffixes on configs and a couple of local subdomain examples.

You can configure the the conf generator with the followng environment variables:

* `DOCKER_CONF` Is a JSON strinigified object used by [Docker Modem](https://www.npmjs.com/package/docker-modem) to connect to the docker endpoint. Defaults to `{"socketPath":"/var/run/docker.sock"}`. You can alternatively use environment variables consumed by docker-modem like `DOCKER_HOST`.
* `VHOST_PATH` Is the directory in the container that config will be generated in. Defaults to `/conf`.
* `DEFAULT_TEMPLATE` Is the default template we use for each vhost
* `GEN_FILE_SUFFIX` Is the suffix we add to each config file so we can have multiple config generators pointed to the same place and they won't interfere with each other. Defaults to `standard`.
* `REMOTE_DESTINATION` If the docker socket you're generating config for isn't in the same network as nginx (either it's remote or just in a different network) you can set the host here. Eg. `http://<destination>:<port>`. See notes below for more info.
* `LOG_LEVEL` The log level for the config generator. Defaults to `info`. Valid levels from least verbose to most: `error`, `warn`, `notice`, `info`, `debug`. See [log](https://www.npmjs.com/package/log) for more info.

You can configure containers with the following labels to change their settings:

* `proxy.notify` Containers with this label will receive a SIGHUP every time we generate config (basically to reload nginx) **Note: This currently doesn't work if the container is pointed to another host than your webserver, because it'll try to reload anything with the `proxy.notify` label on the target host. You can either reload nginx manually using `docker kill web_web_1 -s HUP` or use the inotify sidecar detailed below..
* `proxy.hosts` A comma delimited list of URL's for nginx's host list
* `proxy.port` The container port.
* `proxy.public` Adds `allow 0.0.0.0/0;` to the template if it has `${is_public}` in it somewhere.
* `proxy.template` The name of the template to use relative to the config generator.

### Inotify Sidecar

If all of your containers are on the same host as the Nginx container, then the config generator will automatically hit nginx with a `SIGHUP` after generating config. _However_, I didn't feel like having to overcomplicate that script to look at local `proxy.notify` targets if their container watch targets are on a different host. Therefore, I also included a little inotify script in the `inotify` directory. This is a simple sidecar container that will `SIGHUP` all local `proxy.notify` containers in the event anything in the `conf` folder changes.

You can see an example of it working in `docker-compose.yaml`.

Notes:

* If `REMOTE_DESTINATION` is omitted, we assume that the nginx container will be able to resolve the container using its name (docker dns) and will use `proxy.port` as given.
* If `REMOTE_DESTINATION` is present, we search for `proxy.port` in the open ports of the container and find the relevant `PublicPort`. If the container is on another host, you should expose the container port on a random host port eg.

```yaml
ports:
  - 9117
labels:
  - proxy.port=9117
```
