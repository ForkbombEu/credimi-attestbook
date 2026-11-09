// Fixture-generation sandbox child entry point (FR-013, issue #44).
//
// Modelled on validation's schema-sandbox-entry: one JSON request on stdin and
// one JSON result on stdout. Errors exit non-zero without writing a message,
// because an exception could carry claim values. The parent enforces the hard
// timeout, RSS watchdog, output cap and shared concurrency limit.

import { runFixtureCore } from './synthesize'
import type { FixtureSandboxRequest } from './sandbox'

// Parent-independent backstop for an orphaned child.
setTimeout(() => process.exit(2), 15_000).unref?.()

try {
  const raw = await Bun.stdin.text()
  if (raw === '') {
    process.exit(2)
  }
  const request = JSON.parse(raw) as FixtureSandboxRequest
  const result = runFixtureCore(request)
  const output = JSON.stringify(result)
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error === null || error === undefined) {
        resolve()
      } else {
        reject(error)
      }
    })
  })
  process.exitCode = 0
} catch {
  process.stderr.write('fixture sandbox failed\n')
  process.exitCode = 1
}
