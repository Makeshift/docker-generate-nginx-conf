A simple little docker container that connects to the docket socket (either locally or remotely) and generates Nginx virtual host files based on a template when a container starts or dies.

Q: Why not Traefik?
A: Traefik v1 was great, but didn't meet some of my requirements when it came to having multiple ACME cert methods (eg combining DNS and TLS was a gigantic hassle), and I messed with v2 for about a week straight and at the time of writing it's so horrifically buggy and verbose that I can't deal with it.

### How to use
The `docker-compose.yaml` file gives a couple of use cases, including remote docker hosts, different suffixes on configs and a couple of local subdomain examples.