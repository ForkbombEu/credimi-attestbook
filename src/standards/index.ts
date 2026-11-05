// Public surface of the AttestBook standards adapter.
//
// Production code imports the adapter from here; the wire codecs stay an
// implementation detail. See docs/standards-adapter.md for the supported
// operations, directional limits and unsupported capabilities.

export {
  diagnostic,
  fail,
  formatDiagnostics,
  hasBlockingDiagnostic,
  hasInvalidInput,
  invalidInput,
  notTested,
  ok,
  preserved,
  unsupportedOperation,
  type AdapterDiagnostic,
  type AdapterFailure,
  type AdapterResult,
  type AdapterSuccess,
  type DiagnosticCode,
  type DiagnosticKind,
} from './diagnostics'

export {
  createAttestBookSchemaMeta,
  OWF_PROFILE,
  productMetadataLeaks,
  SUPPORTED_PROFILES,
  TS11_PROFILE,
  type AttestBookSchemaMeta,
  type CanonicalSchemaMeta,
  type CanonicalSchemaReference,
  type CanonicalTrustAuthority,
  type CanonicalVerificationMethod,
  type OwfSchemaMeta,
  type ProductMetadata,
  type SupportedProfile,
} from './model'

export {
  detectProfile,
  OWF_ATTESTATION_LOS_VALUES,
  OWF_BINDING_TYPE_VALUES,
  OWF_FORMAT_VALUES,
  OWF_FRAMEWORK_TYPE_VALUES,
  TS11_ATTESTATION_LOS_VALUES,
  TS11_BINDING_TYPE_VALUES,
  TS11_FORMAT_VALUES,
  TS11_FRAMEWORK_TYPE_VALUES,
} from './profiles'

export {
  parseSchemaMetaDocument,
  serializeAttestBookSchemaMeta,
  serializeSchemaMeta,
  toOwfSchemaMeta,
  validateSchemaMetaDocument,
  type ParseSchemaMetaOptions,
} from './codec'

export {
  buildOwfSchemaMeta,
  isOwfRepresentable,
  isOwfSchemaMetaDocument,
  parseOwfSchemaMeta,
  serializeOwfSchemaMeta,
} from './owf'

export {
  isTs11Representable,
  parseTs11SchemaMeta,
  serializeAttestBookTs11,
  serializeTs11SchemaMeta,
  type Ts11ParseOptions,
} from './ts11'

export {
  ALLOWED_JWS_ALGORITHMS,
  decodeCompactJws,
  DEFAULT_JWS_ALGORITHM,
  signSchemaMetaJws,
  verifySchemaMetaJws,
  type CompactJwsParts,
  type JwsAlgorithm,
  type JwsHeader,
  type SignedSchemaMetaDocument,
  type SignSchemaMetaOptions,
  type VerifiedSchemaMetaDocument,
  type VerifySchemaMetaOptions,
} from './jose'

export { resolveSchemaMetaReferences, type ResolveSchemaMetaReferencesOptions } from './references'
