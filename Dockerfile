FROM node:alpine
WORKDIR /usr/src/app
COPY index.js package.json ./
RUN npm install
CMD ["node", "index.js"]