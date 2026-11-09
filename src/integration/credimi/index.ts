// Public surface of the standalone Credimi integration adapter (FR-020,
// issue #49).
//
// The adapter is an HTTP client for AttestBook's public `/api/v1` API. It
// carries no Credimi runtime dependency: no Temporal, StepCI or PocketBase
// client, and no access to AttestBook's database. See
// `docs/credimi-integration.md` for the wire contract, the pin verification
// rules, the error codes and the retry/timeout policy.

export {
  CredimiAdapter,
  createCredimiAdapter,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_PAGE_LIMIT,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_PAGE_LIMIT,
  MAX_RESPONSE_BYTES,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  type CredimiAdapterOptions,
} from './client'

export {
  assertPinnedCorrelation,
  assertPinnedValidation,
  CREDIMI_ADAPTER_CONTRACT_VERSION,
  credimiRulebookPinSchema,
  RULEBOOK_PIN_KIND,
  type CredimiAttestation,
  type CredimiCaptureDetail,
  type CredimiCapturePage,
  type CredimiCaptureQuery,
  type CredimiCaptureSummary,
  type CredimiCorrelationInput,
  type CredimiCredentialInput,
  type CredimiEvidenceCorrelation,
  type CredimiRulebook,
  type CredimiRulebookPage,
  type CredimiRulebookPin,
  type CredimiRulebookQuery,
  type CredimiRulebookVersion,
  type CredimiSchemaDocumentInput,
  type CredimiValidationEvidence,
  type CredimiValidationInput,
  type PinRulebookInput,
} from './contracts'

export {
  CREDIMI_ADAPTER_ERROR_CODES,
  CredimiAdapterError,
  isCredimiAdapterError,
  type CredimiAdapterErrorCode,
  type CredimiAdapterErrorOptions,
} from './errors'
