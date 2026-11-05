import { describe, expect, test } from 'bun:test'

import { parseSdJwtVc } from './sd-jwt'
import { defaultCredentialClaims, issueTestCredential, TEST_VCT } from './test-support'

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function mutateCredentialHeader(
  credential: string,
  mutate: (header: Record<string, unknown>) => void,
): string {
  const [jwt, ...rest] = credential.split('~')
  const parts = (jwt ?? '').split('.')
  const header = parts[0]
  const payload = parts[1]
  const signature = parts[2]
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new Error('test fixture is not a compact JWT')
  }
  const decoded = decodeSegment(header)
  mutate(decoded)
  return [[encodeSegment(decoded), payload, signature].join('.'), ...rest].join('~')
}

function mutateCredentialPayload(
  credential: string,
  mutate: (payload: Record<string, unknown>) => void,
): string {
  const [jwt, ...rest] = credential.split('~')
  const parts = (jwt ?? '').split('.')
  const header = parts[0]
  const payload = parts[1]
  const signature = parts[2]
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new Error('test fixture is not a compact JWT')
  }
  const decoded = decodeSegment(payload)
  mutate(decoded)
  return [[header, encodeSegment(decoded), signature].join('.'), ...rest].join('~')
}

describe('parseSdJwtVc', () => {
  test('parses a valid SD-JWT VC and unpacks disclosures', async () => {
    const credential = await issueTestCredential()
    const outcome = await parseSdJwtVc(credential)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    expect(outcome.value.vct).toBe(TEST_VCT)
    expect(outcome.value.disclosureCount).toBe(3)
    expect(outcome.value.claims.given_name).toBe('Ada')
    expect(outcome.value.claims.birthdate).toBe('1815-12-10')
    expect(outcome.value.packedPayload).toHaveProperty('_sd')
    expect(outcome.value.keyBindingPresent).toBe(false)
  })

  test('rejects a plain compact JWT without the SD-JWT separator', async () => {
    const credential = await issueTestCredential()
    const outcome = await parseSdJwtVc(credential.split('~')[0] ?? '')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.kind).toBe('invalid')
    expect(outcome.findings.map((entry) => entry.code)).toContain('invalid_sd_jwt_compact')
  })

  test('rejects a payload without a non-empty vct', async () => {
    const claims = defaultCredentialClaims()
    delete claims.vct
    const credential = await issueTestCredential({ claims })
    const outcome = await parseSdJwtVc(credential)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.findings.map((entry) => entry.code)).toContain('missing_vct')
  })

  test('rejects an unreferenced disclosure', async () => {
    const credential = await issueTestCredential()
    const extra = encodeSegment(['extra-salt', 'unused_claim', 'value'])
    const tampered = `${credential}${extra}~`
    const outcome = await parseSdJwtVc(tampered)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.findings.map((entry) => entry.code)).toContain('invalid_disclosures')
    expect(outcome.findings[0]?.message).not.toContain('extra-salt')
  })

  test('rejects a duplicated disclosure', async () => {
    const credential = await issueTestCredential()
    const parts = credential.split('~')
    const duplicate = `${parts[0] ?? ''}~${parts[1] ?? ''}~${parts[1] ?? ''}~`
    const outcome = await parseSdJwtVc(duplicate)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.findings.map((entry) => entry.code)).toContain('invalid_disclosures')
  })

  test('rejects a protected claim that was selectively disclosed', async () => {
    const { SDJwtInstance } = await import('@sd-jwt/core')
    const { createSdJwtHasher } = await import('./sd-jwt')
    let salts = 0
    const core = new SDJwtInstance({
      signer: () => 'ZmFrZS1zaWduYXR1cmU',
      signAlg: 'ES256',
      hasher: createSdJwtHasher(),
      saltGenerator: () => `core-salt-${String(salts++)}`,
    })
    const credential = await core.issue(
      {
        iss: 'https://issuer.example/pid',
        vct: TEST_VCT,
        iat: 1_700_000_000,
        given_name: 'Ada',
      },
      { _sd: ['iss', 'given_name'] },
    )

    const outcome = await parseSdJwtVc(credential)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.findings.map((entry) => entry.code)).toContain(
      'protected_claim_selectively_disclosed',
    )
  })

  test('reports an unsupported disclosure hash algorithm without executing it', async () => {
    const credential = await issueTestCredential()
    const tampered = mutateCredentialPayload(credential, (payload) => {
      payload._sd_alg = 'k12-256'
    })
    const outcome = await parseSdJwtVc(tampered)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.kind).toBe('unsupported')
    expect(outcome.findings.map((entry) => entry.code)).toContain('unsupported_hash_algorithm')
  })

  test('rejects claims nested beyond the depth bound', async () => {
    const nested: Record<string, unknown> = {}
    let node = nested
    for (let depth = 0; depth < 80; depth += 1) {
      const child: Record<string, unknown> = {}
      node.child = child
      node = child
    }
    const credential = await issueTestCredential({
      claims: defaultCredentialClaims({ nested }),
      selectiveClaims: [],
    })
    const outcome = await parseSdJwtVc(credential)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.findings.map((entry) => entry.code)).toContain('claim_depth_exceeded')
  })

  test('rejects an unexpected issuer JWT typ header', async () => {
    const credential = await issueTestCredential()
    const tampered = mutateCredentialHeader(credential, (header) => {
      header.typ = 'JWT'
    })
    const outcome = await parseSdJwtVc(tampered)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.findings.map((entry) => entry.code)).toContain('unexpected_typ_header')
  })

  test('caps the number of disclosures it will unpack', async () => {
    const credential = await issueTestCredential()
    const jwt = credential.split('~')[0] ?? ''
    const disclosures = Array.from({ length: 1_001 }, (_, index) =>
      encodeSegment([`salt-${index}`, 'unused', index]),
    ).join('~')
    const outcome = await parseSdJwtVc(`${jwt}~${disclosures}~`)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.findings.map((entry) => entry.code)).toContain('too_many_disclosures')
  })

  test('detects a trailing key-binding JWT without verifying it', async () => {
    const credential = await issueTestCredential()
    const header = encodeSegment({ typ: 'kb+jwt', alg: 'ES256' })
    const payload = encodeSegment({
      iat: 1_700_000_000,
      aud: 'https://verifier.example',
      nonce: 'nonce',
      sd_hash: 'hash',
    })
    const outcome = await parseSdJwtVc(`${credential}${header}.${payload}.c2ln`)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    expect(outcome.value.keyBindingPresent).toBe(true)
  })
})
