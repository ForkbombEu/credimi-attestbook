// Public surface of the AttestBook registry module (issue #28).
//
// See docs/registry.md for the stable-identifier, standards-metadata-boundary
// and authorization rules that this module implements.

export { Registry, type RegistryOptions } from './registry'

export { provisionProvider, type ProvisioningOptions } from './bootstrap'

export { AUTH_TOKEN_HASH_LENGTH, generateBearerToken, hashBearerToken } from './tokens'

export {
  conflict,
  forbidden,
  immutable,
  invalidInput,
  isRegistryError,
  notFound,
  RegistryError,
  unauthorized,
  type RegistryErrorCode,
} from './errors'

export {
  AUDIT_ACTIONS,
  PUBLICATION_STATUSES,
  type AttestationType,
  type AuditAction,
  type AuditEntry,
  type AuthenticatedActor,
  type AuthTokenRecord,
  type CreateAttestationInput,
  type CreateRulebookInput,
  type CreateSchemaReferenceInput,
  type IssuedToken,
  type JsonObject,
  type Provider,
  type ProvisionedProvider,
  type ProvisionProviderInput,
  type PublicationStatus,
  type Rulebook,
  type RulebookFilter,
  type SchemaReference,
  type UpdateAttestationInput,
  type UpdateProviderInput,
  type UpdateRulebookInput,
  type UpdateSchemaReferenceInput,
} from './types'

export {
  MAX_ATTESTATIONS_PER_RULEBOOK,
  MAX_DESCRIPTION_LENGTH,
  MAX_ID_LENGTH,
  MAX_INTEGRITY_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_METADATA_BYTES,
  MAX_NAME_LENGTH,
  MAX_SPEC_LENGTH,
  MAX_STRING_ARRAY_ITEMS,
  MAX_TEXT_LENGTH,
  MAX_URL_LENGTH,
} from './validation'
