import { createApp } from './app'
import { loadConfig } from './config'

const config = loadConfig()
const app = createApp()

const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  fetch: app.fetch,
})

console.log(`AttestBook listening on http://${server.hostname}:${server.port}`)

function shutdown(signal: 'SIGINT' | 'SIGTERM'): void {
  console.log(`received ${signal}, shutting down`)
  server
    .stop()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('failed to stop the HTTP server cleanly', error)
      process.exit(1)
    })
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
