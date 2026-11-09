// Deterministic capture-envelope fixtures shared by the module tests.
//
// Nothing here is a live capture: the documents are synthetic and contain no
// real credential, key or personal data beyond obviously fictional values.

import { sha256Hex } from '../../registry/digest'
import { CaptureError } from '../errors'
import { CAPTURE_ARTIFACT_KIND, CAPTURE_ENVELOPE_VERSION } from '../types'

export const FIXED_NOW = new Date('2026-11-05T09:50:00.000Z')
export const CAPTURED_AT = '2026-11-05T09:48:23Z'

/** Fictional evidence document with claims and a token that must be redacted. */
export const ISSUED_CREDENTIAL = {
  vct: 'urn:example:attestbook:pid:1',
  issuer: 'https://issuer.example.test',
  claims: {
    given_name: 'Mario',
    family_name: 'Rossi',
    birthdate: '1990-01-02',
    nationalities: ['IT'],
  },
  access_token: 'sensitive-access-token-value',
}

export function inlineArtifact(
  document: unknown = ISSUED_CREDENTIAL,
  mediaType = 'application/json',
): Record<string, unknown> {
  const content = JSON.stringify(document)
  return {
    mediaType,
    encoding: 'utf8',
    content,
    byteLength: new TextEncoder().encode(content).byteLength,
  }
}

export function integrityOf(content: string): Record<string, unknown> {
  return {
    algorithm: 'sha256',
    digest: sha256Hex(new TextEncoder().encode(content)),
  }
}

export function sha256Of(content: string): string {
  return sha256Hex(new TextEncoder().encode(content))
}

/** A capture-issuer envelope carrying an inline artifact. */
export function issuerEnvelope(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const artifact = inlineArtifact()
  return {
    kind: CAPTURE_ARTIFACT_KIND,
    envelopeVersion: CAPTURE_ENVELOPE_VERSION,
    captureId: 'capture-issuer-0001',
    correlationId: 'credimi-execution-0001',
    sourceComponent: 'capture-issuer',
    sourceVersion: '0.4.0',
    capturedAt: CAPTURED_AT,
    interactionType: 'issuance',
    protocol: 'openid4vci',
    credentialFormat: 'dc+sd-jwt',
    artifactType: 'issued-credential',
    artifact,
    party: {
      role: 'issuer',
      identifier: 'https://issuer.example.test',
      name: 'Example Issuer',
    },
    testExecutionRef: 'credimi-execution-0001',
    integrity: integrityOf(String(artifact.content)),
    metadata: { environment: 'mock', attempt: 1 },
    ...overrides,
  }
}

/** A capture-verifier envelope that keeps its artifact external. */
export function verifierEnvelope(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    kind: CAPTURE_ARTIFACT_KIND,
    envelopeVersion: CAPTURE_ENVELOPE_VERSION,
    captureId: 'capture-verifier-0001',
    correlationId: 'credimi-execution-0002',
    sourceComponent: 'capture-verifier',
    sourceVersion: '0.4.0',
    capturedAt: '2026-11-05T10:48:23+01:00',
    interactionType: 'presentation',
    protocol: 'openid4vp',
    credentialFormat: 'dc+sd-jwt',
    artifactType: 'presentation-submission',
    artifactRef: {
      uri: 'https://artifacts.example.test/captures/presentation-0001.json',
      mediaType: 'application/json',
      byteLength: 512,
    },
    party: {
      role: 'verifier',
      identifier: 'https://verifier.example.test',
      name: 'Example Verifier',
    },
    testExecutionRef: 'credimi-execution-0002',
    integrity: {
      algorithm: 'sha256',
      digest: 'a'.repeat(64),
    },
    metadata: { environment: 'mock' },
    ...overrides,
  }
}

/** Serializes an envelope fixture as the UTF-8 bytes a submission would carry. */
export function envelopeBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

/**
 * Runs `run` and returns the `CaptureError` it throws; fails the test when it
 * throws nothing or a different error.
 */
export function captureErrorFrom(run: () => unknown): CaptureError {
  try {
    run()
  } catch (error) {
    if (error instanceof CaptureError) {
      return error
    }
    throw error
  }
  throw new Error('expected the capture pipeline to reject the input')
}
