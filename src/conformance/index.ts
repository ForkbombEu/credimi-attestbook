// Public surface of the reproducible continuous conformance module (FR-022,
// issue #51).
//
// See docs/conformance.md for the deterministic result contract, the stable
// result-reference scope, the failure classification and the explicit
// non-orchestration / non-conformance boundaries.

export {
  buildConformanceResult,
  conformanceCredentialFormatHint,
  conformanceCredentialText,
  conformanceOutcome,
  CONFORMANCE_RESULT_LIMITATIONS,
  DEFAULT_FAILURE_CLASS,
  FAILURE_CLASS_BY_DIMENSION,
  sha256Text,
  type BuildConformanceResultInput,
} from './result'

export {
  CONFORMANCE_CANONICALIZATION,
  CONFORMANCE_DIGEST_ALGORITHM,
  CONFORMANCE_ENVIRONMENT_FINDING_CODES,
  CONFORMANCE_FAILURE_CLASSES,
  CONFORMANCE_INPUT_FORMAT,
  CONFORMANCE_OUTCOMES,
  CONFORMANCE_REFERENCE_FORMAT,
  CONFORMANCE_REFERENCE_SCOPE,
  CONFORMANCE_RESULT_KIND,
  CONFORMANCE_RESULT_VERSION,
  type ConformanceEnvironmentFindingCode,
  type ConformanceEvidence,
  type ConformanceFailure,
  type ConformanceFailureClass,
  type ConformanceInput,
  type ConformanceOutcome,
  type ConformancePin,
  type ConformanceResult,
  type ConformanceSchemaDocumentDigest,
} from './types'
