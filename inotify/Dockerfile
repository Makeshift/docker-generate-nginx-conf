FROM curlimages/curl:latest

USER root

RUN apk add --no-cache inotify-tools jq

USER curl_user

COPY ./init.sh /

CMD ["/init.sh"]
