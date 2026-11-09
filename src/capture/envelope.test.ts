// Schema, provenance and correlation tests for the capture artifact envelope
// (FR-015/FR-018, issue #46).
//
// These are the "capture" checks from specification §16: valid artifact,
// missing artifact, malformed artifact, redacted artifact, unsupported
// protocol, correlation identifiers, and mock capture-issuer/verifier input.
// No network, credential or real personal data is involved.

import { describe, expect, test } from 'bun:test'

import { isCaptureError } from './errors'
import { resolveCaptureLimits } from './limits'
import { CaptureNormalizer, normalizeCaptureArtifact, parseCaptureArtifact } from './normalize'
import {
  CAPTURED_AT,
  FIXED_NOW,
  ISSUED_CREDENTIAL,
  captureErrorFrom,
  envelopeBytes,
  integrityOf,
  issuerEnvelope,
  sha256Of,
  verifierEnvelope,
} from './test/fixtures'

const normalizerOptions = { now: () => FIXED_NOW }

describe('capture envelope normalization', () => {
  test('normalizes a mock capture-issuer submission and segregates the raw artifact', () => {
    const result = normalizeCaptureArtifact(issuerEnvelope(), normalizerOptions)

    expect(result.envelope.kind).toBe('attestbook.capture-artifact@1')
    expect(result.envelope.envelopeVersion).toBe(1)
    expect(result.envelope.captureId).toBe('capture-issuer-0001')
    expect(result.envelope.correlationId).toBe('credimi-execution-0001')
    expect(result.envelope.interactionType).toBe('issuance')
    expect(result.envelope.protocol).toBe('openid4vci')
    expect(result.envelope.credentialFormat).toBe('dc+sd-jwt')
    expect(result.envelope.artifactType).toBe('issued-credential')
    expect(result.envelope.artifactRef).toBeNull()
    expect(result.envelope.testExecutionRef).toBe('credimi-execution-0001')
    expect(result.envelope.provenance.sourceComponent).toBe('capture-issuer')
    expect(result.envelope.provenance.sourceVersion).toBe('0.4.0')
    expect(result.envelope.provenance.capturedAt).toBe(CAPTURED_AT)
    expect(result.envelope.provenance.capturedAtMs).toBe(Date.parse(CAPTURED_AT))
    expect(result.envelope.provenance.receivedAt).toBe(FIXED_NOW.toISOString())
    expect(result.envelope.provenance.receivedAtMs).toBe(FIXED_NOW.getTime())
    expect(result.envelope.metadata).toEqual({ environment: 'mock', attempt: 1 })
    expect(result.diagnostics).toEqual([])

    const digest = sha256Of(JSON.stringify(ISSUED_CREDENTIAL))
    expect(result.envelope.integrity).toEqual({ algorithm: 'sha256', digest, verified: true })
    expect(result.sensitive).not.toBeNull()
    expect(result.sensitive?.mediaType).toBe('application/json')
    expect(result.sensitive?.encoding).toBe('utf8')
    expect(result.sensitive?.byteLength).toBeGreaterThan(0)
    expect(result.sensitive?.digest).toBe(digest)
  })

  test('never embeds the raw artifact or its claims in the metadata envelope', () => {
    const result = normalizeCaptureArtifact(issuerEnvelope(), normalizerOptions)
    const serialized = JSON.stringify(result.envelope)

    expect(serialized).not.toContain('Mario')
    expect(serialized).not.toContain('Rossi')
    expect(serialized).not.toContain('1990-01-02')
    expect(serialized).not.toContain('sensitive-access-token-value')
    expect(serialized).not.toContain(String(ISSUED_CREDENTIAL.claims.given_name))
  })

  test('normalizes a mock capture-verifier submission with an external reference', () => {
    const result = normalizeCaptureArtifact(verifierEnvelope(), normalizerOptions)

    expect(result.envelope.artifactRef).toEqual({
      uri: 'https://artifacts.example.test/captures/presentation-0001.json',
      mediaType: 'application/json',
      byteLength: 512,
    })
    expect(result.sensitive).toBeNull()
    expect(result.envelope.integrity).toEqual({
      algorithm: 'sha256',
      digest: 'a'.repeat(64),
      verified: false,
    })
    expect(result.diagnostics).toEqual([
      {
        code: 'external_artifact_integrity_unverified',
        message:
          'the artifact is referenced externally; its declared SHA-256 digest was not verified by this normalizer',
        path: 'integrity',
      },
    ])
    // The caller's exact timestamp text is preserved, including its offset.
    expect(result.envelope.provenance.capturedAt).toBe('2026-11-05T10:48:23+01:00')
    expect(result.envelope.provenance.capturedAtMs).toBe(Date.parse('2026-11-05T09:48:23Z'))
  })

  test('accepts absent optional members', () => {
    const result = normalizeCaptureArtifact(
      issuerEnvelope({
        sourceVersion: undefined,
        party: undefined,
        testExecutionRef: undefined,
        metadata: undefined,
      }),
      normalizerOptions,
    )

    expect(result.envelope.provenance.sourceVersion).toBeNull()
    expect(result.envelope.party).toBeNull()
    expect(result.envelope.testExecutionRef).toBeNull()
    expect(result.envelope.metadata).toEqual({})
  })

  test('accepts a declared partial redaction for an external artifact', () => {
    const result = normalizeCaptureArtifact(
      verifierEnvelope({
        redaction: {
          status: 'partial',
          policyRef: 'issuer-policy@1',
          redactedPaths: ['/claims/given_name'],
          redactedDigest: 'b'.repeat(64),
        },
      }),
      normalizerOptions,
    )

    expect(result.envelope.redaction).toEqual({
      status: 'partial',
      policyRef: 'issuer-policy@1',
      redactedPaths: ['/claims/given_name'],
      redactedDigest: 'b'.repeat(64),
    })
  })

  test('accepts a declared full redaction for an external artifact', () => {
    const result = normalizeCaptureArtifact(
      verifierEnvelope({ redaction: { status: 'full', policyRef: 'issuer-policy@1' } }),
      normalizerOptions,
    )

    expect(result.envelope.redaction.status).toBe('full')
    expect(result.envelope.redaction.redactedPaths).toEqual([])
    expect(result.envelope.redaction.redactedDigest).toBeNull()
    expect(result.envelope.redaction.policyRef).toBe('issuer-policy@1')
  })

  test('is available through the class with injectable limits and clock', () => {
    const normalizer = new CaptureNormalizer({
      now: () => FIXED_NOW,
      limits: { maxInlineArtifactBytes: 4 },
    })
    const error = captureErrorFrom(() => normalizer.normalizeBytes(envelopeBytes(issuerEnvelope())))

    expect(error.code).toBe('artifact_too_large')
  })

  test('parses a UTF-8 JSON submission', () => {
    const result = parseCaptureArtifact(envelopeBytes(verifierEnvelope()), normalizerOptions)

    expect(result.envelope.captureId).toBe('capture-verifier-0001')
    expect(result.sensitive).toBeNull()
  })
})

