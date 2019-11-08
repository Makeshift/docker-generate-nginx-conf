FROM curlimages/curl:latest

USER root
ADD init.sh /init.sh
RUN chmod 750 /init.sh && \
    apk add --no-cache inotify-tools jq
USER curl_user
CMD ["/init.sh"]