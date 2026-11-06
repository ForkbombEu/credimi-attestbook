// Public surface of the AttestBook credential-validation module (issue #32).
//
// See docs/validation.md for the executed dimensions, the pinned-rulebook
// evidence, the supplied-schema-document rule and the honest non-claims.

export { CredentialValidator, type CredentialValidatorOptions } from './engine'

export {
  MAX_ATTESTATION_TYPE_LENGTH,
  MAX_CREDENTIAL_LENGTH,
  MAX_SCHEMA_DOCUMENT_LENGTH,
  MAX_SCHEMA_DOCUMENTS,
  MAX_SCHEMA_URI_LENGTH,
  parseValidateCredentialInput,
} from './request'

export { aggregateStatus } from './status'

export {
  assertDimensionCatalogue,
  assertDimensionConsistency,
  createDimension,
  DIMENSION_DEFINITIONS,
  dimensionDefinition,
  DimensionConsistencyError,
  limitationsFromDimensions,
  type DimensionApplicability,
  type DimensionDefinition,
  type DimensionInput,
  type DimensionOwner,
} from './dimensions'

export {
  detectCredentialFormat,
  recognizeCredentialFormat,
  STRUCTURAL_PARSER_FORMATS,
  type CredentialArtifact,
  type FormatRecognition,
  type StructuralParserFormat,
} from './format'

export { CREDENTIAL_VALIDATION_PATH, type CredentialValidationService } from './service'

export {
  VALIDATION_DIMENSIONS,
  VALIDATION_SEVERITIES,
  VALIDATION_STATUSES,
  type AttestationEvidence,
  type CredentialArtifactInput,
  type CredentialEvidence,
  type CredentialValidationResult,
  type RulebookEvidence,
  type RulebookValidationSource,
  type SchemaDocumentInput,
  type SchemaReferenceEvidence,
  type ValidateCredentialInput,
  type ValidationDimension,
  type ValidationDimensionEvidence,
  type ValidationDimensionId,
  type ValidationEvidenceValue,
  type ValidationFinding,
  type ValidationLimitation,
  type ValidationSeverity,
  type ValidationStatus,
} from './types'
