FROM oven/bun:alpine AS build

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install

COPY . ./

RUN bun run build

FROM oven/bun:alpine

WORKDIR /app

COPY --from=build /app/dist/ ./

CMD ["index.js"]
