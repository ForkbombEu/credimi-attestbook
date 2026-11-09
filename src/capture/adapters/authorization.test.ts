// Authorization-boundary tests for the capture adapters (FR-018, issue #47).
//
// A push presents a bearer credential to AttestBook; a pull uses the credential
// AttestBook holds for the source. Both fail closed, accept only configured
// SHA-256 hashes, compare in constant time and never echo the presented
// credential, so missing and unknown credentials are indistinguishable.

import { describe, expect, test } from 'bun:test'

import { isCaptureError } from '../errors'
import {
  hashCaptureCredential,
  isCaptureCredentialHash,
  MAX_CAPTURE_CREDENTIAL_LENGTH,
  verifyCaptureCredential,
  verifyCaptureCredentialHash,
} from './credentials'
import { CaptureAdapterError, isCaptureAdapterError, type CaptureAdapterErrorCode } from './errors'
import { mockCaptureEnvelopes } from './fixtures'
import { MockCaptureSource } from './mock'

const ISSUER_TOKEN = 'att_mock-issuer-credential'
const VERIFIER_TOKEN = 'att_mock-verifier-credential'
const ISSUER_HASH = hashCaptureCredential(ISSUER_TOKEN)
const VERIFIER_HASH = hashCaptureCredential(VERIFIER_TOKEN)
const NOW = () => new Date('2026-11-05T09:50:00.000Z')
const ISSUED_CREDENTIAL = mockCaptureEnvelopes('capture-issuer')[2]

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

function issuerSource(pullCredential: string | null = ISSUER_TOKEN): MockCaptureSource {
  return new MockCaptureSource({
    component: 'capture-issuer',
    acceptedCredentialHashes: [ISSUER_HASH],
    pullCredential,
    now: NOW,
  })
}

function pushSubmission(
  authorization: string | null,
  component: 'capture-issuer' | 'capture-verifier' = 'capture-issuer',
): {
  authorization: string | null
  mediaType: string
  bytes: Uint8Array
} {
  const envelope =
    component === 'capture-issuer' ? ISSUED_CREDENTIAL : mockCaptureEnvelopes(component)[2]
  if (envelope === undefined) {
    throw new Error('expected the synthetic fixture')
  }
  return {
    authorization,
    mediaType: 'application/json',
    bytes: envelopeBytes(envelope),
  }
}

describe('credential primitives', () => {
  test('accept hash-shaped values only', () => {
    expect(isCaptureCredentialHash(ISSUER_HASH)).toBe(true)
    expect(isCaptureCredentialHash(ISSUER_TOKEN)).toBe(false)
    expect(isCaptureCredentialHash(ISSUER_HASH.toUpperCase())).toBe(false)
    expect(isCaptureCredentialHash(undefined)).toBe(false)
  })

  test('fails closed and compares through hashes', () => {
    expect(verifyCaptureCredential(ISSUER_TOKEN, [ISSUER_HASH])).toBe(true)
    expect(verifyCaptureCredential('att_wrong', [ISSUER_HASH])).toBe(false)
    expect(verifyCaptureCredential(null, [ISSUER_HASH])).toBe(false)
    expect(verifyCaptureCredential('', [ISSUER_HASH])).toBe(false)
    expect(verifyCaptureCredential(ISSUER_TOKEN, [])).toBe(false)
    expect(verifyCaptureCredential(VERIFIER_TOKEN, [ISSUER_HASH])).toBe(false)
  })

  test('verifies an already-hashed credential and never a raw value', () => {
    expect(verifyCaptureCredentialHash(ISSUER_HASH, [ISSUER_HASH])).toBe(true)
    expect(verifyCaptureCredentialHash(VERIFIER_HASH, [ISSUER_HASH])).toBe(false)
    expect(verifyCaptureCredentialHash(ISSUER_TOKEN, [ISSUER_HASH])).toBe(false)
    expect(verifyCaptureCredentialHash(null, [ISSUER_HASH])).toBe(false)
    expect(verifyCaptureCredentialHash(ISSUER_HASH, [])).toBe(false)
  })

  test('bounds the presented credential length before hashing', () => {
    const atLimit = 'a'.repeat(MAX_CAPTURE_CREDENTIAL_LENGTH)
    const overLimit = 'a'.repeat(MAX_CAPTURE_CREDENTIAL_LENGTH + 1)
    expect(verifyCaptureCredential(atLimit, [hashCaptureCredential(atLimit)])).toBe(true)
    expect(verifyCaptureCredential(overLimit, [hashCaptureCredential(overLimit)])).toBe(false)
    expect(
      () =>
        new MockCaptureSource({
          component: 'capture-issuer',
          acceptedCredentialHashes: [],
          pullCredential: overLimit,
        }),
    ).toThrow(RangeError)
  })

  test('a raw credential is rejected as a configured hash', () => {
    expect(
      () =>
        new MockCaptureSource({
          component: 'capture-issuer',
          acceptedCredentialHashes: [ISSUER_TOKEN],
        }),
    ).toThrow(RangeError)
  })
})

