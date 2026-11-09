// Redaction tests for capture evidence (FR-015, issue #46).
//
// These tests assert the security property, not just the output shape: no
// synthetic claim value, token or opaque artifact byte survives a redaction
// that claims to remove it, while attribute paths and document structure are
// preserved so findings can still reference them.

import { describe, expect, test } from 'bun:test'

import { resolveCaptureLimits } from './limits'
import { normalizeCaptureArtifact } from './normalize'
import {
  CAPTURE_REDACTION_PLACEHOLDER,
  DEFAULT_CAPTURE_REDACTION_POLICY_REF,
  redactCaptureDocument,
  redactNormalizedCaptureArtifact,
} from './redaction'
import {
  FIXED_NOW,
  captureErrorFrom,
  inlineArtifact,
  integrityOf,
  issuerEnvelope,
  verifierEnvelope,
} from './test/fixtures'

const now = () => FIXED_NOW
const limits = resolveCaptureLimits()

const EVIDENCE = {
  issuer: 'https://issuer.example.test',
  claims: {
    given_name: 'Mario',
    family_name: 'Rossi',
    birthdate: '1990-01-02',
    nationalities: ['IT'],
  },
  access_token: 'sensitive-access-token-value',
  nested: [{ given_name: 'Luigi' }, { note: 'kept-note' }],
}

function expectEveryScalarRedacted(value: unknown): void {
  if (value === null) {
    return
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      expectEveryScalarRedacted(item)
    }
    return
  }
  expect(value).toBe(CAPTURE_REDACTION_PLACEHOLDER)
}

