// HTTP contract tests for the reproducible conformance route (FR-022, #51).
//
// The route is exercised through the real Hono application, a real temporary
// SQLite registry and the real structural engine with a genuinely signed
// SD-JWT VC. The tests prove server-level determinism across repeated runs,
// stable failure classification, exact pin reporting and the typed 400/404/503
// failures, and that no raw credential or schema document is echoed back.

import { afterEach, describe, expect, test } from 'bun:test'

import { createApp, type ErrorEnvelope } from '../app'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import { CredentialValidator } from '../validation'
import type { SchemaSandboxLimits } from '../validation/schema-sandbox'
import {
  defaultCredentialClaims,
  issueTestCredential,
  seedPublishedRulebook,
  type SeededRulebook,
} from '../validation/test-support'

import { conformanceRunResponseSchema, type ConformanceResultResource } from './schemas'

const CONFORMANCE_PATH = '/api/v1/conformance/runs'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

interface Setup {
  readonly app: ReturnType<typeof createApp>
  readonly seeded: SeededRulebook
}

function setup(options: { readonly sandbox?: SchemaSandboxLimits } = {}): Setup {
  fixture = createRegistryFixture()
  const seeded = seedPublishedRulebook(fixture.database, fixture.registry)
  let clockTick = 0
  const validator = new CredentialValidator({
    source: fixture.registry,
    // Deliberately different on every run: the conformance reference must not
    // depend on the validation identifier or timestamp.
    now: () => `2026-01-01T00:00:0${clockTick++}.000Z`,
    generateId: () => `conformance-validation-${clockTick++}`,
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
  })
  return { app: createApp({ validation: validator }), seeded }
}

function requestBody(
  seeded: SeededRulebook,
  credential: string,
  schemaDocuments: readonly { readonly uri: string; readonly content: string }[] = [
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

async function post(app: ReturnType<typeof createApp>, bodyText: string): Promise<Response> {
  return app.request(CONFORMANCE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: bodyText,
  })
}

async function resultBody(response: Response): Promise<ConformanceResultResource> {
  const payload = await response.json()
  const parsed = conformanceRunResponseSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`the conformance response does not match the contract: ${parsed.error.message}`)
  }
  return parsed.data.data
}

describe('POST /api/v1/conformance/runs', () => {
  test('returns deterministic evidence that repeats exactly for the same pinned inputs', async () => {
    const { app, seeded } = setup()
    const credential = await issueTestCredential()
    const body = requestBody(seeded, credential)

    const firstResponse = await post(app, body)
    expect(firstResponse.status).toBe(200)
    const first = await resultBody(firstResponse)

    const secondResponse = await post(app, body)
    expect(secondResponse.status).toBe(200)
    const second = await resultBody(secondResponse)

    expect(second.resultReference).toBe(first.resultReference)
    expect(second.input.inputDigest).toBe(first.input.inputDigest)
    expect(second).toEqual(first)

    expect(first.kind).toBe('attestbook.conformance-result@1')
    expect(first.contractVersion).toBe(1)
    expect(first.resultReference).toMatch(/^[0-9a-f]{64}$/)
    expect(first.pin).toEqual({
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      contentDigest: seeded.digest,
      specVersion: 'ts11@1.0.1',
      attestationType: seeded.attestationName,
      digestVerified: true,
    })
    expect(first.input.schemaDocuments).toHaveLength(1)
    expect(first.input.schemaDocuments[0]?.uri).toBe(seeded.schemaUri)
    expect(first.input.schemaDocuments[0]?.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.outcome).toBe('evidence_incomplete')
    expect(first.deterministic).toBe(true)
    expect(first.environmentConditions).toEqual([])
    expect(first.failureClasses).toEqual([])
    expect(first.evidence.dimensions).toHaveLength(8)
    expect(first.evidence.overallStatus).toBe('NOT_TESTED')
    expect(first.nonClaims).toEqual({
      cryptographicVerification: false,
      issuerTrust: false,
      protocolConformance: false,
      interoperability: false,
      standardsConformance: false,
      recurringExecutionScheduled: false,
    })
    expect(first.limitations.length).toBeGreaterThan(0)

    const serialized = JSON.stringify(first)
    expect(serialized).not.toContain(credential)
    expect(serialized).not.toContain(seeded.schemaContent)
  })

  test('marks a run cut short by the environment as non-deterministic', async () => {
    // A non-Linux platform makes the schema sandbox unavailable without
    // spawning a child; the run still returns evidence, but not a deterministic
    // one.
    const { app, seeded } = setup({ sandbox: { platform: 'darwin' } })
    const credential = await issueTestCredential()

    const response = await post(app, requestBody(seeded, credential))
    expect(response.status).toBe(200)
    const result = await resultBody(response)

    expect(result.deterministic).toBe(false)
    expect(result.environmentConditions).toEqual(['schema_sandbox_unavailable'])
    expect(result.outcome).toBe('inconclusive')
    expect(result.limitations.join(' ')).toContain('deterministic false')
  })

  test('changes the stable reference when the credential or the schema evidence changes', async () => {
    const { app, seeded } = setup()
    const credential = await issueTestCredential()
    const baseline = await resultBody(await post(app, requestBody(seeded, credential)))

    const otherCredential = await issueTestCredential({
      claims: { ...defaultCredentialClaims(), given_name: 'Grace' },
    })
    const changedCredential = await resultBody(
      await post(app, requestBody(seeded, otherCredential)),
    )
    expect(changedCredential.input.credentialDigest).not.toBe(baseline.input.credentialDigest)
    expect(changedCredential.resultReference).not.toBe(baseline.resultReference)

    const withoutSchemaDocuments = await resultBody(
      await post(app, requestBody(seeded, credential, [])),
    )
    expect(withoutSchemaDocuments.input.inputDigest).not.toBe(baseline.input.inputDigest)
    expect(withoutSchemaDocuments.resultReference).not.toBe(baseline.resultReference)
  })

  test('classifies a failing structural run with stable failure classes', async () => {
    const { app, seeded } = setup()
    const claims = defaultCredentialClaims()
    delete claims.cnf
    const credential = await issueTestCredential({ claims })

    const result = await resultBody(await post(app, requestBody(seeded, credential)))

    expect(result.outcome).toBe('structural_fail')
    expect(result.evidence.overallStatus).toBe('FAIL')
    expect(result.failureClasses).toEqual([
      {
        code: 'attestation_constraint_violation',
        dimension: 'attestation_constraints',
        findingCodes: ['missing_key_binding'],
      },
    ])
  })

  test('reports an unknown pinned version as a typed not_found', async () => {
    const { app, seeded } = setup()
    const credential = await issueTestCredential()
    const body = JSON.stringify({
      rulebookId: seeded.rulebookId,
      rulebookVersion: '9.9',
      attestationType: seeded.attestationName,
      credential,
    })

    const response = await post(app, body)
    expect(response.status).toBe(404)
    expect(((await response.json()) as ErrorEnvelope).error.code).toBe('not_found')
  })

  test('rejects a malformed request body as invalid_request', async () => {
    const { app } = setup()

    const response = await post(app, '{}')
    expect(response.status).toBe(400)
    expect(((await response.json()) as ErrorEnvelope).error.code).toBe('invalid_request')
  })

  test('answers 503 when credential validation is not wired', async () => {
    const app = createApp()

    const response = await post(app, '{}')
    expect(response.status).toBe(503)
    expect(((await response.json()) as ErrorEnvelope).error.code).toBe('validation_unavailable')
  })
})
