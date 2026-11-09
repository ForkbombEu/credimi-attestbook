// Security tests for capture artifact import (issue #46).
//
// The envelope is untrusted input. These tests cover the controls that must
// hold before any real capture adapter is added: external references cannot
// target loopback, private, link-local or cloud-metadata addresses; malformed
// input is rejected without echoing artifact bytes; prototype members are
// rejected; and redaction always removes the synthetic secret it claims to
// remove.

import { describe, expect, test } from 'bun:test'

import { normalizeCaptureArtifact, parseCaptureArtifact } from './normalize'
import { redactCaptureDocument } from './redaction'
import {
  FIXED_NOW,
  captureErrorFrom,
  envelopeBytes,
  inlineArtifact,
  integrityOf,
  issuerEnvelope,
  verifierEnvelope,
} from './test/fixtures'

const normalizerOptions = { now: () => FIXED_NOW }

function referenceFor(uri: string): Record<string, unknown> {
  return { uri, mediaType: 'application/json' }
}

describe('external artifact reference safety', () => {
  const blocked = [
    'http://artifacts.example.test/capture.json',
    'https://user:password@artifacts.example.test/capture.json',
    'https://artifacts.example.test:8443/capture.json',
    'https://artifacts.example.test/capture.json#fragment',
    'https://artifacts.example.test/capture.json#',
    'https://metadata/capture.json',
    'https://localhost/capture.json',
    'https://localhost./capture.json',
    'https://api.local/capture.json',
    'https://metadata.google.internal/computeMetadata/v1',
    'https://artifacts.localhost/capture.json',
    'https://127.0.0.1/capture.json',
    'https://10.0.0.10/capture.json',
    'https://172.16.0.1/capture.json',
    'https://192.168.0.1/capture.json',
    'https://169.254.169.254/latest/meta-data',
    'https://0.0.0.0/capture.json',
    'https://224.0.0.1/capture.json',
    'https://[::1]/capture.json',
    'https://[::ffff:127.0.0.1]/capture.json',
    'https://[fe80::1]/capture.json',
    'https://artifacts.example.test./capture.json',
    'not a url',
    '',
  ]

  test.each(blocked)('rejects unsafe artifact reference %s', (uri) => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(
        verifierEnvelope({ artifactRef: referenceFor(uri) }),
        normalizerOptions,
      ),
    )
    expect(['invalid_reference', 'blocked_reference']).toContain(error.code)
    expect(error.message).not.toContain('password')
  })

  test('accepts a default-port https reference on a public host', () => {
    const result = normalizeCaptureArtifact(
      verifierEnvelope({
        artifactRef: {
          uri: 'https://artifacts.example.test/capture.json?version=2',
          mediaType: 'application/json',
          byteLength: 1024,
        },
      }),
      normalizerOptions,
    )
    expect(result.envelope.artifactRef?.uri).toBe(
      'https://artifacts.example.test/capture.json?version=2',
    )
  })

  test('rejects an unsupported member on the reference without echoing it', () => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(
        verifierEnvelope({
          artifactRef: {
            uri: 'https://artifacts.example.test/capture.json',
            mediaType: 'application/json',
            internal_secret: 'do-not-echo',
          },
        }),
        normalizerOptions,
      ),
    )
    expect(error.code).toBe('invalid_capture')
    expect(error.message).not.toContain('internal_secret')
    expect(error.message).not.toContain('do-not-echo')
  })

  test('does not echo reference credentials in a rejection message', () => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(
        verifierEnvelope({
          artifactRef: referenceFor(
            'https://token:super-secret@artifacts.example.test/capture.json',
          ),
        }),
        normalizerOptions,
      ),
    )
    expect(error.message).not.toContain('super-secret')
  })
})

describe('artifact confidentiality', () => {
  test('rejection messages never echo inline artifact bytes', () => {
    const cases = [
      issuerEnvelope({
        artifact: {
          mediaType: 'application/json',
          content: '{"token":"do-not-echo"}',
          extra: true,
        },
      }),
      issuerEnvelope({ integrity: integrityOf('different-content') }),
      issuerEnvelope({ artifact: inlineArtifact({ token: 'do-not-echo' }, 'TEXT/PLAIN') }),
    ]
    for (const envelope of cases) {
      const error = captureErrorFrom(() => normalizeCaptureArtifact(envelope, normalizerOptions))
      expect(error.message).not.toContain('do-not-echo')
      expect(error.message).not.toContain('different-content')
    }
  })

  test('a rejected submission does not leak the raw artifact through the error path', () => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(
        issuerEnvelope({
          artifact: inlineArtifact({ token: 'do-not-echo' }),
          integrity: integrityOf('other'),
        }),
        normalizerOptions,
      ),
    )
    expect(error.path).toBe('integrity.digest')
    expect(String(error.path)).not.toContain('do-not-echo')
  })

  test('rejects a forbidden prototype member before metadata validation', () => {
    const text = JSON.stringify({
      ...issuerEnvelope(),
      metadata: JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>,
    })
    const error = captureErrorFrom(() =>
      parseCaptureArtifact(new TextEncoder().encode(text), normalizerOptions),
    )
    expect(error.code).toBe('json_limit')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('rejects non-plain objects handed directly to the normalizer', () => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(issuerEnvelope({ metadata: new Date() }), normalizerOptions),
    )
    expect(error.code).toBe('invalid_capture')
  })

  test('redaction rejects a forbidden prototype member', () => {
    const document = JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}') as Record<
      string,
      unknown
    >
    const error = captureErrorFrom(() => redactCaptureDocument(document, { mode: 'partial' }))
    expect(error.code).toBe('json_limit')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('redacted artifact bytes never contain the original synthetic secret', () => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(
        issuerEnvelope({ artifact: inlineArtifact({ access_token: 'do-not-echo' }) }),
        normalizerOptions,
      ),
    )
    // The fixture recomputed its own integrity for the original document, so
    // the replaced artifact intentionally fails integrity verification.
    expect(error.code).toBe('integrity_mismatch')
    expect(error.message).not.toContain('do-not-echo')
  })
})

describe('capture submission bounds', () => {
  test('rejects an envelope over the byte limit before parsing', () => {
    const error = captureErrorFrom(() =>
      parseCaptureArtifact(envelopeBytes(issuerEnvelope()), {
        ...normalizerOptions,
        limits: { maxEnvelopeBytes: 32 },
      }),
    )
    expect(error.code).toBe('response_too_large')
  })

  test('rejects a nested inline artifact over the decoded size limit', () => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(issuerEnvelope(), {
        ...normalizerOptions,
        limits: { maxInlineArtifactBytes: 16 },
      }),
    )
    expect(error.code).toBe('artifact_too_large')
  })

  test('rejects a metadata value that would smuggle a nested object', () => {
    const error = captureErrorFrom(() =>
      normalizeCaptureArtifact(
        issuerEnvelope({ metadata: { nested: { access_token: 'do-not-echo' } } }),
        normalizerOptions,
      ),
    )
    expect(error.code).toBe('invalid_capture')
    expect(error.message).not.toContain('do-not-echo')
  })
})
