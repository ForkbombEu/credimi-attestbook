// Real-server tests for the standalone Credimi integration adapter (issue #49).
//
// The adapter talks HTTP to the actual Hono application over a loopback Bun
// server backed by a real migrated SQLite registry, the real validation engine
// and the mock capture explorer. This is the end-to-end check that rulebook
// selection, version pinning, validation and evidence correlation work through
// the public `/api/v1` API only, and that timeouts and transport failures are
// handled on a real socket.

import { afterEach, describe, expect, test } from 'bun:test'

import { createApp } from '../../app'
import { externalWalletObservationSchema } from '../../api/schemas'
import { createMockCaptureExplorer } from '../../capture'
import { externalWalletObservation, TEST_WALLET_ID } from '../../comparison/test/fixtures'
import { sha256Hex } from '../../registry/digest'
import { createRegistryFixture, type RegistryFixture } from '../../registry/test-support'
import { CredentialValidator } from '../../validation'
import {
  issueTestCredential,
  seedPublishedRulebook,
  TEST_VCT,
  type SeededRulebook,
} from '../../validation/test-support'
import {
  CredimiAdapter,
  CredimiAdapterError,
  RULEBOOK_PIN_KIND,
  type CredimiRulebookPin,
} from './index'

const CAPTURE_ID = 'capture-credimi-adapter'
const TEST_EXECUTION_REF = 'credimi-execution-49'

let fixture: RegistryFixture | undefined
const servers: ReturnType<typeof Bun.serve>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
  fixture?.cleanup()
  fixture = undefined
})

function credentialCaptureEnvelope(credential: string): Record<string, unknown> {
  const bytes = new TextEncoder().encode(credential)
  return {
    kind: 'attestbook.capture-artifact@1',
    envelopeVersion: 1,
    captureId: CAPTURE_ID,
    correlationId: 'credimi-correlation-49',
    sourceComponent: 'capture-issuer',
    sourceVersion: '0.0.0-mock',
    capturedAt: '2026-01-01T00:00:00Z',
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
    testExecutionRef: TEST_EXECUTION_REF,
    metadata: { environment: 'mock', synthetic: true },
  }
}

interface Setup {
  readonly client: CredimiAdapter
  readonly seeded: SeededRulebook
  readonly credential: string
  readonly baseUrl: string
}

async function setup(options: { readonly token?: boolean } = {}): Promise<Setup> {
  fixture = createRegistryFixture()
  const seeded = seedPublishedRulebook(fixture.database, fixture.registry)
  const credential = await issueTestCredential()
  const validation = new CredentialValidator({
    source: fixture.registry,
    now: () => '2026-01-01T00:00:00.000Z',
    generateId: () => 'credimi-adapter-validation',
  })
  const captures = createMockCaptureExplorer({
    validation,
    additionalIssuerEnvelopes: [credentialCaptureEnvelope(credential)],
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  })
  const app = createApp({ registry: fixture.registry, validation, captures })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => app.fetch(request),
  })
  servers.push(server)
  const baseUrl = `http://127.0.0.1:${server.port}`
  return {
    baseUrl,
    seeded,
    credential,
    client: new CredimiAdapter({
      baseUrl,
      timeoutMs: 5_000,
      retryDelayMs: 0,
      ...(options.token === true ? { token: seeded.token } : {}),
    }),
  }
}

async function rejection(promise: Promise<unknown>): Promise<CredimiAdapterError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CredimiAdapterError) {
      return error
    }
    throw error
  }
  throw new Error('expected the adapter to reject')
}

describe('rulebook selection and version pinning through the public API', () => {
  test('lists, reads and pins the published rulebook version', async () => {
    const { client, seeded } = await setup()

    const page = await client.listRulebooks({ status: 'published' })
    expect(page.data.map((rulebook) => rulebook.id)).toContain(seeded.rulebookId)

    const rulebook = await client.getRulebook(seeded.rulebookId)
    expect(rulebook.publicationStatus).toBe('published')

    const attestations = await client.listRulebookAttestations(seeded.rulebookId)
    expect(attestations.map((attestation) => attestation.name)).toContain(seeded.attestationName)

    const versions = await client.listRulebookVersions(seeded.rulebookId)
    expect(versions.map((version) => version.version)).toContain(seeded.version)

    const pin = await client.pinRulebook({
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      attestationType: seeded.attestationName,
    })

    expect(pin).toEqual({
      kind: RULEBOOK_PIN_KIND,
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      contentDigest: seeded.digest,
      specVersion: 'ts11@1.0.1',
      attestationType: seeded.attestationName,
    })
  })
})

