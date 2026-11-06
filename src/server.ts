import { createApp } from './app'
import { loadConfig } from './config'
import { openDatabase } from './db/database'
import { applyMigrations } from './db/migrations'
import { Registry } from './registry'
import { CredentialValidator } from './validation'

const config = loadConfig()
const database = openDatabase(config.databasePath)
applyMigrations(database)

const registry = new Registry({ database })
const validation = new CredentialValidator({
  source: registry,
  sandbox: {
    timeoutMs: config.schemaSandboxTimeoutMs,
    maxRssBytes: config.schemaSandboxMaxRssMb * 1024 * 1024,
    maxConcurrent: config.schemaSandboxConcurrency,
  },
})
const app = createApp({ registry, validation })

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
    .then(() => {
      database.close()
      process.exit(0)
    })
    .catch((error: unknown) => {
      console.error('failed to stop the HTTP server cleanly', error)
      process.exit(1)
    })
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
