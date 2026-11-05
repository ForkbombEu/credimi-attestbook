// Wire-profile identity and the pinned baseline enumerations.
//
// Enumerated values are exported as arrays rather than TypeScript unions so the
// adapter can accept and report values from a newer revision of the standard
// (decision D-5) while still validating membership against the pinned baseline.

import { fail, invalidInput, ok, type AdapterResult } from './diagnostics'
import { OWF_PROFILE, TS11_PROFILE, type SupportedProfile } from './model'

export const TS11_FORMAT_VALUES = [
  'dc+sd-jwt',
  'mso_mdoc',
  'jwt_vc_json',
  'jwt_vc_json-ld',
  'ldp_vc',
] as const

export const TS11_ATTESTATION_LOS_VALUES = [
  'iso_18045_high',
  'iso_18045_moderate',
  'iso_18045_enhanced-basic',
  'iso_18045_basic',
] as const

export const TS11_BINDING_TYPE_VALUES = ['claim', 'key', 'biometric', 'none'] as const

export const TS11_FRAMEWORK_TYPE_VALUES = ['aki', 'etsi_tl', 'openid_federation'] as const

export const OWF_FORMAT_VALUES = ['dc+sd-jwt', 'mso_mdoc'] as const

export const OWF_ATTESTATION_LOS_VALUES = TS11_ATTESTATION_LOS_VALUES

export const OWF_BINDING_TYPE_VALUES = TS11_BINDING_TYPE_VALUES

export const OWF_FRAMEWORK_TYPE_VALUES = ['etsi_tl', 'x509'] as const

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function hasOwfSchemaUriCue(record: Record<string, unknown>): boolean {
  const schemaURIs = record.schemaURIs
  if (!Array.isArray(schemaURIs)) {
    return false
  }
  return schemaURIs.some(
    (entry) => isRecord(entry) && (hasOwn(entry, 'integrity') || hasOwn(entry, 'meta')),
  )
}

/**
 * Recognises the profile of a SchemaMeta document from members that are
 * mandatory in one baseline and absent from the other:
 *
 * - OWF 0.5.4 requires `rulebookIntegrity` and per-schema `integrity`/`meta`.
 * - TS11 v1.0.1 requires `supportedFormats` and has no per-schema `meta`.
 */
export function detectProfile(document: unknown): AdapterResult<SupportedProfile> {
  if (!isRecord(document)) {
    return fail([
      invalidInput('invalid_schema_meta', 'a SchemaMeta document must be a JSON object'),
    ])
  }

  const owfCue = hasOwn(document, 'rulebookIntegrity') || hasOwfSchemaUriCue(document)
  const ts11Cue = hasOwn(document, 'supportedFormats')

  if (owfCue && ts11Cue) {
    return fail([
      invalidInput(
        'ambiguous_profile',
        'the document carries both OWF 0.5.4 and TS11 v1.0.1 discriminators',
      ),
    ])
  }
  if (owfCue) {
    return ok(OWF_PROFILE)
  }
  if (ts11Cue) {
    return ok(TS11_PROFILE)
  }

  const schemaMetaLikeMembers = [
    'version',
    'rulebookURI',
    'schemaURIs',
    'attestationLoS',
    'bindingType',
  ]
  if (schemaMetaLikeMembers.some((member) => hasOwn(document, member))) {
    // Missing discriminators are more useful as TS11 validation errors than as
    // "unknown profile": the TS11 parser names the missing required members.
    return ok(TS11_PROFILE)
  }

  return fail([
    invalidInput(
      'unknown_profile',
      'the document is neither a TS11 v1.0.1 nor an OWF 0.5.4 SchemaMeta document',
    ),
  ])
}
