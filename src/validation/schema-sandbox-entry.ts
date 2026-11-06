// Sandbox child entry point (issue #32).
//
// The parent sends one JSON request on stdin and receives a JSON array of
// `{ index, application }` results on stdout. Errors exit non-zero without
// writing a message, because an exception could carry claim values.

import {
  evaluateSchemaDocument,
  type PendingSchemaDocument,
  type SchemaEvaluationInput,
} from './schema'

interface SandboxRequest {
  readonly items: readonly PendingSchemaDocument[]
  readonly input: SchemaEvaluationInput
}

// Parent-independent backstop for an orphaned child.
setTimeout(() => process.exit(2), 15_000).unref?.()

try {
  const raw = await Bun.stdin.text()
  if (raw === '') {
    process.exit(2)
  }
  const request = JSON.parse(raw) as SandboxRequest
  const results = request.items.map((item) => ({
    index: item.index,
    application: evaluateSchemaDocument(item, request.input),
  }))
  const output = JSON.stringify(results)
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
  process.stderr.write('schema sandbox failed\n')
  process.exitCode = 1
}