describe('capture envelope schema rejection', () => {
  test.each([
    ['null', null],
    ['an array', []],
    ['a string', 'capture'],
    ['a number', 42],
  ])('rejects %s as the envelope', (_label, value) => {
    const error = captureErrorFrom(() => normalizeCaptureArtifact(value))
    expect(isCaptureError(error)).toBe(true)
    expect(error.code).toBe('invalid_capture')
  })

  test('rejects a missing or wrong kind', () => {
    expect(
      captureErrorFrom(() => normalizeCaptureArtifact(issuerEnvelope({ kind: undefined }))).code,
    ).toBe('invalid_capture')
    expect(
      captureErrorFrom(() => normalizeCaptureArtifact(issuerEnvelope({ kind: 'other@1' }))).code,
    ).toBe('invalid_capture')
  })

  test('rejects an unsupported envelope version', () => {
    for (const version of [0, 2, '1', null]) {
      const error = captureErrorFrom(() =>
        normalizeCaptureArtifact(issuerEnvelope({ envelopeVersion: version })),
      )
      expect(error.code).toBe('unsupported_envelope_version')
    }
  })

  test('rejects an unknown envelope member without echoing it', () => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(issuerEnvelope({ attacker_member: 'do-not-echo-this-value' })),
    )
    expect(error.code).toBe('invalid_capture')
    expect(error.message).not.toContain('attacker_member')
    expect(error.message).not.toContain('do-not-echo-this-value')
  })

  test('rejects malformed capture and correlation identifiers', () => {
    for (const value of [undefined, null, '', 'has space', 'café', 42]) {
      expect(
        captureErrorFrom(() => normalizeCaptureArtifact(issuerEnvelope({ captureId: value }))).code,
      ).toBe('invalid_capture')
      expect(
        captureErrorFrom(() => normalizeCaptureArtifact(issuerEnvelope({ correlationId: value })))
          .code,
      ).toBe('invalid_capture')
    }
    expect(
      captureErrorFrom(() =>
        normalizeCaptureArtifact(issuerEnvelope({ testExecutionRef: 'two words' })),
      ).code,
    ).toBe('invalid_capture')
  })

  test('rejects malformed capture timestamps', () => {
    const invalid = [
      undefined,
      null,
      1_760_000_000,
      '2026-11-05 09:48:23Z',
      '2026-11-05T09:48:23',
      '2026-02-30T09:48:23Z',
      '2026-13-01T09:48:23Z',
      '2026-11-05T24:00:00Z',
      '2026-11-05T09:48:60Z',
      '2026-11-05T09:48:23+24:00',
      '2026-11-05T09:48:23Zjunk',
    ]
    for (const capturedAt of invalid) {
      expect(
        captureErrorFrom(() => normalizeCaptureArtifact(issuerEnvelope({ capturedAt }))).code,
      ).toBe('invalid_timestamp')
    }
  })

  test('accepts and preserves an explicit non-UTC offset', () => {
    const result = normalizeCaptureArtifact(
      issuerEnvelope({ capturedAt: '2026-11-05T11:48:23.123+02:00' }),
      normalizerOptions,
    )
    expect(result.envelope.provenance.capturedAt).toBe('2026-11-05T11:48:23.123+02:00')
    expect(result.envelope.provenance.capturedAtMs).toBe(Date.parse('2026-11-05T09:48:23.123Z'))
  })

  test.each([
    ['sourceComponent', 'capture-agent', 'unsupported_source_component'],
    ['interactionType', 'issuance-preview', 'unsupported_interaction_type'],
    ['protocol', 'openid4vci-draft', 'unsupported_protocol'],
    ['credentialFormat', 'sd-jwt', 'unsupported_credential_format'],
    ['artifactType', 'wallet-state', 'unsupported_artifact_type'],
  ])('rejects an unsupported %s', (field, value, code) => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(issuerEnvelope({ [field]: value })),
    )
    expect(error.code as string).toBe(code)
    expect(error.message).not.toContain(String(value))
  })

  test('rejects a submission with no artifact and one with two artifact sources', () => {
    expect(
      captureErrorFrom(() =>
        normalizeCaptureArtifact(issuerEnvelope({ artifact: undefined, artifactRef: undefined })),
      ).code,
    ).toBe('missing_artifact')

    expect(
      captureErrorFrom(() =>
        normalizeCaptureArtifact(
          issuerEnvelope({
            artifactRef: {
              uri: 'https://artifacts.example.test/captures/a.json',
              mediaType: 'application/json',
            },
          }),
        ),
      ).code,
    ).toBe('ambiguous_artifact_source')
  })

  test('rejects a malformed inline artifact', () => {
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ mediaType: 'application/json', content: '{}', extra: true }, 'invalid_capture'],
      [{ mediaType: 'Application/JSON', content: '{}' }, 'invalid_capture'],
      [{ mediaType: 'application/json', encoding: 'gzip', content: '{}' }, 'unsupported_encoding'],
      [
        { mediaType: 'application/json', encoding: 'base64', content: '***' },
        'invalid_artifact_encoding',
      ],
      [{ mediaType: 'application/json', content: '' }, 'invalid_capture'],
      [{ mediaType: 'application/json', content: '{}', byteLength: 3 }, 'artifact_size_mismatch'],
      [{ mediaType: 'application/json', content: '{}', byteLength: -1 }, 'invalid_capture'],
    ]
    for (const [artifact, code] of cases) {
      expect(
        captureErrorFrom(() => normalizeCaptureArtifact(issuerEnvelope({ artifact })))
          .code as string,
      ).toBe(code)
    }
  })

  test('rejects an inline artifact above the configured limit', () => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(issuerEnvelope(), { limits: { maxInlineArtifactBytes: 8 } }),
    )
    expect(error.code).toBe('artifact_too_large')
    expect(error.message).not.toContain('sensitive-access-token-value')
  })

  test('accepts canonical base64 and rejects a non-canonical encoding', () => {
    const content = JSON.stringify({ ok: true })
    const encoded = Buffer.from(content, 'utf8').toString('base64')
    const artifact = {
      mediaType: 'application/json',
      encoding: 'base64',
      content: encoded,
      byteLength: new TextEncoder().encode(content).byteLength,
    }
    const result = normalizeCaptureArtifact(
      issuerEnvelope({ artifact, integrity: integrityOf(content) }),
      normalizerOptions,
    )
    expect(result.sensitive?.digest).toBe(sha256Of(content))

    const nonCanonical = {
      ...artifact,
      content: encoded.replace(/=+$/, ''),
    }
    expect(
      captureErrorFrom(() => normalizeCaptureArtifact(issuerEnvelope({ artifact: nonCanonical })))
        .code,
    ).toBe('invalid_artifact_encoding')
  })

  test('rejects an unsupported or malformed integrity block', () => {
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ algorithm: 'sha512', digest: 'a'.repeat(64) }, 'unsupported_integrity_algorithm'],
      [{ algorithm: 'sha256', digest: 'A'.repeat(64) }, 'invalid_capture'],
      [{ algorithm: 'sha256', digest: 'a'.repeat(63) }, 'invalid_capture'],
      [{ algorithm: 'sha256', digest: 'a'.repeat(64), extra: true }, 'invalid_capture'],
      [{}, 'unsupported_integrity_algorithm'],
    ]
    for (const [integrity, code] of cases) {
      expect(
        captureErrorFrom(() => normalizeCaptureArtifact(issuerEnvelope({ integrity })))
          .code as string,
      ).toBe(code)
    }
  })

  test('rejects an inline artifact whose digest does not match', () => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(issuerEnvelope({ integrity: integrityOf('different bytes') })),
    )
    expect(error.code).toBe('integrity_mismatch')
    expect(error.message).not.toContain('sensitive-access-token-value')
  })

  test('rejects malformed metadata', () => {
    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ nested: { object: true } }, 'invalid_capture'],
      [{ list: [1, 2, 3] }, 'invalid_capture'],
      [{ BadKey: 'value' }, 'invalid_capture'],
      [{ 'bad key': 'value' }, 'invalid_capture'],
      [{ long: 'x'.repeat(600) }, 'metadata_limit'],
    ]
    for (const [metadata, code] of cases) {
      expect(
        captureErrorFrom(() => normalizeCaptureArtifact(issuerEnvelope({ metadata })))
          .code as string,
      ).toBe(code)
    }

    const tooMany = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`key${index}`, index]),
    )
    expect(
      captureErrorFrom(() => normalizeCaptureArtifact(issuerEnvelope({ metadata: tooMany }))).code,
    ).toBe('metadata_limit')
  })

  test('accepts partial redaction evidence without a path list', () => {
    const result = normalizeCaptureArtifact(
      verifierEnvelope({ redaction: { status: 'partial', policyRef: 'issuer-policy@1' } }),
      normalizerOptions,
    )
    expect(result.envelope.redaction).toEqual({
      status: 'partial',
      policyRef: 'issuer-policy@1',
      redactedPaths: [],
      redactedDigest: null,
    })
  })

  test('accepts explicit empty redaction fields with status "none"', () => {
    const result = normalizeCaptureArtifact(
      verifierEnvelope({
        redaction: {
          status: 'none',
          policyRef: null,
          redactedPaths: [],
          redactedDigest: null,
        },
      }),
      normalizerOptions,
    )
    expect(result.envelope.redaction).toEqual({
      status: 'none',
      policyRef: null,
      redactedPaths: [],
      redactedDigest: null,
    })
  })

  test('rejects an associated party inconsistent with the source component', () => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(
        issuerEnvelope({
          party: { role: 'verifier', identifier: 'https://verifier.example.test' },
        }),
      ),
    )
    expect(error.code).toBe('invalid_capture')
    expect(
      captureErrorFrom(() =>
        normalizeCaptureArtifact(issuerEnvelope({ party: { role: 'issuer' } })),
      ).code,
    ).toBe('invalid_capture')
  })

  test('rejects inconsistent redaction declarations', () => {
    const cases: ReadonlyArray<
      readonly [Record<string, unknown>, Record<string, unknown>, string]
    > = [
      [
        issuerEnvelope(),
        { status: 'partial', policyRef: 'policy@1', redactedPaths: ['/claims'] },
        'redaction_inconsistent',
      ],
      [verifierEnvelope(), { status: 'partial' }, 'invalid_redaction'],
      [
        verifierEnvelope(),
        { status: 'full', policyRef: 'policy@1', redactedPaths: ['/claims'] },
        'invalid_redaction',
      ],
      [verifierEnvelope(), { status: 'none', policyRef: 'policy@1' }, 'invalid_redaction'],
      [
        verifierEnvelope(),
        { status: 'partial', policyRef: 'policy@1', redactedPaths: ['claims'] },
        'invalid_redaction',
      ],
      [
        verifierEnvelope(),
        {
          status: 'partial',
          policyRef: 'policy@1',
          redactedPaths: ['/claims'],
          redactedDigest: 'x',
        },
        'invalid_redaction',
      ],
      [verifierEnvelope(), { status: 'unknown' }, 'invalid_redaction'],
    ]
    for (const [base, redaction, code] of cases) {
      expect(
        captureErrorFrom(() => normalizeCaptureArtifact({ ...base, redaction })).code as string,
      ).toBe(code)
    }
  })

  test('rejects more redacted paths than the configured limit', () => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(
        verifierEnvelope({
          redaction: {
            status: 'partial',
            policyRef: 'policy@1',
            redactedPaths: ['/a', '/b'],
          },
        }),
        { limits: { maxRedactedPaths: 1 } },
      ),
    )
    expect(error.code).toBe('redaction_limit')
  })
})

