// Transport-error tests for the mock capture adapters (FR-018, issue #47).
//
// A real transport can be unavailable, time out, return an uninterpretable
// response or exceed its size budget. The mock reproduces each condition
// deterministically so callers can be written against stable codes before any
// live capture endpoint is integrated. Cursor, page-size, media-type and
// no-network behaviour are checked here too.

import { describe, expect, test } from 'bun:test'

import { hashCaptureCredential } from './credentials'
import { CaptureAdapterError, isCaptureAdapterError, type CaptureAdapterErrorCode } from './errors'
import { mockCaptureEnvelopes } from './fixtures'
import { MockCaptureSource, type CaptureMockFault, type MockCaptureSourceOptions } from './mock'

const TOKEN = 'att_mock-capture-test-credential'
const ACCEPTED = hashCaptureCredential(TOKEN)
const NOW = () => new Date('2026-11-05T09:50:00.000Z')
const ISSUED_CREDENTIAL = mockCaptureEnvelopes('capture-issuer')[2]

type SourceOptions = Omit<
  MockCaptureSourceOptions,
  'component' | 'acceptedCredentialHashes' | 'pullCredential' | 'now'
>

function source(options: SourceOptions = {}): MockCaptureSource {
  return new MockCaptureSource({
    component: 'capture-issuer',
    acceptedCredentialHashes: [ACCEPTED],
    pullCredential: TOKEN,
    now: NOW,
    ...options,
  })
}

function envelopeBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

async function expectAdapterError(
  run: () => Promise<unknown>,
  code: CaptureAdapterErrorCode,
): Promise<CaptureAdapterError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(CaptureAdapterError)
    expect(isCaptureAdapterError(error) ? error.code : undefined).toBe(code)
    return error as CaptureAdapterError
  }
  throw new Error(`expected the capture adapter to fail with ${code}`)
}

const FAULT_CODES: ReadonlyArray<readonly [CaptureMockFault, CaptureAdapterErrorCode]> = [
  ['unavailable', 'source_unavailable'],
  ['timeout', 'source_timeout'],
  ['invalid-response', 'invalid_source_response'],
  ['oversized-response', 'response_too_large'],
]

describe('pull transport errors', () => {
  test('maps each simulated fault to a stable adapter code and then recovers', async () => {
    const adapter = source({ faults: FAULT_CODES.map(([fault]) => fault) })
    for (const [, code] of FAULT_CODES) {
      await expectAdapterError(() => adapter.pull(), code)
    }
    const recovered = await adapter.pull()
    expect(recovered.artifacts.length).toBeGreaterThan(0)
  })

  test('consumes a fault queued with simulateFault for one call only', async () => {
    const adapter = source()
    adapter.simulateFault('timeout')
    await expectAdapterError(() => adapter.pull(), 'source_timeout')
    const recovered = await adapter.pull()
    expect(recovered.artifacts.length).toBeGreaterThan(0)
  })

  test('rejects a cursor issued by a different source', async () => {
    const issuer = source({ maxBatchSize: 2 })
    const verifier = new MockCaptureSource({
      component: 'capture-verifier',
      acceptedCredentialHashes: [ACCEPTED],
      pullCredential: TOKEN,
      now: NOW,
    })
    const firstPage = await issuer.pull({ maxArtifacts: 2 })
    expect(firstPage.nextCursor).not.toBeNull()
    await expectAdapterError(
      () => verifier.pull({ cursor: firstPage.nextCursor }),
      'cursor_expired',
    )
  })

  test('rejects a cursor this source did not issue', async () => {
    const adapter = source()
    const beyondEnd = Buffer.from('mock-cursor:999', 'utf8').toString('base64url')
    for (const cursor of ['not-a-cursor', '', beyondEnd]) {
      await expectAdapterError(() => adapter.pull({ cursor }), 'cursor_expired')
    }
    // An empty page at the end of the source is valid and drains the cursor.
    const drained = await adapter.pull({ maxArtifacts: 20 })
    expect(drained.nextCursor).toBeNull()
  })

  test('rejects an invalid page size and caps a large one', async () => {
    const adapter = source({ maxBatchSize: 2 })
    for (const maxArtifacts of [0, -1, 1.5]) {
      await expectAdapterError(() => adapter.pull({ maxArtifacts }), 'invalid_request')
    }
    const capped = await adapter.pull({ maxArtifacts: 50 })
    expect(capped.artifacts).toHaveLength(2)
  })
})

describe('push transport errors', () => {
  test('surfaces a simulated source outage and recovers on the next push', async () => {
    const adapter = source({ faults: ['unavailable'] })
    if (ISSUED_CREDENTIAL === undefined) {
      throw new Error('expected the issued-credential fixture')
    }
    const submission = {
      authorization: TOKEN,
      mediaType: 'application/json',
      bytes: envelopeBytes(ISSUED_CREDENTIAL),
    }
    await expectAdapterError(() => adapter.push(submission), 'source_unavailable')
    const accepted = await adapter.push(submission)
    expect(accepted.duplicate).toBe(false)
  })

  test('rejects a non-JSON envelope media type', async () => {
    const adapter = source()
    if (ISSUED_CREDENTIAL === undefined) {
      throw new Error('expected the issued-credential fixture')
    }
    for (const mediaType of ['text/plain', 'application/octet-stream', '', 'json']) {
      await expectAdapterError(
        () =>
          adapter.push({
            authorization: TOKEN,
            mediaType,
            bytes: envelopeBytes(ISSUED_CREDENTIAL),
          }),
        'unsupported_media_type',
      )
    }
  })
})

describe('offline guarantee', () => {
  test('makes no network request for either contract', async () => {
    if (ISSUED_CREDENTIAL === undefined) {
      throw new Error('expected the issued-credential fixture')
    }
    const adapter = source()
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => {
      calls += 1
      throw new Error('the mock capture source must not use the network')
    }) as unknown as typeof globalThis.fetch
    try {
      await adapter.pull()
      await adapter.push({
        authorization: TOKEN,
        mediaType: 'application/json',
        bytes: envelopeBytes(ISSUED_CREDENTIAL),
      })
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(calls).toBe(0)
  })

  test('exposes only the mock transport kind', async () => {
    const { CAPTURE_ADAPTER_TRANSPORTS } = await import('./types')
    expect([...CAPTURE_ADAPTER_TRANSPORTS]).toEqual(['mock'])
  })
})
