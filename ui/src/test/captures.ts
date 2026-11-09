// Capture explorer fixtures for component tests (issue #48).

import { CatalogApiError, type CaptureExplorerApi } from '../api'
import type {
  CaptureCorrelationResult,
  CaptureExplorerDetail,
  CaptureExplorerPage,
  CaptureExplorerSummary,
  CorrelateCaptureRequest,
  CredentialValidationResult,
} from '../types'

import { makeValidationResult } from './fixtures'

export function makeCaptureSummary(
  overrides: Partial<CaptureExplorerSummary> = {},
): CaptureExplorerSummary {
  return {
    captureId: 'mock-capture-capture-issuer-3',
    correlationId: 'mock-correlation-3',
    kind: 'attestbook.capture-artifact@1',
    envelopeVersion: 1,
    source: {
      sourceId: 'mock-capture-issuer',
      component: 'capture-issuer',
      transport: 'mock',
      description:
        'Deterministic local mock fixtures for capture-issuer; no live capture endpoint is contacted',
    },
    provenance: {
      sourceComponent: 'capture-issuer',
      sourceVersion: '0.0.0-mock',
      capturedAt: '2026-11-05T09:50:23Z',
      capturedAtMs: Date.parse('2026-11-05T09:50:23Z'),
      receivedAt: '2026-11-09T10:00:00.000Z',
      receivedAtMs: Date.parse('2026-11-09T10:00:00.000Z'),
    },
    interactionType: 'issuance',
    protocol: 'openid4vci',
    credentialFormat: 'dc+sd-jwt',
    artifactType: 'issued-credential',
    party: {
      role: 'issuer',
      identifier: 'https://issuer.example.test',
      name: 'Example Issuer (mock)',
    },
    testExecutionRef: 'mock-execution-3',
    integrity: { algorithm: 'sha256', digest: 'b'.repeat(64), verified: true },
    declaredRedaction: {
      status: 'none',
      policyRef: null,
      redactedPaths: [],
      redactedDigest: null,
    },
    artifact: {
      availability: 'inline',
      mediaType: 'application/json',
      byteLength: 180,
      uri: null,
    },
    rulebook: null,
    validation: null,
    evidenceGaps: [
      {
        code: 'no_rulebook_binding',
        message: 'This capture is not bound to a rulebook version yet.',
      },
      {
        code: 'validation_not_run',
        message: 'No validation has been recorded for this capture.',
      },
    ],
    evidenceComplete: false,
    ...overrides,
  }
}

export function makeCaptureDetail(
  overrides: Partial<CaptureExplorerDetail> = {},
): CaptureExplorerDetail {
  return {
    ...makeCaptureSummary(),
    metadata: { environment: 'mock', synthetic: true },
    artifactProjection: {
      mediaType: 'application/json',
      encoding: 'utf8',
      byteLength: 160,
      digest: 'c'.repeat(64),
      redaction: {
        status: 'partial',
        policyRef: 'attestbook.default-capture-redaction@1',
        redactedPaths: ['/claims', '/access_token'],
        redactedDigest: 'c'.repeat(64),
      },
      document: {
        vct: 'urn:example:attestbook:mock:pid:1',
        issuer: 'https://issuer.example.test',
        claims: '[redacted]',
        access_token: '[redacted]',
      },
      diagnostics: [],
    },
    validationResult: null,
    timeline: [
      {
        kind: 'captured',
        at: '2026-11-05T09:50:23Z',
        label: 'Evidence captured',
        detail: 'capture-issuer 0.0.0-mock',
      },
      {
        kind: 'received',
        at: '2026-11-09T10:00:00.000Z',
        label: 'Received and normalized',
        detail: 'AttestBook receipt timestamp; the source asserted capturedAt itself.',
      },
    ],
    limitations: [
      'The capture explorer is backed by the deterministic local mock source.',
      'A structural validation status never implies cryptographic, issuer-trust, protocol or interoperability success.',
    ],
    ...overrides,
  }
}

export function makeBoundCaptureDetail(
  validation: CredentialValidationResult = makeValidationResult(),
  overrides: Partial<CaptureExplorerDetail> = {},
): CaptureExplorerDetail {
  return makeCaptureDetail({
    rulebook: {
      rulebookId: validation.rulebook.id,
      rulebookName: validation.rulebook.name,
      version: validation.rulebook.version,
      contentDigest: validation.rulebook.digest,
      digestVerified: true,
      specVersion: validation.rulebook.specVersion,
      rulebookStatus: validation.rulebook.status,
      attestationType: validation.attestation.name,
      boundAt: '2026-11-09T10:01:00.000Z',
    },
    validation: {
      validationId: validation.validationId,
      validatedAt: validation.validatedAt,
      overallStatus: validation.overallStatus,
      violations: validation.violations.length,
      limitations: validation.limitations.length,
      dimensions: validation.dimensions.map((dimension) => ({
        id: dimension.id,
        status: dimension.status,
        applicable: dimension.applicable,
        executed: dimension.executed,
      })),
    },
    validationResult: validation,
    evidenceGaps: [],
    evidenceComplete: true,
    timeline: [
      {
        kind: 'captured',
        at: '2026-11-05T09:50:23Z',
        label: 'Evidence captured',
        detail: 'capture-issuer 0.0.0-mock',
      },
      {
        kind: 'received',
        at: '2026-11-09T10:00:00.000Z',
        label: 'Received and normalized',
        detail: 'AttestBook receipt timestamp; the source asserted capturedAt itself.',
      },
      {
        kind: 'bound',
        at: '2026-11-09T10:01:00.000Z',
        label: 'Bound to pinned rulebook version',
        detail: 'PID Rulebook 1.0 · Person Identification Data',
      },
      {
        kind: 'validated',
        at: validation.validatedAt,
        label: 'Validation recorded',
        detail: `${validation.overallStatus}`,
      },
    ],
    ...overrides,
  })
}

export function makeCaptureCorrelation(
  detail: CaptureExplorerDetail,
  validation: CredentialValidationResult = makeValidationResult(),
): CaptureCorrelationResult {
  if (detail.rulebook === null) {
    throw new Error('a correlated capture must carry a rulebook binding')
  }
  return {
    captureId: detail.captureId,
    correlationId: detail.correlationId,
    testExecutionRef: detail.testExecutionRef,
    rulebook: detail.rulebook,
    validation,
  }
}

export interface FakeCaptureApi extends CaptureExplorerApi {
  readonly correlated: {
    readonly captureId: string
    readonly request: CorrelateCaptureRequest
    readonly token: string
  }[]
}

export function createFakeCaptureApi(
  detail: CaptureExplorerDetail = makeCaptureDetail(),
): FakeCaptureApi {
  const correlated: {
    captureId: string
    request: CorrelateCaptureRequest
    token: string
  }[] = []
  return {
    correlated,
    listCaptures(): Promise<CaptureExplorerPage> {
      return Promise.resolve({
        data: [detail],
        pagination: { limit: 100, offset: 0, total: 1 },
      })
    },
    getCapture(captureId: string): Promise<CaptureExplorerDetail> {
      return captureId === detail.captureId
        ? Promise.resolve(detail)
        : Promise.reject(new CatalogApiError('The requested capture does not exist.', 404))
    },
    correlateCapture(
      captureId: string,
      request: CorrelateCaptureRequest,
      token: string,
    ): Promise<CaptureCorrelationResult> {
      correlated.push({ captureId, request, token })
      return Promise.resolve(
        makeCaptureCorrelation(makeBoundCaptureDetail(), makeValidationResult()),
      )
    },
  }
}
