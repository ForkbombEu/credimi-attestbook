import { describe, expect, test } from 'bun:test'

import { verifySchemaMeta } from '@owf/eudi-attestation-schema'

import {
  decodeCompactJws,
  DEFAULT_JWS_ALGORITHM,
  signSchemaMetaJws,
  verifySchemaMetaJws,
  type JwsAlgorithm,
  type SignSchemaMetaOptions,
} from './jose'
import type { AdapterResult, CanonicalSchemaMeta } from './index'
import { parseOwfSchemaMeta, parseTs11SchemaMeta } from './index'
import {
  buildOwfWire,
  buildTs11Document,
  craftJws,
  createTestKey,
  decodeJwsHeader,
  decodeJwsPayload,
  TEST_CERTIFICATE_DER,
  TEST_CERTIFICATE_PEM,
  type TestKey,
} from './test-fixtures'

function failureDiagnostics(result: AdapterResult<unknown>) {
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('expected the adapter call to fail')
  }
  return result.diagnostics
}

function successValue<T>(result: AdapterResult<T>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(`expected success, got: ${JSON.stringify(result.diagnostics)}`)
  }
  return result.value
}

const readOwf = (): CanonicalSchemaMeta => successValue(parseOwfSchemaMeta(buildOwfWire()))

const payloadWithIat = (): Record<string, unknown> => ({
  ...(buildOwfWire() as unknown as Record<string, unknown>),
  iat: 1_700_000_000,
})

function headerWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alg: 'ES256',
    typ: 'attestation-schema+jwt',
    kid: 'kid-1',
    x5c: [TEST_CERTIFICATE_DER],
    ...overrides,
  }
}

async function signWith(key: TestKey): Promise<string> {
  const result = await signSchemaMetaJws({
    schemaMeta: readOwf(),
    keyId: 'kid-1',
    certificates: [TEST_CERTIFICATE_PEM],
    signer: key.signer,
  })
  return successValue(result).jws
}

describe('strict JOSE signing', () => {
  test('signs through OWF and returns the policy-checked header', async () => {
    const key = await createTestKey()
    const result = await signSchemaMetaJws({
      schemaMeta: readOwf(),
      keyId: 'kid-1',
      certificates: [TEST_CERTIFICATE_PEM],
      signer: key.signer,
    })
    const signed = successValue(result)

    expect(signed.jws.split('.')).toHaveLength(3)
    expect(signed.profile).toBe('owf@0.5.4')
    expect(signed.header).toMatchObject({
      alg: 'ES256',
      typ: 'attestation-schema+jwt',
      kid: 'kid-1',
    })
    expect(signed.header.x5c).toEqual([TEST_CERTIFICATE_DER])
    expect(signed.iat).toBeGreaterThan(0)

    const payload = decodeJwsPayload(signed.jws)
    expect(payload.iat).toBe(signed.iat)
    expect(decodeJwsHeader(signed.jws).alg).toBe('ES256')
  })

  test('defaults to ES256', () => {
    expect(DEFAULT_JWS_ALGORITHM).toBe('ES256')
  })

  test('rejects an empty certificate chain', async () => {
    const key = await createTestKey()
    const diagnostics = failureDiagnostics(
      await signSchemaMetaJws({
        schemaMeta: readOwf(),
        keyId: 'kid-1',
        certificates: [],
        signer: key.signer,
      }),
    )

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'invalid_input',
        code: 'missing_required_member',
        path: 'certificates',
      }),
    ])
  })

  test('rejects a non-PEM certificate', async () => {
    const key = await createTestKey()
    const diagnostics = failureDiagnostics(
      await signSchemaMetaJws({
        schemaMeta: readOwf(),
        keyId: 'kid-1',
        certificates: ['not-a-certificate'],
        signer: key.signer,
      }),
    )

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'invalid_input',
        code: 'invalid_signing_certificate',
      }),
    ])
  })

  test('rejects an algorithm outside the allowlist', async () => {
    const key = await createTestKey()
    const diagnostics = failureDiagnostics(
      await signSchemaMetaJws({
        schemaMeta: readOwf(),
        keyId: 'kid-1',
        algorithm: 'HS256' as unknown as JwsAlgorithm,
        certificates: [TEST_CERTIFICATE_PEM],
        signer: key.signer,
      }),
    )

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'unsupported_operation',
        code: 'unsupported_jose_algorithm',
      }),
    ])
  })

  test('reports an OWF-only signing profile for an unrepresentable document', async () => {
    const document = buildTs11Document()
    document.supportedFormats = ['jwt_vc_json']
    document.schemaURIs = [
      { formatIdentifier: 'jwt_vc_json', uri: 'https://example.com/schema.json' },
    ]
    const canonical = successValue(parseTs11SchemaMeta(document))
    const key = await createTestKey()

    const diagnostics = failureDiagnostics(
      await signSchemaMetaJws({
        schemaMeta: canonical,
        keyId: 'kid-1',
        certificates: [TEST_CERTIFICATE_PEM],
        signer: key.signer,
      }),
    )

    expect(
      diagnostics.some(
        (entry) => entry.kind === 'unsupported_operation' && entry.code === 'unsupported_format',
      ),
    ).toBe(true)
  })
})

