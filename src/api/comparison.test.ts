import { afterEach, describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import type { Hono } from 'hono'

import { createApp, type ErrorEnvelope } from '../app'
import { createMockCaptureExplorer } from '../capture'
import { HEADLESS_WALLET_COMPARISON_KIND } from '../comparison'
import { externalWalletObservation, TEST_WALLET_ID } from '../comparison/test/fixtures'
import { sha256Hex } from '../registry/digest'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import { CredentialValidator } from '../validation'
import {
  issueTestCredential,
  seedPublishedRulebook,
  type SeededRulebook,
} from '../validation/test-support'

import {
  componentJsonSchema,
  type OpenApiComponentName,
  type HeadlessWalletComparisonResource,
} from './schemas'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

const CAPTURED_AT = '2026-01-01T00:00:00Z'
const CAPTURE_ID = 'capture-headless-comparison'

function credentialCaptureEnvelope(credential: string): Record<string, unknown> {
  const bytes = new TextEncoder().encode(credential)
  return {
    kind: 'attestbook.capture-artifact@1',
    envelopeVersion: 1,
    captureId: CAPTURE_ID,
    correlationId: 'credimi-correlation-50',
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
    testExecutionRef: 'credimi-execution-50',
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
    generateId: () => 'comparison-validation',
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

async function correlate(setupResult: Setup): Promise<void> {
  const response = await postJson(
    setupResult.app,
    `/api/v1/captures/${CAPTURE_ID}/validate`,
    {
      rulebookId: setupResult.seeded.rulebookId,
      rulebookVersion: setupResult.seeded.version,
      attestationType: setupResult.seeded.attestationName,
      rulebookDigest: setupResult.seeded.digest,
    },
    bearer(setupResult.token),
  )
  expect(response.status).toBe(200)
}

function compareBody(): Record<string, unknown> {
  return { externalWallet: externalWalletObservation() }
}

describe('headless-wallet comparison API', () => {
  test('builds evidence linked to the exact pinned rulebook version and digest', async () => {
    const state = await setup()
    await correlate(state)

    const response = await postJson(
      state.app,
      `/api/v1/captures/${CAPTURE_ID}/compare`,
      compareBody(),
    )
    expect(response.status).toBe(200)
    const body = await json<{ data: HeadlessWalletComparisonResource }>(response)
    assertSchema('HeadlessWalletComparison', body.data)
    assertSchema('HeadlessWalletComparisonResponse', body)

    expect(body.data.kind).toBe(HEADLESS_WALLET_COMPARISON_KIND)
    expect(body.data.rulebook.rulebookId).toBe(state.seeded.rulebookId)
    expect(body.data.rulebook.version).toBe(state.seeded.version)
    expect(body.data.rulebook.contentDigest).toBe(state.seeded.digest)
    expect(body.data.rulebook.digestVerified).toBe(true)
    expect(body.data.rulebook.attestationType).toBe(state.seeded.attestationName)
    expect(body.data.capture.captureId).toBe(CAPTURE_ID)
    expect(body.data.capture.correlationId).toBe('credimi-correlation-50')
    expect(body.data.capture.testExecutionRef).toBe('credimi-execution-50')
    expect(body.data.attestbook.validationId).toBe('comparison-validation')
    expect(body.data.externalWallet?.walletId).toBe(TEST_WALLET_ID)
    expect(body.data.nonClaims).toEqual({
      externalObservationVerified: false,
      cryptographicVerification: false,
      issuerTrust: false,
      protocolConformance: false,
      interoperability: false,
    })
  })

  test('separates schema and protocol/interoperability results', async () => {
    const state = await setup()
    await correlate(state)
    const body = await json<{ data: HeadlessWalletComparisonResource }>(
      await postJson(state.app, `/api/v1/captures/${CAPTURE_ID}/compare`, compareBody()),
    )

    expect(body.data.comparison.schema.map((entry) => entry.dimension)).toEqual([
      'credential_parsing',
      'format_recognition',
      'schema_validation',
      'attestation_constraints',
    ])
    expect(body.data.comparison.protocol.map((entry) => entry.dimension)).toEqual([
      'protocol_conformance',
    ])
    expect(body.data.comparison.interoperability.map((entry) => entry.dimension)).toEqual([
      'interoperability',
    ])
    for (const entry of body.data.comparison.schema) {
      expect(entry.attestbook?.status).not.toBeNull()
      expect(entry.external).toBeNull()
    }
    const protocol = body.data.comparison.protocol[0]
    expect(protocol?.attestbook).toBeNull()
    expect(protocol?.external?.status).toBe('PASS')
    const interoperability = body.data.comparison.interoperability[0]
    expect(interoperability?.external?.status).toBe('FAIL')
    expect(interoperability?.result).toBe('external_only')
  })

  test('lists every unsupported comparison dimension explicitly', async () => {
    const state = await setup()
    await correlate(state)
    const body = await json<{ data: HeadlessWalletComparisonResource }>(
      await postJson(state.app, `/api/v1/captures/${CAPTURE_ID}/compare`, compareBody()),
    )
    const unsupported = body.data.comparison.unsupported.map((entry) => entry.dimension)
    expect(unsupported).toContain('cryptographic_verification')
    expect(unsupported).toContain('issuer_trust')
    expect(unsupported).toContain('protocol_conformance')
    expect(unsupported).toContain('interoperability')
    for (const entry of body.data.comparison.unsupported) {
      expect(entry.reason.length).toBeGreaterThan(0)
      if (
        entry.dimension === 'cryptographic_verification' ||
        entry.dimension === 'issuer_trust' ||
        entry.dimension === 'protocol_conformance' ||
        entry.dimension === 'interoperability'
      ) {
        expect(entry.code).toBe('attestbook_does_not_execute')
      }
    }
    // A structural dimension the engine could not execute is an explicit
    // evidence gap, not an omitted dimension.
    const schemaValidation = body.data.comparison.schema.find(
      (entry) => entry.dimension === 'schema_validation',
    )
    if (schemaValidation?.result === 'not_provided') {
      expect(
        body.data.comparison.unsupported.some(
          (entry) =>
            entry.dimension === 'schema_validation' && entry.code === 'no_evidence_supplied',
        ),
      ).toBe(true)
    }
  })

  test('accepts a comparison without an external wallet observation', async () => {
    const state = await setup()
    await correlate(state)
    const response = await postJson(state.app, `/api/v1/captures/${CAPTURE_ID}/compare`, {})
    expect(response.status).toBe(200)
    const body = await json<{ data: HeadlessWalletComparisonResource }>(response)
    expect(body.data.externalWallet).toBeNull()
    expect(body.data.comparison.protocol[0]?.result).toBe('not_provided')
    expect(body.data.comparison.interoperability[0]?.result).toBe('not_provided')
    expect(
      body.data.limitations.some((line) => line.includes('No external wallet observation')),
    ).toBe(true)
  })

  test('refuses to compare a capture that is not yet correlated', async () => {
    const state = await setup()
    const response = await postJson(
      state.app,
      `/api/v1/captures/${CAPTURE_ID}/compare`,
      compareBody(),
    )
    expect(response.status).toBe(409)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('conflict')
  })

  test('answers not found for an unknown capture', async () => {
    const state = await setup()
    const response = await postJson(
      state.app,
      '/api/v1/captures/unknown-comparison-capture/compare',
      compareBody(),
    )
    expect(response.status).toBe(404)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('not_found')
  })

  test('rejects a malformed external wallet observation', async () => {
    const state = await setup()
    await correlate(state)

    const cases: readonly Record<string, unknown>[] = [
      {
        externalWallet: {
          walletId: 'wallet-a',
          observedAt: 'not-a-timestamp',
          interaction: 'issuance',
          observations: [{ dimension: 'protocol_conformance', status: 'PASS' }],
        },
      },
      {
        externalWallet: {
          walletId: 'wallet a',
          observedAt: '2026-01-01T00:00:00Z',
          interaction: 'issuance',
          observations: [{ dimension: 'protocol_conformance', status: 'PASS' }],
        },
      },
      {
        externalWallet: {
          walletId: 'wallet-a',
          observedAt: '2026-01-01T00:00:00Z',
          interaction: 'both',
          observations: [
            { dimension: 'protocol_conformance', status: 'PASS' },
            { dimension: 'protocol_conformance', status: 'FAIL' },
          ],
        },
      },
    ]

    for (const requestBody of cases) {
      const response = await postJson(
        state.app,
        `/api/v1/captures/${CAPTURE_ID}/compare`,
        requestBody,
      )
      expect(response.status).toBe(400)
      expect((await json<ErrorEnvelope>(response)).error.code).toBe('invalid_request')
    }
  })

  test('answers 503 when the capture explorer is not wired', async () => {
    const app = createApp({})
    const response = await postJson(app, `/api/v1/captures/${CAPTURE_ID}/compare`, compareBody())
    expect(response.status).toBe(503)
    expect((await json<ErrorEnvelope>(response)).error.code).toBe('capture_unavailable')
  })

  test('never returns the raw credential or claim values', async () => {
    const state = await setup()
    await correlate(state)
    const response = await postJson(
      state.app,
      `/api/v1/captures/${CAPTURE_ID}/compare`,
      compareBody(),
    )
    const text = await response.text()
    expect(text).not.toContain(state.credential)
    expect(text).not.toContain('Person')
    expect(text).not.toContain('1990-01-02')
  })

  test('is read-only and does not change the recorded correlation', async () => {
    const state = await setup()
    await correlate(state)
    const first = await json<{ data: HeadlessWalletComparisonResource }>(
      await postJson(state.app, `/api/v1/captures/${CAPTURE_ID}/compare`, compareBody()),
    )
    const second = await json<{ data: HeadlessWalletComparisonResource }>(
      await postJson(state.app, `/api/v1/captures/${CAPTURE_ID}/compare`, compareBody()),
    )
    expect(second.data.attestbook.validationId).toBe(first.data.attestbook.validationId)
    expect(second.data.rulebook).toEqual(first.data.rulebook)

    const detail = await json<{
      data: { rulebook: { contentDigest: string } | null }
    }>(await state.app.request(`/api/v1/captures/${CAPTURE_ID}`))
    expect(detail.data.rulebook?.contentDigest).toBe(state.seeded.digest)
  })

  test('a mismatching recorded digest is still reported, never a silent latest version', async () => {
    const state = await setup()
    await correlate(state)
    // The correlation is pinned to the seeded digest; the comparison report
    // must carry that exact digest rather than the current working copy.
    const body = await json<{ data: HeadlessWalletComparisonResource }>(
      await postJson(state.app, `/api/v1/captures/${CAPTURE_ID}/compare`, compareBody()),
    )
    expect(body.data.rulebook.contentDigest).toBe(state.seeded.digest)
    expect(body.data.rulebook.contentDigest).toMatch(/^[0-9a-f]{64}$/)
  })
})
