// Public surface of the normalized capture artifact envelope (FR-015/FR-018,
// issue #46).
//
// See docs/capture.md for the versioned envelope contract, validation rules,
// secure-reference boundary, redaction policy and explicit limitations. The
// module is transport-agnostic: it validates and normalizes a submission and
// performs no network request or persistence. Mock and push/pull adapters are
// added separately (#47).

export {
  CAPTURE_ARTIFACT_ENCODINGS,
  CAPTURE_ARTIFACT_KIND,
  CAPTURE_ARTIFACT_TYPES,
  CAPTURE_CREDENTIAL_FORMATS,
  CAPTURE_ENVELOPE_VERSION,
  CAPTURE_INTEGRITY_ALGORITHMS,
  CAPTURE_INTERACTION_TYPES,
  CAPTURE_PROTOCOLS,
  CAPTURE_REDACTION_STATUSES,
  CAPTURE_SOURCE_COMPONENTS,
  type CaptureArtifact,
  type CaptureArtifactEncoding,
  type CaptureArtifactReference,
  type CaptureArtifactType,
  type CaptureCredentialFormat,
  type CaptureDiagnostic,
  type CaptureIntegrity,
  type CaptureInteractionType,
  type CaptureMetadataValue,
  type CaptureParty,
  type CaptureProtocol,
  type CaptureProvenance,
  type CaptureRawArtifact,
  type CaptureRedaction,
  type CaptureRedactionStatus,
  type CaptureSourceComponent,
  type NormalizedCaptureArtifact,
  type RedactedCaptureArtifact,
} from './types'

export {
  DEFAULT_CAPTURE_LIMITS,
  resolveCaptureLimits,
  type CaptureLimitOverrides,
  type CaptureLimits,
} from './limits'

export { CaptureError, isCaptureError, type CaptureErrorCode } from './errors'

export {
  CaptureNormalizer,
  normalizeCaptureArtifact,
  parseCaptureArtifact,
  type CaptureNormalizerOptions,
} from './normalize'

export {
  assertBoundedJsonValue,
  encodeCaptureText,
  parseBoundedCaptureJson,
  type ParsedCaptureDocument,
} from './json'

export {
  CAPTURE_REDACTION_PLACEHOLDER,
  DEFAULT_CAPTURE_REDACTION_POLICY_REF,
  DEFAULT_PRESERVED_CAPTURE_KEYS,
  DEFAULT_SENSITIVE_CAPTURE_KEYS,
  captureJsonPointerSegment,
  redactCaptureDocument,
  redactNormalizedCaptureArtifact,
  type CaptureRedactedDocument,
  type CaptureRedactionMode,
  type CaptureRedactionPolicy,
} from './redaction'

// Push/pull transport adapter contracts and the deterministic mock source
// (FR-018, issue #47). Only the mock transport is implemented; no live
// capture-issuer/capture-verifier connector exists.
export {
  CAPTURE_ADAPTER_TRANSPORTS,
  CAPTURE_MOCK_FAULTS,
  CaptureAdapterError,
  DEFAULT_MAX_ACCEPTED_CAPTURES,
  DEFAULT_MOCK_BATCH_SIZE,
  MAX_CAPTURE_CREDENTIAL_LENGTH,
  MockCaptureSource,
  captureAdapterError,
  hashCaptureCredential,
  isCaptureAdapterError,
  isCaptureCredentialHash,
  mockCaptureEnvelopes,
  verifyCaptureCredential,
  verifyCaptureCredentialHash,
  type CaptureAdapterErrorCode,
  type CaptureAdapterTransport,
  type CaptureMockFault,
  type CapturePullAdapter,
  type CapturePullRequest,
  type CapturePullResult,
  type CapturePushAdapter,
  type CapturePushResult,
  type CapturePushSubmission,
  type CaptureSource,
  type MockCaptureSourceOptions,
} from './adapters'

// Capture explorer read model and pinned-rulebook correlation (FR-019,
// UI-006, issue #48). Reads are mock-backed: the server builds the explorer
// from deterministic mock sources and no live capture endpoint is contacted.
export {
  CAPTURE_EVIDENCE_GAP_CODES,
  CAPTURE_EXPLORER_LIMITATIONS,
  CAPTURE_TIMELINE_EVENT_KINDS,
  CAPTURE_VALIDATABLE_ARTIFACT_TYPES,
  CaptureExplorer,
  DEFAULT_CAPTURE_PAGE_LIMIT,
  MAX_CAPTURE_PAGE_LIMIT,
  MAX_CAPTURE_RECORDS,
  MAX_CAPTURE_SOURCE_PAGES,
  createMockCaptureExplorer,
  isCaptureValidatableArtifactType,
  parseCaptureCorrelationInput,
  type CaptureArtifactAvailability,
  type CaptureArtifactProjection,
  type CaptureArtifactSummary,
  type CaptureCorrelationInput,
  type CaptureCorrelationResult,
  type CaptureDeclaredRedaction,
  type CaptureEvidenceGap,
  type CaptureEvidenceGapCode,
  type CaptureExplorerDetail,
  type CaptureExplorerOptions,
  type CaptureExplorerPage,
  type CaptureExplorerSummary,
  type CaptureProvenanceSummary,
  type CaptureRulebookBinding,
  type CaptureSourceSummary,
  type CaptureTimelineEvent,
  type CaptureTimelineEventKind,
  type CaptureValidatableArtifactType,
  type CaptureValidationDimensionSummary,
  type CaptureValidationSummary,
  type MockCaptureExplorerOptions,
} from './explorer'
