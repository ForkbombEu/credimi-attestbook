// Public surface of the rulebook-driven verifier constraints module
// (FR-014, #45).
//
// See docs/verifier.md for the typed constraint contract, the partial
// OpenID4VP DCQL mapping and the explicit unsupported-mapping rules.

export {
  assertBoundedDocument,
  classifySchemaDocument,
  inspectJsonSchema,
  MAX_INSPECTED_DOCUMENT_DEPTH,
  MAX_INSPECTED_DOCUMENT_NODES,
  MAX_VERIFIER_ATTRIBUTES,
  type InspectedObjectLimitation,
  type SchemaInspection,
} from './inspect'

export { buildDcqlMapping, buildPolicyInterfaces } from './mapping'

export { parseResolveVerifierConstraintsInput } from './request'

export { VerifierPolicyResolver } from './resolve'

export {
  VERIFIER_CONSTRAINTS_KIND,
  VERIFIER_CONSTRAINTS_PATH,
  VERIFIER_GROUNDING_STATUSES,
  VERIFIER_MAPPING_SCOPES,
  VERIFIER_POLICY_INTERFACES,
  VERIFIER_POLICY_INTERFACE_STATUSES,
  type ResolveVerifierConstraintsInput,
  type VerifierAttestationEvidence,
  type VerifierAttributeConstraint,
  type VerifierConstraintsResult,
  type VerifierDcqlMapping,
  type VerifierFormatPolicy,
  type VerifierGroundingStatus,
  type VerifierMappingScope,
  type VerifierNonClaims,
  type VerifierPolicyDiagnostic,
  type VerifierPolicyInterface,
  type VerifierPolicyInterfaceId,
  type VerifierPolicyInterfaceStatus,
  type VerifierPolicyService,
  type VerifierPolicySource,
  type VerifierRulebookEvidence,
  type VerifierSchemaReferenceEvidence,
  type VerifierUnsupportedConstraint,
  type VerifierUnsupportedMapping,
} from './types'
