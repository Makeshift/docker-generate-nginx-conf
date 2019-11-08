#!/bin/sh
set -e
echo "Online and waiting for changes."
while inotifywait -q -e close_write,moved_to,create /watch; do
    sleep 1
    echo "Change happened, getting list of containers with proxy.notify"
    for container in $(curl -s --unix-socket /var/run/docker.sock http://docker/containers/json?filters=%7B%22label%22%3A%7B%22proxy.notify%22%3A%20true%7D%7D | jq -r .[].Id); do
        echo "Hitting ${container} with a SIGHUP"
        curl -s --unix-socket /var/run/docker.sock -X POST http://docker/containers/${container}/kill?signal=SIGHUP
    done
done