describe('capture document redaction', () => {
  test('partially redacts sensitive members and records their paths', () => {
    const result = redactCaptureDocument(EVIDENCE, { mode: 'partial' })

    expect(result.mode).toBe('partial')
    expect(result.policyRef).toBe(DEFAULT_CAPTURE_REDACTION_POLICY_REF)
    expect(result.placeholder).toBe(CAPTURE_REDACTION_PLACEHOLDER)
    expect(result.redactedPaths).toEqual([
      '/claims',
      '/access_token',
      '/nested/0/given_name',
      '/nested/1/note',
    ])
    expect(result.redactedValues).toBe(4)
    expect(result.pathsTruncated).toBe(false)

    const redacted = result.value as Record<string, unknown>
    expect(redacted.issuer).toBe('https://issuer.example.test')
    expect(redacted.claims).toBe(CAPTURE_REDACTION_PLACEHOLDER)
    expect(redacted.access_token).toBe(CAPTURE_REDACTION_PLACEHOLDER)
    const nested = redacted.nested as ReadonlyArray<Record<string, unknown>>
    expect(nested[0]?.given_name).toBe(CAPTURE_REDACTION_PLACEHOLDER)
    expect(nested[1]?.note).toBe(CAPTURE_REDACTION_PLACEHOLDER)

    const serialized = JSON.stringify(result.value)
    expect(serialized).not.toContain('Mario')
    expect(serialized).not.toContain('Rossi')
    expect(serialized).not.toContain('sensitive-access-token-value')
    expect(serialized).not.toContain('Luigi')
    expect(serialized).not.toContain('kept-note')
  })

  test('matches sensitive key variants and suffixes', () => {
    const document = {
      accessToken: 'one',
      'access-token': 'two',
      id_token: 'three',
      private_key: 'four',
      api_secret: 'five',
      vp_token: 'six',
      credentialFormat: 'dc+sd-jwt',
    }
    const result = redactCaptureDocument(document, { mode: 'partial' })
    const redacted = result.value as Record<string, unknown>

    expect(redacted.accessToken).toBe(CAPTURE_REDACTION_PLACEHOLDER)
    expect(redacted['access-token']).toBe(CAPTURE_REDACTION_PLACEHOLDER)
    expect(redacted.id_token).toBe(CAPTURE_REDACTION_PLACEHOLDER)
    expect(redacted.private_key).toBe(CAPTURE_REDACTION_PLACEHOLDER)
    expect(redacted.api_secret).toBe(CAPTURE_REDACTION_PLACEHOLDER)
    expect(redacted.vp_token).toBe(CAPTURE_REDACTION_PLACEHOLDER)
    // A format selector is not credential material.
    expect(redacted.credentialFormat).toBe('dc+sd-jwt')
  })

  test('full redaction keeps structure and removes every scalar', () => {
    const result = redactCaptureDocument(EVIDENCE, { mode: 'full' })
    const redacted = result.value as typeof EVIDENCE

    expect(result.redactedPaths).toEqual([])
    expect(result.redactedValues).toBeGreaterThan(0)
    expect(Object.keys(redacted)).toEqual(Object.keys(EVIDENCE))
    expect(redacted.nested).toHaveLength(2)
    expect(redacted.issuer).toBe(CAPTURE_REDACTION_PLACEHOLDER)
    expect(JSON.stringify(result.value)).not.toContain('Mario')
    expect(JSON.stringify(result.value)).not.toContain('https://issuer.example.test')
  })

  test('uses an explicit policy reference and placeholder', () => {
    const result = redactCaptureDocument(
      { secret: 'value' },
      { mode: 'partial', policyRef: 'my-policy@2', placeholder: '<gone>' },
    )
    expect(result.policyRef).toBe('my-policy@2')
    expect((result.value as Record<string, unknown>).secret).toBe('<gone>')
  })

  test('redacts additional caller-supplied keys', () => {
    const result = redactCaptureDocument(
      { custom_field: 'value', issuer: 'https://issuer.example.test' },
      { mode: 'partial', sensitiveKeys: ['custom_field'] },
    )
    expect((result.value as Record<string, unknown>).custom_field).toBe(
      CAPTURE_REDACTION_PLACEHOLDER,
    )
    expect((result.value as Record<string, unknown>).issuer).toBe('https://issuer.example.test')
  })

  test('preserves additional caller-supplied keys', () => {
    const document = { custom: 'value' }
    const redactedByDefault = redactCaptureDocument(document, { mode: 'partial' })
    expect((redactedByDefault.value as Record<string, unknown>).custom).toBe(
      CAPTURE_REDACTION_PLACEHOLDER,
    )

    const kept = redactCaptureDocument(document, {
      mode: 'partial',
      preservedKeys: ['custom'],
    })
    expect((kept.value as Record<string, unknown>).custom).toBe('value')
    expect(kept.redactedValues).toBe(0)
  })

  test('truncates path evidence at the configured limit', () => {
    const result = redactCaptureDocument(
      { claims: 'a', access_token: 'b' },
      { mode: 'partial' },
      resolveCaptureLimits({ maxRedactedPaths: 1 }),
    )
    expect(result.redactedPaths).toHaveLength(1)
    expect(result.pathsTruncated).toBe(true)
  })

  test('redacts credential-offer secrets while keeping safe offer structure', () => {
    const offer = {
      credential_issuer: 'https://issuer.example.test',
      credential_configuration_ids: ['pid'],
      grants: {
        'urn:ietf:params:oauth:grant-type:pre-authorized_code': {
          'pre-authorized_code': 'SECRET-PREAUTH',
          tx_code: { length: 4, input_mode: 'numeric' },
        },
        authorization_code: { issuer_state: 'STATE-SECRET' },
      },
    }
    const result = redactCaptureDocument(offer, { mode: 'partial' })
    const serialized = JSON.stringify(result.value)

    expect(serialized).not.toContain('SECRET-PREAUTH')
    expect(serialized).not.toContain('STATE-SECRET')
    expect(serialized).not.toContain('numeric')
    expect((result.value as typeof offer).credential_issuer).toBe('https://issuer.example.test')
    expect((result.value as typeof offer).credential_configuration_ids).toEqual(['pid'])
    expect(result.redactedPaths).toContain(
      '/grants/urn:ietf:params:oauth:grant-type:pre-authorized_code/pre-authorized_code',
    )
  })

  test('redacts common PID claims and protocol secrets by default', () => {
    const document = {
      nationality: 'IT',
      birth_place: 'Roma',
      resident_address: 'Via Example 1',
      email_address: 'mario@example.test',
      mobile_phone_number: '+390000000',
      document_number: 'DOC-SECRET',
      sex: 1,
      age_over_18: true,
      age_in_years: 40,
      portrait: 'BASE64-PORTRAIT',
      birth_family_name: 'Rossi',
      given_name_birth: 'Mario',
      place_of_birth: { locality: 'Roma' },
      code: 'AUTH-CODE-SECRET',
      c_nonce: 'NONCE-SECRET',
      proof: { jwt: 'PROOF-JWT-SECRET' },
      dpop: 'DPOP-SECRET',
      client_assertion: 'ASSERTION-SECRET',
    }
    const result = redactCaptureDocument(document, { mode: 'partial' })
    const redacted = result.value as Record<string, unknown>

    for (const key of Object.keys(document)) {
      expectEveryScalarRedacted(redacted[key])
    }
    const serialized = JSON.stringify(result.value)
    for (const secret of [
      'IT',
      'Roma',
      'Via Example 1',
      'mario@example.test',
      '+390000000',
      'DOC-SECRET',
      'BASE64-PORTRAIT',
      'AUTH-CODE-SECRET',
      'NONCE-SECRET',
      'PROOF-JWT-SECRET',
      'DPOP-SECRET',
      'ASSERTION-SECRET',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  test('keeps DCQL structure and redacts the claims subtree', () => {
    const query = {
      dcql_query: {
        credentials: [
          {
            id: 'pid',
            format: 'dc+sd-jwt',
            meta: { vct_values: ['urn:eudi:pid:1'] },
            claims: [{ path: ['given_name'] }],
          },
        ],
      },
    }
    const result = redactCaptureDocument(query, { mode: 'partial' })
    const serialized = JSON.stringify(result.value)

    // The claims subtree is deny-listed and replaced whole.
    expect(serialized).not.toContain('given_name')
    expect(serialized).toContain('"id":"pid"')
    expect(serialized).toContain('"format":"dc+sd-jwt"')
  })

  test('rejects an invalid policy', () => {
    expect(
      captureErrorFrom(() =>
        redactCaptureDocument({}, { mode: 'everything' as unknown as 'partial' }),
      ).code,
    ).toBe('invalid_redaction')
    expect(
      captureErrorFrom(() => redactCaptureDocument({}, { mode: 'partial', placeholder: ' ' })).code,
    ).toBe('invalid_redaction')
    expect(
      captureErrorFrom(() =>
        redactCaptureDocument({}, { mode: 'partial', sensitiveKeys: new Array(65).fill('key') }),
      ).code,
    ).toBe('invalid_redaction')
    expect(
      captureErrorFrom(() =>
        redactCaptureDocument({}, { mode: 'partial', preservedKeys: new Array(65).fill('key') }),
      ).code,
    ).toBe('invalid_redaction')
  })

  test('rejects a document over the JSON bounds', () => {
    const error = captureErrorFrom(() =>
      redactCaptureDocument(
        { a: { b: { c: 1 } } },
        { mode: 'partial' },
        resolveCaptureLimits({ maxJsonDepth: 2 }),
      ),
    )
    expect(error.code).toBe('json_limit')
  })
})

describe('redacting a normalized capture', () => {
  test('redacts an inline JSON artifact without touching the metadata envelope', () => {
    const normalized = normalizeCaptureArtifact(issuerEnvelope(), { now })
    const result = redactNormalizedCaptureArtifact(normalized, { mode: 'partial' }, limits)

    expect(result.envelope.redaction.status).toBe('partial')
    expect(result.envelope.redaction.policyRef).toBe(DEFAULT_CAPTURE_REDACTION_POLICY_REF)
    expect(result.envelope.redaction.redactedPaths).toContain('/claims')
    expect(result.envelope.redaction.redactedDigest).toBe(result.sensitive?.digest ?? null)
    // Integrity still describes the unredacted original.
    expect(result.envelope.integrity).toEqual(normalized.envelope.integrity)
    expect(result.envelope.captureId).toBe(normalized.envelope.captureId)

    const text = new TextDecoder().decode(result.sensitive?.bytes)
    expect(text).not.toContain('Mario')
    expect(text).not.toContain('Rossi')
    expect(text).not.toContain('sensitive-access-token-value')
    const parsed = JSON.parse(text) as Record<string, unknown>
    expect(parsed.issuer).toBe('https://issuer.example.test')
    expect(result.diagnostics).toEqual([])
  })

  test('redacts a captured credential-offer artifact before it can be logged', () => {
    const offer = {
      credential_issuer: 'https://issuer.example.test',
      credential_configuration_ids: ['pid'],
      grants: {
        authorization_code: { issuer_state: 'SECRET-PREAUTH' },
      },
    }
    const artifact = inlineArtifact(offer)
    const normalized = normalizeCaptureArtifact(
      issuerEnvelope({
        artifactType: 'credential-offer',
        artifact,
        integrity: integrityOf(String(artifact.content)),
      }),
      { now },
    )
    const result = redactNormalizedCaptureArtifact(normalized, { mode: 'partial' }, limits)
    const text = new TextDecoder().decode(result.sensitive?.bytes)

    expect(result.envelope.redaction.status).toBe('partial')
    expect(text).not.toContain('SECRET-PREAUTH')
    expect(text).toContain('https://issuer.example.test')
  })

  test('fully redacts an inline JSON artifact when requested', () => {
    const normalized = normalizeCaptureArtifact(issuerEnvelope(), { now })
    const result = redactNormalizedCaptureArtifact(normalized, { mode: 'full' }, limits)
    const text = new TextDecoder().decode(result.sensitive?.bytes)

    expect(result.envelope.redaction.status).toBe('full')
    expect(result.envelope.redaction.redactedPaths).toEqual([])
    expect(text).not.toContain('Mario')
    expect(text).not.toContain('issuer.example.test')
  })

  test('falls back to full redaction of opaque content', () => {
    const artifact = inlineArtifact('opaque-sensitive-bytes', 'text/plain')
    const normalized = normalizeCaptureArtifact(
      issuerEnvelope({
        artifact,
        integrity: integrityOf(String(artifact.content)),
      }),
      { now },
    )
    const result = redactNormalizedCaptureArtifact(normalized, { mode: 'partial' }, limits)

    expect(result.envelope.redaction.status).toBe('full')
    expect(result.sensitive?.mediaType).toBe('text/plain')
    expect(new TextDecoder().decode(result.sensitive?.bytes)).toBe(CAPTURE_REDACTION_PLACEHOLDER)
    expect(result.diagnostics.map((entry) => entry.code)).toContain('redaction_full_fallback')
    expect(JSON.stringify(result.diagnostics)).not.toContain('opaque-sensitive-bytes')
  })

  test('falls back to full redaction of malformed JSON content', () => {
    const content = '{"claims": "still-sensitive"'
    const artifact = {
      mediaType: 'application/json',
      encoding: 'utf8',
      content,
      byteLength: new TextEncoder().encode(content).byteLength,
    }
    const normalized = normalizeCaptureArtifact(
      issuerEnvelope({ artifact, integrity: integrityOf(content) }),
      { now },
    )
    const result = redactNormalizedCaptureArtifact(normalized, { mode: 'partial' }, limits)

    expect(result.envelope.redaction.status).toBe('full')
    expect(new TextDecoder().decode(result.sensitive?.bytes)).not.toContain('still-sensitive')
    expect(result.diagnostics.map((entry) => entry.code)).toContain('redaction_full_fallback')
  })

  test('keeps the redaction status "none" when nothing matched', () => {
    const document = { issuer: 'https://issuer.example.test' }
    const content = JSON.stringify(document)
    const artifact = inlineArtifact(document)
    const normalized = normalizeCaptureArtifact(
      issuerEnvelope({ artifact, integrity: integrityOf(content) }),
      { now },
    )
    const result = redactNormalizedCaptureArtifact(normalized, { mode: 'partial' }, limits)

    expect(result.envelope.redaction).toEqual({
      status: 'none',
      policyRef: null,
      redactedPaths: [],
      redactedDigest: null,
    })
    // A no-op partial pass keeps the exact original bytes.
    expect(result.sensitive?.digest).toBe(normalized.envelope.integrity.digest)
    expect(result.sensitive?.bytes).toEqual(normalized.sensitive?.bytes)
  })

  test('refuses to redact an artifact that stayed external', () => {
    const normalized = normalizeCaptureArtifact(verifierEnvelope(), { now })
    const error = captureErrorFrom(() =>
      redactNormalizedCaptureArtifact(normalized, { mode: 'partial' }, limits),
    )
    expect(error.code).toBe('redaction_unavailable')
  })

  test('reports truncated path evidence on the envelope diagnostic', () => {
    const normalized = normalizeCaptureArtifact(issuerEnvelope(), { now })
    const result = redactNormalizedCaptureArtifact(
      normalized,
      { mode: 'partial' },
      resolveCaptureLimits({ maxRedactedPaths: 1 }),
    )
    expect(result.envelope.redaction.redactedPaths).toHaveLength(1)
    expect(result.diagnostics.map((entry) => entry.code)).toContain('redaction_paths_truncated')
  })
})
