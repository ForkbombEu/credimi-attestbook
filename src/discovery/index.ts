// Public surface of the AttestBook issuer discovery adapter (FR-006, issue #43).
//
// See docs/discovery.md for the supported OpenID4VCI metadata shapes, the
// bounded retrieval controls, the association policy and its limitations.

export {
  IssuerDiscovery,
  ISSUER_DISCOVERY_LIMITATIONS,
  type IssuerDiscoveryOptions,
  type IssuerDiscoveryService,
} from './discover'

export {
  buildIssuerMetadataTarget,
  extractIssuerMetadata,
  ISSUER_METADATA_WELL_KNOWN_PATH,
  MAX_AUTHORIZATION_SERVERS,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_ISSUER_CONFIGURATIONS,
  MAX_SCHEMA_REFERENCES_PER_CONFIGURATION,
  MAX_TYPE_IDENTIFIERS_PER_CONFIGURATION,
  type ExtractedIssuerMetadata,
  type IssuerMetadataTarget,
} from './metadata'

export { buildRulebookMappingIndex, mapConfiguration, type RulebookVersionSource } from './mapping'

export {
  CONFIGURATION_MAPPING_STATUSES,
  CONFIGURATION_SCHEMA_SOURCES,
  CONFIGURATION_TYPE_IDENTIFIER_KINDS,
  ISSUER_METADATA_SHAPES,
  type ConfigurationMapping,
  type ConfigurationMappingStatus,
  type ConfigurationSchemaSource,
  type ConfigurationTypeIdentifier,
  type ConfigurationTypeIdentifierKind,
  type DiscoveredCredentialConfiguration,
  type DiscoveredSchemaReference,
  type IssuerCredentialConfiguration,
  type IssuerDiscoveryDiagnostic,
  type IssuerDiscoveryResult,
  type IssuerDiscoverySource,
  type IssuerDiscoverySummary,
  type IssuerMetadataShape,
  type IssuerMetadataSummary,
  type RulebookMappingIndex,
  type RulebookVersionCandidate,
  type RulebookVersionPin,
} from './types'
