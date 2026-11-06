import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

import { MAX_VALIDATION_BODY_BYTES, createApp, type ErrorEnvelope } from './app'
import { createRegistryFixture, type RegistryFixture } from './registry/test-support'
import { CredentialValidator, type CredentialValidationResult } from './validation'
import type { SchemaSandboxLimits } from './validation/schema-sandbox'
import {
  issueTestCredential,
  seedPublishedRulebook,
  type SeedRulebookOptions,
  type SeededRulebook,
} from './validation/test-support'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function setup(
  options: SeedRulebookOptions = {},
  sandbox?: SchemaSandboxLimits,
): {
  app: ReturnType<typeof createApp>
  seeded: SeededRulebook
} {
  fixture = createRegistryFixture()
  const seeded = seedPublishedRulebook(fixture.database, fixture.registry, options)
  const validator = new CredentialValidator({
    source: fixture.registry,
    now: () => '2026-01-01T00:00:00.000Z',
    generateId: () => 'http-validation-id',
    ...(sandbox === undefined ? {} : { sandbox }),
  })
  return { app: createApp({ validation: validator }), seeded }
}

function body(
  seeded: SeededRulebook,
  credential: string,
  schemaDocuments: readonly { uri: string; content: string }[] = [
    { uri: seeded.schemaUri, content: seeded.schemaContent },
  ],
): string {
  return JSON.stringify({
    rulebookId: seeded.rulebookId,
    rulebookVersion: seeded.version,
    attestationType: seeded.attestationName,
    credential,
    schemaDocuments,
  })
}

async function post(app: ReturnType<typeof createApp>, bodyText: string) {
  return app.request('/api/v1/credentials/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyText,
  })
}

async function resultBody(response: Response): Promise<CredentialValidationResult> {
  const payload = (await response.json()) as { readonly data: CredentialValidationResult }
  return payload.data
}

