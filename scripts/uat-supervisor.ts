#!/usr/bin/env bun
// Test-only supervisor for the local user acceptance tests.
//
// `scripts/uat-start.sh` runs this file instead of the application directly so a
// UAT scenario can observe restart persistence without process, container or
// signal control from the tester. It keeps the application on its normal
// loopback port and exposes one narrow control endpoint on a second loopback
// port:
//
//   POST http://127.0.0.1:3001/restart
//
// The endpoint stops the application child, starts it again against the same
// environment and database, waits until /health is ready and answers 200 with
// the new process id. Nothing here is part of the production server, both
// listeners bind loopback only, and the file lives under `scripts/`, which the
// production build does not copy.

const APP_ENTRY = 'dist/server.js'
const CONTROL_HOST = '127.0.0.1'
const CONTROL_PORT = Number(process.env.UAT_RESTART_PORT ?? '3001')
const APP_PORT = process.env.PORT ?? '3000'
const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 100
const STOP_TIMEOUT_MS = 5_000

if (!Number.isInteger(CONTROL_PORT) || CONTROL_PORT < 1 || CONTROL_PORT > 65_535) {
  throw new Error(`invalid UAT_RESTART_PORT "${process.env.UAT_RESTART_PORT ?? ''}"`)
}

let application = null
let shuttingDown = false
let restartInFlight = null

function spawnApplication() {
  const child = Bun.spawn(['bun', APP_ENTRY], {
    cwd: process.cwd(),
    env: process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  application = child
  // A crash outside a requested restart is restarted so the supervisor keeps
  // the application reachable for the remaining UAT scenarios.
  child.exited.then((code) => {
    if (shuttingDown || application !== child) {
      return
    }
    application = null
    console.error(`UAT application exited with code ${code}; restarting`)
    setTimeout(() => {
      if (!shuttingDown) {
        void startApplication().catch((error) => {
          console.error('UAT application restart failed', error)
        })
      }
    }, 250)
  })
  return child
}

async function waitUntilReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${APP_PORT}/health`)
      if (response.ok) {
        return
      }
    } catch {
      // The application has not bound its port yet.
    }
    await Bun.sleep(READY_POLL_MS)
  }
  throw new Error(`UAT application did not become ready on port ${APP_PORT}`)
}

async function startApplication() {
  const child = spawnApplication()
  try {
    await waitUntilReady()
    return child
  } catch (error) {
    if (application === child) {
      application = null
    }
    child.kill('SIGKILL')
    throw error
  }
}

async function stopApplication() {
  const child = application
  application = null
  if (child === null) {
    return
  }
  child.kill('SIGTERM')
  const timeout = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS)
  try {
    await child.exited
  } finally {
    clearTimeout(timeout)
  }
}

async function restartApplication() {
  if (restartInFlight !== null) {
    return restartInFlight
  }
  restartInFlight = (async () => {
    await stopApplication()
    const child = await startApplication()
    return child.pid
  })().finally(() => {
    restartInFlight = null
  })
  return restartInFlight
}

async function main() {
  await startApplication()

  const server = Bun.serve({
    hostname: CONTROL_HOST,
    port: CONTROL_PORT,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (path === '/health' && request.method === 'GET') {
        return Response.json({
          supervisor: 'ok',
          application: application === null ? 'stopped' : 'running',
        })
      }
      if (path === '/restart' && request.method === 'POST') {
        try {
          const pid = await restartApplication()
          return Response.json({
            status: 'restarted',
            pid,
            applicationUrl: `http://127.0.0.1:${APP_PORT}/health`,
          })
        } catch (error) {
          console.error('UAT restart failed', error)
          return Response.json({ status: 'failed' }, { status: 500 })
        }
      }
      return new Response('not found', { status: 404 })
    },
  })

  console.log(
    `UAT restart control: POST http://${CONTROL_HOST}:${server.port}/restart (restarts the application on port ${APP_PORT})`,
  )

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    console.log(`UAT supervisor received ${signal}, shutting down`)
    await server.stop(true)
    await stopApplication()
    process.exit(0)
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch(async (error) => {
  console.error('UAT supervisor failed to start', error)
  await stopApplication()
  process.exit(1)
})
