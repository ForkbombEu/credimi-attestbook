import { describe, expect, test } from 'bun:test'

import { DOMESTIC_PID_BASE_VCT, parseSdJwtVc } from './sd-jwt'
import { defaultCredentialClaims, issueTestCredential, TEST_VCT } from './test-support'

const DOMESTIC_PID_VCT = 'urn:eudi:pid:de:1'

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
    expect(outcome.value.akaVcts).toBeUndefined()
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
      { header: { typ: 'dc+sd-jwt' } },
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

  test('rejects a missing issuer JWT typ header', async () => {
    const credential = await issueTestCredential()
    const tampered = mutateCredentialHeader(credential, (header) => {
      delete header.typ
    })
    const outcome = await parseSdJwtVc(tampered)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.findings.map((entry) => entry.code)).toContain('missing_typ_header')
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

  test('accepts a derived domestic PID that declares its base type aliases', async () => {
    const claims = defaultCredentialClaims({
      vct: DOMESTIC_PID_VCT,
      aka_vcts: [DOMESTIC_PID_BASE_VCT, 'urn:example:pid:base'],
    })
    const credential = await issueTestCredential({ claims })
    const outcome = await parseSdJwtVc(credential)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) {
      return
    }
    expect(outcome.value.vct).toBe(DOMESTIC_PID_VCT)
    expect(outcome.value.akaVcts).toEqual([DOMESTIC_PID_BASE_VCT, 'urn:example:pid:base'])
  })

  test('rejects a non-array aka_vcts claim', async () => {
    const claims = defaultCredentialClaims({ aka_vcts: DOMESTIC_PID_BASE_VCT })
    const credential = await issueTestCredential({ claims })
    const outcome = await parseSdJwtVc(credential)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.findings.map((entry) => entry.code)).toContain('invalid_aka_vcts_shape')
  })

  test('rejects an empty aka_vcts array', async () => {
    const claims = defaultCredentialClaims({ aka_vcts: [] })
    const credential = await issueTestCredential({ claims })
    const outcome = await parseSdJwtVc(credential)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.findings.map((entry) => entry.code)).toContain('invalid_aka_vcts_shape')
  })

  test('rejects an aka_vcts entry that is not a non-empty string', async () => {
    const claims = defaultCredentialClaims({ aka_vcts: [DOMESTIC_PID_BASE_VCT, 42] })
    const credential = await issueTestCredential({ claims })
    const outcome = await parseSdJwtVc(credential)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    const entryFinding = outcome.findings.find((entry) => entry.code === 'invalid_aka_vcts_entry')
    expect(entryFinding?.path).toBe('/aka_vcts/1')
  })

  test('rejects an aka_vcts array that repeats the credential vct', async () => {
    const claims = defaultCredentialClaims({ aka_vcts: [TEST_VCT] })
    const credential = await issueTestCredential({ claims })
    const outcome = await parseSdJwtVc(credential)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    const ownVctFinding = outcome.findings.find((entry) => entry.code === 'aka_vcts_contains_vct')
    expect(ownVctFinding?.path).toBe('/aka_vcts/0')
  })

  test('requires the base PID alias on a domestic PID even without aka_vcts', async () => {
    const claims = defaultCredentialClaims({ vct: DOMESTIC_PID_VCT })
    const credential = await issueTestCredential({ claims })
    const outcome = await parseSdJwtVc(credential)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    const aliasFinding = outcome.findings.find(
      (entry) => entry.code === 'missing_domestic_pid_base_alias',
    )
    expect(aliasFinding?.path).toBe('/aka_vcts')
    expect(aliasFinding?.expected?.includes(DOMESTIC_PID_BASE_VCT)).toBe(true)
  })

  test('requires the base PID alias when aka_vcts omits it', async () => {
    const claims = defaultCredentialClaims({
      vct: DOMESTIC_PID_VCT,
      aka_vcts: ['urn:example:pid:base'],
    })
    const credential = await issueTestCredential({ claims })
    const outcome = await parseSdJwtVc(credential)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    expect(outcome.findings.map((entry) => entry.code)).toContain('missing_domestic_pid_base_alias')
  })

  test('rejects a selectively disclosed aka_vcts alias', async () => {
    const claims = defaultCredentialClaims({
      vct: DOMESTIC_PID_VCT,
      aka_vcts: [DOMESTIC_PID_BASE_VCT],
    })
    const credential = await issueTestCredential({ claims, selectiveClaims: ['aka_vcts'] })
    const outcome = await parseSdJwtVc(credential)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    const disclosureFinding = outcome.findings.find(
      (entry) => entry.code === 'protected_claim_selectively_disclosed',
    )
    expect(disclosureFinding?.path).toBe('/aka_vcts')
  })

  test('rejects a selectively disclosable aka_vcts array element', async () => {
    const claims = defaultCredentialClaims({
      vct: DOMESTIC_PID_VCT,
      aka_vcts: [DOMESTIC_PID_BASE_VCT, 'urn:example:pid:base'],
    })
    const credential = await issueTestCredential({
      claims,
      disclosureFrame: { aka_vcts: { _sd: [0] } },
    })
    const outcome = await parseSdJwtVc(credential)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      return
    }
    const disclosureFinding = outcome.findings.find(
      (entry) => entry.code === 'protected_claim_selectively_disclosable',
    )
    expect(disclosureFinding?.path).toBe('/aka_vcts')
  })
})