describe('version-pinned validation evidence', () => {
  test('returns the pinned version, digest and explicit limitations', async () => {
    const { client, seeded, credential } = await setup()
    const pin = await client.pinRulebook({
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      attestationType: seeded.attestationName,
    })

    const evidence = await client.validateCredential({ pin, credential })

    expect(evidence.rulebook).toMatchObject({
      id: seeded.rulebookId,
      version: seeded.version,
      digest: pin.contentDigest,
      digestVerified: true,
      specVersion: 'ts11@1.0.1',
    })
    expect(evidence.attestation.name).toBe(seeded.attestationName)
    expect(evidence.credential.vct).toBe(TEST_VCT)
    expect(evidence.dimensions).toHaveLength(8)
    // Structural checks only: cryptography and issuer trust cannot make this
    // result an overall PASS, and the limitation list says so explicitly.
    expect(evidence.overallStatus).not.toBe('PASS')
    expect(evidence.limitations.length).toBeGreaterThan(0)
  })

  test('rejects evidence for a stale pin instead of accepting different bytes', async () => {
    const { client, seeded, credential } = await setup()
    const pin = await client.pinRulebook({
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      attestationType: seeded.attestationName,
    })
    const stalePin: CredimiRulebookPin = { ...pin, contentDigest: '0'.repeat(64) }

    const error = await rejection(client.validateCredential({ pin: stalePin, credential }))

    expect(error.code).toBe('pin_mismatch')
  })

  test('surfaces an unknown attestation type as a typed not-found failure', async () => {
    const { client, seeded, credential } = await setup()
    const pin = await client.pinRulebook({
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      attestationType: 'Unknown Type',
    })

    const error = await rejection(client.validateCredential({ pin, credential }))

    expect(error).toMatchObject({ code: 'not_found', status: 404 })
  })
})

describe('capture evidence correlation', () => {
  test('binds the capture to the pinned version and returns the linked validation', async () => {
    const { client, seeded } = await setup({ token: true })
    const pin = await client.pinRulebook({
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      attestationType: seeded.attestationName,
    })

    const correlation = await client.correlateCapture({ captureId: CAPTURE_ID, pin })

    expect(correlation.captureId).toBe(CAPTURE_ID)
    expect(correlation.testExecutionRef).toBe(TEST_EXECUTION_REF)
    expect(correlation.rulebook).toMatchObject({
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      contentDigest: seeded.digest,
      digestVerified: true,
      attestationType: seeded.attestationName,
    })
    expect(correlation.validation.rulebook.digest).toBe(seeded.digest)

    const detail = await client.getCapture(CAPTURE_ID)
    expect(detail.rulebook?.contentDigest).toBe(seeded.digest)
    expect(detail.validationResult?.validationId).toBe(correlation.validation.validationId)
    expect(detail.evidenceComplete).toBe(true)

    const page = await client.listCaptures()
    expect(page.data.some((capture) => capture.captureId === CAPTURE_ID)).toBe(true)
  })

  test('refuses a stale pinned digest without replacing the recorded correlation', async () => {
    const { client, seeded } = await setup({ token: true })
    const pin = await client.pinRulebook({
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      attestationType: seeded.attestationName,
    })
    const first = await client.correlateCapture({ captureId: CAPTURE_ID, pin })
    const stalePin: CredimiRulebookPin = { ...pin, contentDigest: '0'.repeat(64) }

    const error = await rejection(client.correlateCapture({ captureId: CAPTURE_ID, pin: stalePin }))

    expect(error).toMatchObject({ code: 'conflict', status: 409 })
    const detail = await client.getCapture(CAPTURE_ID)
    expect(detail.rulebook?.contentDigest).toBe(seeded.digest)
    expect(detail.validationResult?.validationId).toBe(first.validation.validationId)
  })

  test('reports a rejected bearer token from the server', async () => {
    const { client, seeded } = await setup()
    const pin = await client.pinRulebook({
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      attestationType: seeded.attestationName,
    })

    const error = await rejection(
      client.correlateCapture({ captureId: CAPTURE_ID, pin, token: 'att_invalid' }),
    )

    expect(error).toMatchObject({ code: 'unauthorized', status: 401 })
  })
})

