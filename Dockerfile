FROM node:alpine
WORKDIR /usr/src/app
COPY index.js package.json ./
COPY ./templates/* ./templates/
RUN yarn
CMD ["node", "index.js"]