describe('POST /api/v1/credentials/validate', () => {
  test('returns typed evidence for a valid credential', async () => {
    const { app, seeded } = setup()
    const credential = await issueTestCredential()
    const response = await post(app, body(seeded, credential))

    expect(response.status).toBe(200)
    const result = await resultBody(response)
    expect(result.rulebook.id).toBe(seeded.rulebookId)
    expect(result.rulebook.version).toBe('1.0')
    expect(result.rulebook.digest).toBe(seeded.digest)
    expect(result.overallStatus).toBe('NOT_TESTED')
    expect(result.dimensions).toHaveLength(8)
    expect(result.violations.map((entry) => entry.code)).toContain('signature_not_verified')
    for (const entry of result.dimensions) {
      expect(typeof entry.applicable).toBe('boolean')
      expect(typeof entry.executed).toBe('boolean')
      expect(entry.evidence.reason.length).toBeGreaterThan(0)
    }
    const limitationCodes = result.limitations.map((entry) => entry.code)
    expect(limitationCodes).toContain('signature_not_verified')
    expect(limitationCodes).toContain('key_binding_proof_not_verified')
    expect(limitationCodes).toContain('status_list_not_checked')
    expect(limitationCodes).toContain('trust_not_evaluated')
    expect(limitationCodes).toContain('protocol_not_applicable')
    expect(limitationCodes).toContain('interoperability_not_applicable')
  })

  test('does not report overall success for a schema-valid credential with an invalid signature', async () => {
    const { app, seeded } = setup()
    const credential = await issueTestCredential()
    const segments = credential.split('~')
    const jwt = (segments[0] ?? '').split('.')
    const header = jwt[0]
    const payload = jwt[1]
    if (header === undefined || payload === undefined) {
      throw new Error('fixture is not a compact JWT')
    }
    const tampered = [
      [header, payload, 'aW52YWxpZC1zaWduYXR1cmU'].join('.'),
      ...segments.slice(1),
    ].join('~')

    const response = await post(app, body(seeded, tampered))
    expect(response.status).toBe(200)
    const result = await resultBody(response)
    expect(result.overallStatus).not.toBe('PASS')
    const crypto = result.dimensions.find((entry) => entry.id === 'cryptographic_verification')
    expect(crypto?.status).toBe('NOT_TESTED')
    expect(crypto?.executed).toBe(false)
    expect(result.limitations.map((entry) => entry.code)).toContain('signature_not_verified')
  })

  test('keeps /health responsive while a schema runs in the sandbox', async () => {
    const slowEntry = fileURLToPath(
      new URL('./validation/test-fixtures/slow-entry.ts', import.meta.url),
    )
    const { app, seeded } = setup({}, { entry: slowEntry, timeoutMs: 1_000 })
    const credential = await issueTestCredential()

    const started = Date.now()
    const validation = post(app, body(seeded, credential))
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Prove the HTTP process answers /health before the sandboxed validation
    // finishes. The spinning entry guarantees the child is still running.
    const healthStarted = Date.now()
    const healthPromise = Promise.resolve(app.request('/health'))
    const winner = await Promise.race([
      healthPromise.then(() => 'health' as const),
      validation.then(() => 'validation' as const),
    ])
    expect(winner).toBe('health')
    const health = await healthPromise
    expect(health.status).toBe(200)
    expect(Date.now() - healthStarted).toBeLessThan(200)

    const response = await validation
    expect(response.status).toBe(200)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    const result = await resultBody(response)
    expect(result.violations.map((entry) => entry.code)).toContain('schema_evaluation_timeout')
    const schemaDimension = result.dimensions.find((entry) => entry.id === 'schema_validation')
    expect(schemaDimension?.status).toBe('NOT_TESTED')
  })

  test('does not echo the credential or claim values', async () => {
    const { app, seeded } = setup()
    const credential = await issueTestCredential()
    const response = await post(app, body(seeded, credential))
    const text = await response.text()

    expect(text).not.toContain(credential)
    expect(text).not.toContain('Ada')
    expect(text).not.toContain('Lovelace')
    expect(text).not.toContain('1815-12-10')
  })

  test('rejects a body that is not JSON', async () => {
    const { app } = setup()
    const response = await app.request('/api/v1/credentials/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })

    expect(response.status).toBe(400)
    expect((await response.json()) as ErrorEnvelope).toEqual({
      error: { code: 'invalid_request', message: 'The request body must be a JSON object.' },
    })
  })

  test('rejects a request missing required fields', async () => {
    const { app } = setup()
    const response = await post(app, JSON.stringify({ rulebookId: 'only-one-field' }))

    expect(response.status).toBe(400)
    const payload = (await response.json()) as ErrorEnvelope
    expect(payload.error.code).toBe('invalid_request')
    expect(payload.error.message).toContain('rulebookVersion')
  })

  test('returns 404 for an unknown rulebook', async () => {
    const { app, seeded } = setup()
    const credential = await issueTestCredential()
    const payload = JSON.parse(body(seeded, credential)) as Record<string, unknown>
    payload.rulebookId = 'missing-rulebook'

    const response = await post(app, JSON.stringify(payload))
    expect(response.status).toBe(404)
    expect(((await response.json()) as ErrorEnvelope).error.code).toBe('not_found')
  })

  test('answers 503 when validation is not configured', async () => {
    const app = createApp()
    const response = await post(app, '{}')

    expect(response.status).toBe(503)
    expect(((await response.json()) as ErrorEnvelope).error.code).toBe('validation_unavailable')
  })

  test('rejects a body larger than the limit', async () => {
    const { app, seeded } = setup()
    const credential = await issueTestCredential()
    const payload = JSON.parse(body(seeded, credential)) as Record<string, unknown>
    payload.padding = 'x'.repeat(MAX_VALIDATION_BODY_BYTES + 1)

    const response = await post(app, JSON.stringify(payload))
    expect(response.status).toBe(413)
    expect(((await response.json()) as ErrorEnvelope).error.code).toBe('payload_too_large')
  })

  test('does not log credential material when validation fails', async () => {
    const { app, seeded } = setup()
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const consoleLog = spyOn(console, 'log').mockImplementation(() => {})

    try {
      const credential = await issueTestCredential()
      const response = await post(app, body(seeded, credential, []))
      const text = await response.text()

      expect(response.status).toBe(200)
      expect((JSON.parse(text) as { readonly data: CredentialValidationResult }).data).toBeDefined()
      expect(text).not.toContain(credential)
      expect(text).not.toContain('Ada')
      for (const call of consoleError.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('Ada')
      }
      for (const call of consoleLog.mock.calls) {
        expect(JSON.stringify(call)).not.toContain('Ada')
      }
    } finally {
      consoleError.mockRestore()
      consoleLog.mockRestore()
    }
  })

  test('reports an unparseable credential as a validation failure, not an HTTP error', async () => {
    const { app, seeded } = setup()
    const response = await post(app, body(seeded, 'not-a-credential', []))

    expect(response.status).toBe(200)
    const result = await resultBody(response)
    expect(result.overallStatus).toBe('FAIL')
    expect(result.violations.map((entry) => entry.code)).toContain('unrecognized_credential_format')
  })
})
