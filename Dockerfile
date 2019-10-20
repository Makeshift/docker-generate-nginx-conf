FROM node:alpine
WORKDIR /usr/src/app
COPY index.js package.json *.vhost ./
RUN npm install
CMD ["node", "index.js"]