import { bunPluginPino } from 'bun-plugin-pino'

await Bun.build({
  entrypoints: ['./index.ts'],
  outdir: './dist',
  target: 'bun',
  sourcemap: 'linked',
  plugins: [
    bunPluginPino({
      transports: ['pino-pretty'],
    }),
  ],
})
