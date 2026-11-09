import { afterEach, describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { Hono } from 'hono'

import { createApp, type ErrorEnvelope } from '../app'
import {
  captureAdapterError,
  CaptureExplorer,
  createMockCaptureExplorer,
  type CapturePullAdapter,
} from '../capture'
import { sha256Hex } from '../registry/digest'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import { CredentialValidator } from '../validation'
import {
  issueTestCredential,
  seedPublishedRulebook,
  type SeededRulebook,
} from '../validation/test-support'

import { componentJsonSchema, type OpenApiComponentName } from './schemas'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

const CAPTURED_AT = '2026-01-01T00:00:00Z'
const CAPTURE_ID = 'capture-real-credential'

function credentialCaptureEnvelope(credential: string): Record<string, unknown> {
  const bytes = new TextEncoder().encode(credential)
  return {
    kind: 'attestbook.capture-artifact@1',
    envelopeVersion: 1,
    captureId: CAPTURE_ID,
    correlationId: 'credimi-correlation-48',
    sourceComponent: 'capture-issuer',
    sourceVersion: '0.0.0-mock',
    capturedAt: CAPTURED_AT,
    interactionType: 'issuance',
    protocol: 'openid4vci',
    credentialFormat: 'dc+sd-jwt',
    artifactType: 'issued-credential',
    artifact: {
      mediaType: 'application/vc+sd-jwt',
      encoding: 'utf8',
      content: credential,
      byteLength: bytes.byteLength,
    },
    integrity: { algorithm: 'sha256', digest: sha256Hex(bytes) },
    party: { role: 'issuer', identifier: 'https://issuer.example.test', name: 'Example Issuer' },
    testExecutionRef: 'credimi-execution-48',
    metadata: { environment: 'mock', synthetic: true },
  }
}

interface Setup {
  readonly app: Hono
  readonly seeded: SeededRulebook
  readonly credential: string
  readonly token: string
}

async function setup(): Promise<Setup> {
  fixture = createRegistryFixture()
  const seeded = seedPublishedRulebook(fixture.database, fixture.registry)
  const credential = await issueTestCredential()
  const validation = new CredentialValidator({
    source: fixture.registry,
    now: () => '2026-01-01T00:00:00.000Z',
    generateId: () => 'capture-correlation-validation',
  })
  const captures = createMockCaptureExplorer({
    validation,
    additionalIssuerEnvelopes: [credentialCaptureEnvelope(credential)],
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  })
  return {
    app: createApp({ registry: fixture.registry, validation, captures }),
    seeded,
    credential,
    token: seeded.token,
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
const validators = new Map<string, ValidateFunction>()

function assertSchema(name: OpenApiComponentName, value: unknown): void {
  let validate = validators.get(name)
  if (validate === undefined) {
    validate = ajv.compile(componentJsonSchema(name))
    validators.set(name, validate)
  }
  expect(validate(value), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true)
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function postJson(
  app: Hono,
  path: string,
  body: unknown,
  authorization?: string,
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(body),
  })
}

function bearer(secret: string): string {
  return `Bearer ${secret}`
}

interface CaptureSummaryBody {
  readonly captureId: string
  readonly source: { readonly transport: string }
  readonly artifact: { readonly availability: string; readonly uri: string | null }
  readonly evidenceGaps: readonly { readonly code: string }[]
}

interface CapturePageBody {
  readonly data: readonly CaptureSummaryBody[]
  readonly pagination: { readonly limit: number; readonly offset: number; readonly total: number }
}

interface CaptureDetailBody extends CaptureSummaryBody {
  readonly correlationId: string
  readonly testExecutionRef: string | null
  readonly artifactProjection: {
    readonly redaction: { readonly status: string; readonly redactedPaths: readonly string[] }
    readonly document: unknown
  } | null
  readonly rulebook: { readonly contentDigest: string } | null
  readonly validationResult: {
    readonly overallStatus: string
    readonly validationId: string
  } | null
  readonly timeline: readonly { readonly kind: string }[]
}

describe('capture explorer read API', () => {
  test('lists the mock-backed captures with an explicit mock transport label', async () => {
    const { app } = await setup()
    const response = await app.request('/api/v1/captures')
    expect(response.status).toBe(200)
    const body = await json<CapturePageBody>(response)
    assertSchema('CaptureExplorerListResponse', body)
    expect(body.pagination.total).toBe(8)
    expect(body.data).toHaveLength(8)
    for (const capture of body.data) {
      expect(capture.source.transport).toBe('mock')
    }
    expect(body.data.some((capture) => capture.captureId === CAPTURE_ID)).toBe(true)
  })

  test('pages the capture list', async () => {
    const { app } = await setup()
    const response = await app.request('/api/v1/captures?limit=2&offset=1')
    expect(response.status).toBe(200)
    const body = await json<CapturePageBody>(response)
    expect(body.pagination).toEqual({ limit: 2, offset: 1, total: 8 })
    expect(body.data).toHaveLength(2)
  })

  test('rejects an invalid page bound', async () => {
    const { app } = await setup()
    const response = await app.request('/api/v1/captures?limit=0')
    expect(response.status).toBe(400)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('invalid_request')
  })

  test('returns one capture with a redacted projection and explicit gaps', async () => {
    const { app, credential } = await setup()
    const response = await app.request(`/api/v1/captures/${CAPTURE_ID}`)
    expect(response.status).toBe(200)
    const body = await json<{ data: CaptureDetailBody }>(response)
    assertSchema('CaptureExplorerDetailResponse', body)
    expect(body.data.correlationId).toBe('credimi-correlation-48')
    expect(body.data.testExecutionRef).toBe('credimi-execution-48')
    expect(body.data.artifact.availability).toBe('inline')
    expect(body.data.artifactProjection?.redaction.status).toBe('full')
    expect(body.data.artifactProjection?.document).toBeNull()
    expect(body.data.evidenceGaps.map((gap) => gap.code)).toContain('no_rulebook_binding')
    expect(body.data.rulebook).toBeNull()
    expect(JSON.stringify(body)).not.toContain(credential)
  })

  test('reports an external artifact reference as unavailable evidence', async () => {
    const { app } = await setup()
    const response = await app.request('/api/v1/captures/mock-capture-capture-issuer-1')
    expect(response.status).toBe(200)
    const body = await json<{ data: CaptureDetailBody }>(response)
    expect(body.data.artifact.availability).toBe('external')
    expect(body.data.artifactProjection).toBeNull()
    expect(body.data.evidenceGaps.map((gap) => gap.code)).toContain('external_artifact_not_fetched')
  })

  test('answers not found for an unknown capture', async () => {
    const { app } = await setup()
    const response = await app.request('/api/v1/captures/missing')
    expect(response.status).toBe(404)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('not_found')
  })

  test('answers 503 when the capture explorer is not wired', async () => {
    const app = createApp({})
    const response = await app.request('/api/v1/captures')
    expect(response.status).toBe(503)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('capture_unavailable')
  })

  test('maps a capture source failure to a safe 502', async () => {
    const source: CapturePullAdapter = {
      source: {
        sourceId: 'faulty-source',
        component: 'capture-issuer',
        transport: 'mock',
        description: 'A source that simulates a transport fault',
      },
      pull() {
        return Promise.reject(
          captureAdapterError('source_unavailable', 'the capture source is unavailable'),
        )
      },
    }
    const validation = {
      validate() {
        return Promise.reject(new Error('validation must not run'))
      },
    }
    const app = createApp({
      captures: new CaptureExplorer({ sources: [source], validation }),
    })
    const response = await app.request('/api/v1/captures')
    expect(response.status).toBe(502)
    const body = await json<ErrorEnvelope>(response)
    expect(body.error.code).toBe('capture_fetch_failed')
    expect(body.error.message).toBe('the capture source is unavailable')
  })
})

describe('capture correlation API', () => {
  test('binds a captured credential to the pinned rulebook version and links the findings', async () => {
    const { app, seeded, token } = await setup()
    const response = await postJson(
      app,
      `/api/v1/captures/${CAPTURE_ID}/validate`,
      {
        rulebookId: seeded.rulebookId,
        rulebookVersion: seeded.version,
        attestationType: seeded.attestationName,
        rulebookDigest: seeded.digest,
      },
      bearer(token),
    )
    expect(response.status).toBe(200)
    const body = await json<{
      data: {
        captureId: string
        correlationId: string
        testExecutionRef: string | null
        rulebook: { rulebookId: string; contentDigest: string; attestationType: string }
        validation: { overallStatus: string; validationId: string }
      }
    }>(response)
    assertSchema('CaptureCorrelationResponse', body)
    expect(body.data.captureId).toBe(CAPTURE_ID)
    expect(body.data.correlationId).toBe('credimi-correlation-48')
    expect(body.data.testExecutionRef).toBe('credimi-execution-48')
    expect(body.data.rulebook.rulebookId).toBe(seeded.rulebookId)
    expect(body.data.rulebook.contentDigest).toBe(seeded.digest)
    expect(body.data.rulebook.attestationType).toBe(seeded.attestationName)
    expect(body.data.validation.validationId).toBe('capture-correlation-validation')
    expect(['FAIL', 'INCONCLUSIVE', 'NOT_TESTED', 'PASS']).toContain(
      body.data.validation.overallStatus,
    )

    const detail = await json<{ data: CaptureDetailBody }>(
      await app.request(`/api/v1/captures/${CAPTURE_ID}`),
    )
    expect(detail.data.rulebook?.contentDigest).toBe(seeded.digest)
    expect(detail.data.validationResult?.overallStatus).toBe(body.data.validation.overallStatus)
    expect(detail.data.evidenceGaps.map((gap) => gap.code)).not.toContain('no_rulebook_binding')
    expect(detail.data.evidenceGaps.map((gap) => gap.code)).not.toContain('validation_not_run')
    expect(detail.data.timeline.map((event) => event.kind)).toContain('bound')
    expect(detail.data.timeline.map((event) => event.kind)).toContain('validated')
  })

  test('refuses a stale pinned digest before recording a correlation', async () => {
    const { app, seeded, token } = await setup()
    const response = await postJson(
      app,
      `/api/v1/captures/${CAPTURE_ID}/validate`,
      {
        rulebookId: seeded.rulebookId,
        rulebookVersion: seeded.version,
        attestationType: seeded.attestationName,
        rulebookDigest: '0'.repeat(64),
      },
      bearer(token),
    )
    expect(response.status).toBe(409)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('conflict')

    const detail = await json<{ data: CaptureDetailBody }>(
      await app.request(`/api/v1/captures/${CAPTURE_ID}`),
    )
    expect(detail.data.rulebook).toBeNull()
    expect(detail.data.evidenceGaps.map((gap) => gap.code)).toContain('no_rulebook_binding')
  })

  test('keeps an earlier correlation when a later correlation pins a stale digest', async () => {
    const { app, seeded, token } = await setup()
    const first = await postJson(
      app,
      `/api/v1/captures/${CAPTURE_ID}/validate`,
      {
        rulebookId: seeded.rulebookId,
        rulebookVersion: seeded.version,
        attestationType: seeded.attestationName,
        rulebookDigest: seeded.digest,
      },
      bearer(token),
    )
    expect(first.status).toBe(200)
    const firstBody = await json<{ data: { validation: { validationId: string } } }>(first)

    const stale = await postJson(
      app,
      `/api/v1/captures/${CAPTURE_ID}/validate`,
      {
        rulebookId: seeded.rulebookId,
        rulebookVersion: seeded.version,
        attestationType: seeded.attestationName,
        rulebookDigest: '0'.repeat(64),
      },
      bearer(token),
    )
    expect(stale.status).toBe(409)

    const detail = await json<{ data: CaptureDetailBody }>(
      await app.request(`/api/v1/captures/${CAPTURE_ID}`),
    )
    expect(detail.data.rulebook?.contentDigest).toBe(seeded.digest)
    expect(detail.data.validationResult?.validationId).toBe(firstBody.data.validation.validationId)
  })

  test('rejects a malformed pinned digest', async () => {
    const { app, seeded, token } = await setup()
    const response = await postJson(
      app,
      `/api/v1/captures/${CAPTURE_ID}/validate`,
      {
        rulebookId: seeded.rulebookId,
        rulebookVersion: seeded.version,
        attestationType: seeded.attestationName,
        rulebookDigest: 'ABC',
      },
      bearer(token),
    )
    expect(response.status).toBe(400)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('invalid_request')
  })

  test('refuses to validate an external artifact reference', async () => {
    const { app, seeded, token } = await setup()
    const response = await postJson(
      app,
      '/api/v1/captures/mock-capture-capture-issuer-1/validate',
      {
        rulebookId: seeded.rulebookId,
        rulebookVersion: seeded.version,
        attestationType: seeded.attestationName,
      },
      bearer(token),
    )
    expect(response.status).toBe(409)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('conflict')
  })

  test('refuses to validate a non-credential artifact type', async () => {
    const { app, seeded, token } = await setup()
    const response = await postJson(
      app,
      '/api/v1/captures/mock-capture-capture-verifier-2/validate',
      {
        rulebookId: seeded.rulebookId,
        rulebookVersion: seeded.version,
        attestationType: seeded.attestationName,
      },
      bearer(token),
    )
    expect(response.status).toBe(409)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('conflict')
  })

  test('answers not found for an unknown capture and rulebook', async () => {
    const { app, seeded, token } = await setup()
    const unknownCapture = await postJson(
      app,
      '/api/v1/captures/missing/validate',
      {
        rulebookId: seeded.rulebookId,
        rulebookVersion: seeded.version,
        attestationType: seeded.attestationName,
      },
      bearer(token),
    )
    expect(unknownCapture.status).toBe(404)

    const unknownRulebook = await postJson(
      app,
      `/api/v1/captures/${CAPTURE_ID}/validate`,
      {
        rulebookId: 'missing-rulebook',
        rulebookVersion: seeded.version,
        attestationType: seeded.attestationName,
      },
      bearer(token),
    )
    expect(unknownRulebook.status).toBe(404)
  })

  test('rejects a malformed correlation request', async () => {
    const { app, seeded, token } = await setup()
    const response = await postJson(
      app,
      `/api/v1/captures/${CAPTURE_ID}/validate`,
      {
        rulebookId: seeded.rulebookId,
        rulebookVersion: 'nope',
        attestationType: seeded.attestationName,
      },
      bearer(token),
    )
    expect(response.status).toBe(400)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('invalid_request')
  })

  test('requires a bearer token before recording a correlation', async () => {
    const { app, seeded } = await setup()
    const response = await postJson(app, `/api/v1/captures/${CAPTURE_ID}/validate`, {
      rulebookId: seeded.rulebookId,
      rulebookVersion: seeded.version,
      attestationType: seeded.attestationName,
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Bearer')
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('unauthorized')

    const detail = await json<{ data: CaptureDetailBody }>(
      await app.request(`/api/v1/captures/${CAPTURE_ID}`),
    )
    expect(detail.data.rulebook).toBeNull()
    expect(detail.data.validationResult).toBeNull()
    expect(detail.data.evidenceGaps.map((gap) => gap.code)).toContain('no_rulebook_binding')
    expect(detail.data.evidenceGaps.map((gap) => gap.code)).toContain('validation_not_run')
  })

  test('rejects an unknown bearer token without changing the captured evidence', async () => {
    const { app, seeded } = await setup()
    const response = await postJson(
      app,
      `/api/v1/captures/${CAPTURE_ID}/validate`,
      {
        rulebookId: seeded.rulebookId,
        rulebookVersion: seeded.version,
        attestationType: seeded.attestationName,
      },
      bearer('att_unknown_token_value'),
    )
    expect(response.status).toBe(401)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('unauthorized')

    const detail = await json<{ data: CaptureDetailBody }>(
      await app.request(`/api/v1/captures/${CAPTURE_ID}`),
    )
    expect(detail.data.rulebook).toBeNull()
    expect(detail.data.validationResult).toBeNull()
  })

  test('a correlation does not mutate the pinned rulebook version', async () => {
    const { app, seeded, token } = await setup()
    await postJson(
      app,
      `/api/v1/captures/${CAPTURE_ID}/validate`,
      {
        rulebookId: seeded.rulebookId,
        rulebookVersion: seeded.version,
        attestationType: seeded.attestationName,
      },
      bearer(token),
    )
    const content = await app.request(
      `/api/v1/rulebooks/${seeded.rulebookId}/versions/${seeded.version}/content`,
    )
    expect(content.status).toBe(200)
    const bytes = new Uint8Array(await content.arrayBuffer())
    expect(sha256Hex(bytes)).toBe(seeded.digest)
  })
})