describe('pull authorization', () => {
  test('accepts the configured credential and rejects every other one', async () => {
    const accepted = await issuerSource().pull()
    expect(accepted.artifacts.length).toBeGreaterThan(0)

    const wrong = await expectAdapterError(
      () => issuerSource('att_wrong-credential').pull(),
      'unauthorized',
    )
    const missing = await expectAdapterError(() => issuerSource(null).pull(), 'unauthorized')
    // Missing and wrong credentials are indistinguishable, so there is no
    // credential-validity oracle in the message.
    expect(wrong.message).toBe(missing.message)
    expect(wrong.message).not.toContain('att_wrong-credential')
  })

  test('retains only a hash of the outbound pull credential', () => {
    const adapter = issuerSource()
    const serialized = JSON.stringify(adapter)
    expect(serialized).not.toContain(ISSUER_TOKEN)
    expect(serialized).toContain(ISSUER_HASH)
  })

  test('fails closed when no credential hash is configured', async () => {
    const adapter = new MockCaptureSource({
      component: 'capture-issuer',
      pullCredential: ISSUER_TOKEN,
      now: NOW,
    })
    await expectAdapterError(() => adapter.pull(), 'unauthorized')
  })
})

describe('push authorization', () => {
  test('accepts the configured credential and rejects missing or unknown ones', async () => {
    const adapter = issuerSource()
    const accepted = await adapter.push(pushSubmission(ISSUER_TOKEN))
    expect(accepted.duplicate).toBe(false)

    const wrong = await expectAdapterError(
      () => adapter.push(pushSubmission('att_wrong-credential')),
      'unauthorized',
    )
    const missing = await expectAdapterError(
      () => adapter.push(pushSubmission(null)),
      'unauthorized',
    )
    expect(wrong.message).toBe(missing.message)
    expect(wrong.message).not.toContain('att_wrong-credential')
  })

  test('does not accept a credential issued for another source', async () => {
    const verifier = new MockCaptureSource({
      component: 'capture-verifier',
      acceptedCredentialHashes: [VERIFIER_HASH],
      pullCredential: VERIFIER_TOKEN,
      now: NOW,
    })
    await expectAdapterError(
      () => verifier.push(pushSubmission(ISSUER_TOKEN, 'capture-verifier')),
      'unauthorized',
    )
    const accepted = await verifier.push(pushSubmission(VERIFIER_TOKEN, 'capture-verifier'))
    expect(accepted.normalized.envelope.provenance.sourceComponent).toBe('capture-verifier')
  })

  test('rejects before interpreting the submitted bytes', async () => {
    const adapter = issuerSource()
    try {
      await adapter.push({
        authorization: null,
        mediaType: 'application/json',
        bytes: new TextEncoder().encode('not even JSON'),
      })
    } catch (error) {
      expect(isCaptureAdapterError(error)).toBe(true)
      expect(isCaptureError(error)).toBe(false)
      return
    }
    throw new Error('expected the unauthenticated push to be rejected')
  })
})
