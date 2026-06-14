FROM oven/bun:alpine

COPY ./dist/ ./

CMD ["index.js"]
