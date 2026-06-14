FROM curlimages/curl:latest

RUN apk add --no-cache inotify-tools jq

COPY ./init.sh /

CMD ["/init.sh"]