describe('strict JOSE verification', () => {
  test('verifies the real signature and keeps trust NOT_TESTED', async () => {
    const key = await createTestKey()
    const jws = await signWith(key)
    const result = await verifySchemaMetaJws({
      jws,
      verifier: key.verifier,
      algorithm: 'ES256',
      keyId: 'kid-1',
    })
    const verified = successValue(result)

    expect(verified.schemaMeta.id).toBe('https://example.com/attestations/gym-membership-card')
    expect(verified.schemaMeta.rulebookIntegrity).toBeDefined()
    expect(verified.iat).toBe(decodeJwsPayload(jws).iat as number)
    expect(
      result.diagnostics.some(
        (entry) => entry.kind === 'not_tested' && entry.code === 'trust_not_tested',
      ),
    ).toBe(true)
  })

  test('rejects a tampered signature', async () => {
    const key = await createTestKey()
    const jws = await signWith(key)
    const [header, payload, signature] = jws.split('.')
    const signatureChars = (signature ?? '').split('')
    const middle = Math.floor(signatureChars.length / 2)
    signatureChars[middle] = signatureChars[middle] === 'A' ? 'B' : 'A'
    const tampered = `${header}.${payload}.${signatureChars.join('')}`

    expect(
      failureDiagnostics(
        await verifySchemaMetaJws({
          jws: tampered,
          verifier: key.verifier,
          algorithm: 'ES256',
          keyId: 'kid-1',
        }),
      ).map((entry) => entry.code),
    ).toContain('invalid_signature')
  })

  test('rejects a signature made by a different key', async () => {
    const signerKey = await createTestKey()
    const verifierKey = await createTestKey()
    const jws = await signWith(signerKey)

    expect(
      failureDiagnostics(
        await verifySchemaMetaJws({
          jws,
          verifier: verifierKey.verifier,
          algorithm: 'ES256',
          keyId: 'kid-1',
        }),
      ).map((entry) => entry.code),
    ).toContain('invalid_signature')
  })

  test('rejects a mismatched expected key id', async () => {
    const key = await createTestKey()
    const jws = await signWith(key)

    expect(
      failureDiagnostics(
        await verifySchemaMetaJws({
          jws,
          verifier: key.verifier,
          algorithm: 'ES256',
          keyId: 'another-kid',
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'invalid_input',
        code: 'invalid_jose_header',
        path: 'header.kid',
      }),
    ])
  })

  test('rejects a header algorithm different from the expected one', async () => {
    const key = await createTestKey()
    const jws = await craftJws(headerWith(), payloadWithIat(), key.signer)

    expect(
      failureDiagnostics(
        await verifySchemaMetaJws({
          jws,
          verifier: key.verifier,
          algorithm: 'ES384',
          keyId: 'kid-1',
        }),
      ).map((entry) => entry.code),
    ).toContain('invalid_jose_header')
  })

  test('rejects a missing x5c even though OWF accepts it', async () => {
    const key = await createTestKey()
    const jws = await craftJws(headerWith({ x5c: undefined }), payloadWithIat(), key.signer)

    const owf = await verifySchemaMeta({ jws, verifier: key.verifier })
    expect(owf.header.x5c).toBeUndefined()

    expect(
      failureDiagnostics(
        await verifySchemaMetaJws({
          jws,
          verifier: key.verifier,
          algorithm: 'ES256',
          keyId: 'kid-1',
        }),
      ).map((entry) => entry.code),
    ).toContain('invalid_jose_header')
  })

  test('rejects typ "JWT" even though OWF accepts it', async () => {
    const key = await createTestKey()
    const jws = await craftJws(headerWith({ typ: 'JWT' }), payloadWithIat(), key.signer)

    const owf = await verifySchemaMeta({ jws, verifier: key.verifier })
    expect(owf.header.typ).toBe('JWT')

    expect(
      failureDiagnostics(
        await verifySchemaMetaJws({
          jws,
          verifier: key.verifier,
          algorithm: 'ES256',
          keyId: 'kid-1',
        }),
      ).map((entry) => entry.code),
    ).toContain('invalid_jose_header')
  })

  test('rejects an alg value inconsistent with the signature', async () => {
    const key = await createTestKey()
    const jws = await craftJws(headerWith({ alg: 'ES384' }), payloadWithIat(), key.signer)

    const owf = await verifySchemaMeta({ jws, verifier: key.verifier })
    expect(owf.header.alg).toBe('ES384')

    expect(
      failureDiagnostics(
        await verifySchemaMetaJws({
          jws,
          verifier: key.verifier,
          algorithm: 'ES256',
          keyId: 'kid-1',
        }),
      ).map((entry) => entry.code),
    ).toContain('invalid_jose_header')
  })

  test('rejects alg "none" as an unsupported operation', async () => {
    const key = await createTestKey()
    const jws = await craftJws(headerWith({ alg: 'none' }), payloadWithIat(), key.signer)

    const owf = await verifySchemaMeta({ jws, verifier: key.verifier })
    expect(owf.header.alg).toBe('none')

    expect(
      failureDiagnostics(
        await verifySchemaMetaJws({
          jws,
          verifier: key.verifier,
          algorithm: 'ES256',
          keyId: 'kid-1',
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'unsupported_operation',
        code: 'unsupported_jose_algorithm',
      }),
    ])
  })

  test('rejects a synthetic iat even though OWF accepts the payload', async () => {
    const key = await createTestKey()
    const jws = await craftJws(headerWith(), { ...buildOwfWire() }, key.signer)

    const owf = await verifySchemaMeta({ jws, verifier: key.verifier })
    expect(owf.payload.iat).toBeUndefined()
    expect(owf.iat).toBeGreaterThan(0)

    expect(
      failureDiagnostics(
        await verifySchemaMetaJws({
          jws,
          verifier: key.verifier,
          algorithm: 'ES256',
          keyId: 'kid-1',
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'invalid_input',
        code: 'synthetic_iat',
        path: 'payload.iat',
      }),
    ])
  })

  test('rejects a payload that is not a valid OWF SchemaMeta', async () => {
    const key = await createTestKey()
    const jws = await craftJws(
      headerWith(),
      { ...payloadWithIat(), version: 'not-semver' },
      key.signer,
    )

    expect(
      failureDiagnostics(
        await verifySchemaMetaJws({
          jws,
          verifier: key.verifier,
          algorithm: 'ES256',
          keyId: 'kid-1',
        }),
      ).length,
    ).toBeGreaterThan(0)
  })

  test('preserves unknown top-level members through signing and verification', async () => {
    const canonical = successValue(
      parseOwfSchemaMeta({ ...buildOwfWire(), futureMember: { revision: 2 } }),
    )
    const key = await createTestKey()
    const signed = successValue(
      await signSchemaMetaJws({
        schemaMeta: canonical,
        keyId: 'kid-1',
        certificates: [TEST_CERTIFICATE_PEM],
        signer: key.signer,
      }),
    )
    const verified = successValue(
      await verifySchemaMetaJws({
        jws: signed.jws,
        verifier: key.verifier,
        algorithm: 'ES256',
        keyId: 'kid-1',
      }),
    )

    expect(verified.schemaMeta.unknownMembers).toEqual({ futureMember: { revision: 2 } })
  })

  test('decodeCompactJws rejects malformed compact serializations', () => {
    expect(decodeCompactJws('a.b').ok).toBe(false)
    expect(decodeCompactJws('a.b.c').ok).toBe(false)
    expect(decodeCompactJws('!!!.!!!.!!!').ok).toBe(false)
  })

  test('sign options type accepts the OWF signer contract', () => {
    const check: Pick<SignSchemaMetaOptions, 'signer' | 'certificates' | 'keyId'> = {
      signer: (data: string) => data,
      certificates: [],
      keyId: 'kid',
    }
    expect(check.keyId).toBe('kid')
  })
})
