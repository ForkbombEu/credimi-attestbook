// Deterministic synthetic capture envelopes for the mock adapters
// (FR-018, issue #47).
//
// These fixtures are labelled `mock`/`synthetic` in their metadata and carry
// only obviously fictional values. They never represent a live
// `capture-issuer`/`capture-verifier` interaction: the mock source in `mock.ts`
// serves them from memory and performs no network request. Every artifact type
// the version 1 envelope defines is covered so normalization is exercised on
// the full matrix, including one inline artifact per component (segregated as
// sensitive) and external references (whose digest stays explicitly
// unverified).

import { sha256Hex } from '../../registry/digest'
import { CAPTURE_ARTIFACT_KIND, CAPTURE_ENVELOPE_VERSION } from '../types'
import type { CaptureSourceComponent } from '../types'

const CAPTURED_AT_BASE_MS = Date.UTC(2026, 10, 5, 9, 48, 23)

/** Fictional evidence that normalization must keep out of the envelope. */
const SYNTHETIC_ISSUED_CREDENTIAL = {
  vct: 'urn:example:attestbook:mock:pid:1',
  issuer: 'https://issuer.example.test',
  claims: {
    given_name: 'Test',
    family_name: 'Person',
    birthdate: '1990-01-02',
    nationalities: ['IT'],
  },
  access_token: 'synthetic-access-token-not-a-secret',
}

const SYNTHETIC_ERROR_RESPONSE = {
  error: 'invalid_request',
  error_description: 'synthetic mock error response',
  status: 400,
}

const SYNTHETIC_PRESENTATION_SUBMISSION = {
  presentation_submission: {
    id: 'mock-presentation-0001',
    definition_id: 'mock-definition',
    descriptor_map: [{ id: 'pid', format: 'dc+sd-jwt', path: '$' }],
  },
  vp_token: 'synthetic-vp-token-not-a-secret',
}

function capturedAt(offsetSeconds: number): string {
  return new Date(CAPTURED_AT_BASE_MS + offsetSeconds * 1_000).toISOString()
}

function inlineArtifact(document: unknown): {
  readonly artifact: Record<string, unknown>
  readonly integrity: Record<string, unknown>
} {
  const content = JSON.stringify(document)
  const bytes = new TextEncoder().encode(content)
  return {
    artifact: {
      mediaType: 'application/json',
      encoding: 'utf8',
      content,
      byteLength: bytes.byteLength,
    },
    integrity: { algorithm: 'sha256', digest: sha256Hex(bytes) },
  }
}

function externalArtifact(uri: string): {
  readonly artifactRef: Record<string, unknown>
  readonly integrity: Record<string, unknown>
} {
  return {
    artifactRef: { uri, mediaType: 'application/json', byteLength: 512 },
    // A declared digest only: the mock source never fetches the reference, so
    // normalization must report it unverified.
    integrity: { algorithm: 'sha256', digest: sha256Hex(new TextEncoder().encode(uri)) },
  }
}

interface FixtureFields {
  readonly artifactType: string
  readonly interactionType: 'issuance' | 'presentation' | 'error'
  readonly protocol: 'openid4vci' | 'openid4vp'
  /** Exactly one of these two is supplied, mirroring the envelope contract. */
  readonly artifact?: Record<string, unknown>
  readonly artifactRef?: Record<string, unknown>
  readonly integrity: Record<string, unknown>
}

function fixtureEnvelope(
  component: CaptureSourceComponent,
  index: number,
  fields: FixtureFields,
): Record<string, unknown> {
  const role = component === 'capture-issuer' ? 'issuer' : 'verifier'
  return {
    kind: CAPTURE_ARTIFACT_KIND,
    envelopeVersion: CAPTURE_ENVELOPE_VERSION,
    captureId: `mock-capture-${component}-${index + 1}`,
    correlationId: `mock-correlation-${index + 1}`,
    sourceComponent: component,
    sourceVersion: '0.0.0-mock',
    capturedAt: capturedAt(index * 60),
    interactionType: fields.interactionType,
    protocol: fields.protocol,
    credentialFormat: 'dc+sd-jwt',
    artifactType: fields.artifactType,
    ...(fields.artifact === undefined ? {} : { artifact: fields.artifact }),
    ...(fields.artifactRef === undefined ? {} : { artifactRef: fields.artifactRef }),
    party: {
      role,
      identifier: `https://${role}.example.test`,
      name: `Example ${role === 'issuer' ? 'Issuer' : 'Verifier'} (mock)`,
    },
    testExecutionRef: `mock-execution-${index + 1}`,
    integrity: fields.integrity,
    metadata: {
      environment: 'mock',
      synthetic: true,
      fixture: fields.artifactType,
    },
  }
}

/**
 * Deterministic, synthetic envelopes for one capture component. The caller
 * must treat them as untrusted input: the mock source normalizes them exactly
 * like a remote submission, which is what exercises the pipeline.
 */
export function mockCaptureEnvelopes(
  component: CaptureSourceComponent,
): readonly Record<string, unknown>[] {
  if (component === 'capture-issuer') {
    return [
      fixtureEnvelope(component, 0, {
        artifactType: 'issuer-metadata',
        interactionType: 'issuance',
        protocol: 'openid4vci',
        ...externalArtifact('https://artifacts.example.test/mock/issuer-metadata.json'),
      }),
      fixtureEnvelope(component, 1, {
        artifactType: 'credential-offer',
        interactionType: 'issuance',
        protocol: 'openid4vci',
        ...externalArtifact('https://artifacts.example.test/mock/credential-offer.json'),
      }),
      fixtureEnvelope(component, 2, {
        artifactType: 'issued-credential',
        interactionType: 'issuance',
        protocol: 'openid4vci',
        ...inlineArtifact(SYNTHETIC_ISSUED_CREDENTIAL),
      }),
      fixtureEnvelope(component, 3, {
        artifactType: 'error-response',
        interactionType: 'error',
        protocol: 'openid4vci',
        ...inlineArtifact(SYNTHETIC_ERROR_RESPONSE),
      }),
    ]
  }
  return [
    fixtureEnvelope(component, 0, {
      artifactType: 'presentation-request',
      interactionType: 'presentation',
      protocol: 'openid4vp',
      ...externalArtifact('https://artifacts.example.test/mock/presentation-request.json'),
    }),
    fixtureEnvelope(component, 1, {
      artifactType: 'presentation-submission',
      interactionType: 'presentation',
      protocol: 'openid4vp',
      ...inlineArtifact(SYNTHETIC_PRESENTATION_SUBMISSION),
    }),
    fixtureEnvelope(component, 2, {
      artifactType: 'verification-outcome',
      interactionType: 'presentation',
      protocol: 'openid4vp',
      ...externalArtifact('https://artifacts.example.test/mock/verification-outcome.json'),
    }),
  ]
}