describe('bounded capture JSON parsing', () => {
  test('rejects non-JSON, non-UTF-8 and empty submissions', () => {
    const notJson = new TextEncoder().encode('{not json')
    expect(captureErrorFrom(() => parseCaptureArtifact(notJson, normalizerOptions)).code).toBe(
      'invalid_json',
    )

    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd])
    expect(captureErrorFrom(() => parseCaptureArtifact(invalidUtf8, normalizerOptions)).code).toBe(
      'invalid_json',
    )

    expect(
      captureErrorFrom(() => parseCaptureArtifact(new Uint8Array(), normalizerOptions)).code,
    ).toBe('invalid_json')
  })

  test('rejects an oversized envelope before parsing', () => {
    const error = captureErrorFrom(() =>
      parseCaptureArtifact(envelopeBytes(issuerEnvelope()), {
        ...normalizerOptions,
        limits: { maxEnvelopeBytes: 10 },
      }),
    )
    expect(error.code).toBe('response_too_large')
  })

  test('rejects a deeply nested or node-heavy submission', () => {
    const deep = { kind: 'x', nested: { a: { b: { c: 1 } } } }
    expect(
      captureErrorFrom(() =>
        parseCaptureArtifact(envelopeBytes(deep), {
          ...normalizerOptions,
          limits: { maxJsonDepth: 2 },
        }),
      ).code,
    ).toBe('json_limit')

    expect(
      captureErrorFrom(() =>
        parseCaptureArtifact(envelopeBytes({ a: 1, b: 2, c: 3 }), {
          ...normalizerOptions,
          limits: { maxJsonNodes: 2 },
        }),
      ).code,
    ).toBe('json_limit')

    expect(
      captureErrorFrom(() =>
        parseCaptureArtifact(envelopeBytes({ a: 'x'.repeat(20) }), {
          ...normalizerOptions,
          limits: { maxJsonStringLength: 10 },
        }),
      ).code,
    ).toBe('json_limit')
  })

  test('rejects a forbidden __proto__ member', () => {
    const text = `{"kind":"attestbook.capture-artifact@1","__proto__":{"polluted":true}}`
    const error = captureErrorFrom(() =>
      parseCaptureArtifact(new TextEncoder().encode(text), normalizerOptions),
    )
    expect(error.code).toBe('json_limit')
  })
})

describe('capture limits', () => {
  test('rejects invalid limit overrides', () => {
    expect(() => resolveCaptureLimits({ maxInlineArtifactBytes: 0 })).toThrow(RangeError)
    expect(() => resolveCaptureLimits({ maxJsonDepth: -1 })).toThrow(RangeError)
    expect(() => resolveCaptureLimits({ maxJsonNodes: 1.5 })).toThrow(RangeError)
    expect(resolveCaptureLimits().maxInlineArtifactBytes).toBe(256 * 1024)
  })
})
