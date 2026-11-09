import { existsSync } from 'node:fs'

import { createApp } from './app'
import { createMockCaptureExplorer } from './capture'
import { loadConfig } from './config'
import { openDatabase } from './db/database'
import { applyMigrations } from './db/migrations'
import { IssuerFixtureGenerator } from './fixtures'
import { Registry } from './registry'
import { CredentialValidator, RulebookSnapshotCache } from './validation'

/** Vite writes the built web UI here; `bun run build` produces it. */
const UI_DIST_PATH = './dist/ui'

const config = loadConfig()
const database = openDatabase(config.databasePath)
applyMigrations(database)

const registry = new Registry({ database })
const schemaSandbox = {
  timeoutMs: config.schemaSandboxTimeoutMs,
  maxRssBytes: config.schemaSandboxMaxRssMb * 1024 * 1024,
  maxConcurrent: config.schemaSandboxConcurrency,
}
const validation = new CredentialValidator({
  source: registry,
  sandbox: schemaSandbox,
  snapshotCache: new RulebookSnapshotCache({
    maxEntries: config.validationCacheMaxEntries,
    maxBytes: config.validationCacheMaxMb * 1024 * 1024,
  }),
})
const issuerFixtures = new IssuerFixtureGenerator({ source: registry, sandbox: schemaSandbox })
// UI-006 is deliberately mock-backed: the explorer is seeded from the
// deterministic local mock source and labels every capture `transport: mock`.
const captures = createMockCaptureExplorer({ validation })
const app = createApp({
  registry,
  validation,
  issuerFixtures,
  captures,
  ...(existsSync(UI_DIST_PATH) ? { uiRoot: UI_DIST_PATH } : {}),
})

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
