// Public surface of the headless-wallet comparison evidence module (FR-021,
// issue #50).
//
// See docs/headless-wallet-comparison.md for the contract, the separation of
// the AttestBook structural/schema evidence from the caller-supplied
// protocol/interoperability observations, and the explicit non-claims.

export {
  ATTESTBOOK_STRUCTURAL_DIMENSIONS,
  buildHeadlessWalletComparison,
  EXTERNAL_COMPARISON_DIMENSIONS,
  EXTERNAL_DIMENSION_GROUPS,
  HEADLESS_WALLET_COMPARISON_LIMITATIONS,
  type BuildHeadlessWalletComparisonInput,
} from './compare'

export {
  MAX_EXTERNAL_OBSERVATION_CODE_LENGTH,
  MAX_EXTERNAL_OBSERVATION_DETAIL_LENGTH,
  MAX_EXTERNAL_OBSERVATION_TIMESTAMP_LENGTH,
  MAX_EXTERNAL_WALLET_ID_LENGTH,
  MAX_EXTERNAL_WALLET_OBSERVATIONS,
  parseCompareCaptureInput,
  parseExternalWalletObservation,
  type CompareCaptureInput,
} from './input'

export {
  COMPARISON_RESULTS,
  EXTERNAL_WALLET_INTERACTIONS,
  HEADLESS_WALLET_COMPARISON_KIND,
  HEADLESS_WALLET_COMPARISON_VERSION,
  UNSUPPORTED_COMPARISON_CODES,
  type ComparisonDimensionEntry,
  type ComparisonEvidenceSource,
  type ComparisonResult,
  type ExternalDimensionObservation,
  type ExternalWalletInteraction,
  type ExternalWalletObservation,
  type HeadlessWalletComparisonReport,
  type UnsupportedComparison,
  type UnsupportedComparisonCode,
} from './types'