describe('headless-wallet comparison evidence', () => {
  test('compares a correlated capture with an external wallet observation', async () => {
    const { client, seeded } = await setup({ token: true })
    const pin = await client.pinRulebook({
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      attestationType: seeded.attestationName,
    })
    await client.correlateCapture({ captureId: CAPTURE_ID, pin })

    const comparison = await client.compareCapture({
      captureId: CAPTURE_ID,
      pin,
      externalWallet: externalWalletObservationSchema.parse(externalWalletObservation()),
    })

    expect(comparison.rulebook).toMatchObject({
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      contentDigest: seeded.digest,
      digestVerified: true,
      attestationType: seeded.attestationName,
    })
    expect(comparison.capture.captureId).toBe(CAPTURE_ID)
    expect(comparison.externalWallet?.walletId).toBe(TEST_WALLET_ID)
    expect(comparison.comparison.schema.map((entry) => entry.dimension)).toEqual([
      'credential_parsing',
      'format_recognition',
      'schema_validation',
      'attestation_constraints',
    ])
    expect(comparison.comparison.protocol[0]?.external?.status).toBe('PASS')
    expect(comparison.comparison.interoperability[0]?.external?.status).toBe('FAIL')
    expect(
      comparison.comparison.unsupported.some(
        (entry) =>
          entry.dimension === 'protocol_conformance' &&
          entry.code === 'attestbook_does_not_execute',
      ),
    ).toBe(true)
  })

  test('refuses to compare without a recorded correlation', async () => {
    const { client, seeded } = await setup({ token: true })
    const pin = await client.pinRulebook({
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      attestationType: seeded.attestationName,
    })

    const error = await rejection(client.compareCapture({ captureId: CAPTURE_ID, pin }))

    expect(error).toMatchObject({ code: 'conflict', status: 409 })
  })
})

describe('real-socket failure and timeout handling', () => {
  test('aborts a request that exceeds the configured timeout', async () => {
    const slowServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async () => {
        await Bun.sleep(500)
        return Response.json({ data: [] })
      },
    })
    servers.push(slowServer)
    const client = new CredimiAdapter({
      baseUrl: `http://127.0.0.1:${slowServer.port}`,
      timeoutMs: 25,
      retries: 0,
    })

    const error = await rejection(client.listRulebooks())

    expect(error).toMatchObject({ code: 'timeout', retryable: true })
  })

  test('aborts a request while the response body is still streaming', async () => {
    const encoder = new TextEncoder()
    const streamServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              controller.enqueue(encoder.encode('{"data":'))
              await Bun.sleep(250)
              controller.enqueue(encoder.encode('[]}'))
              controller.close()
            } catch {
              // The client aborted; the test server has nothing else to do.
            }
          },
        })
        return new Response(stream, { headers: { 'content-type': 'application/json' } })
      },
    })
    servers.push(streamServer)
    const client = new CredimiAdapter({
      baseUrl: `http://127.0.0.1:${streamServer.port}`,
      timeoutMs: 25,
      retries: 0,
    })

    const error = await rejection(client.listRulebooks())

    expect(error).toMatchObject({ code: 'timeout', retryable: true })
  })

  test('reports an unreachable server as a network failure', async () => {
    const stoppedServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ ok: true }),
    })
    const baseUrl = `http://127.0.0.1:${stoppedServer.port}`
    await stoppedServer.stop(true)
    const client = new CredimiAdapter({ baseUrl, timeoutMs: 2_000, retries: 0 })

    const error = await rejection(client.listRulebooks())

    expect(error).toMatchObject({ code: 'network_error', retryable: true })
  })
})
