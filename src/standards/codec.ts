// Orchestration across the TS11 v1.0.1 and OWF 0.5.4 codecs.

import {
  fail,
  ok,
  unsupportedOperation,
  type AdapterDiagnostic,
  type AdapterResult,
} from './diagnostics'
import {
  SUPPORTED_PROFILES,
  TS11_PROFILE,
  type AttestBookSchemaMeta,
  type CanonicalSchemaMeta,
  type SupportedProfile,
} from './model'
import { buildOwfSchemaMeta, parseOwfSchemaMeta, serializeOwfSchemaMeta } from './owf'
import { detectProfile } from './profiles'
import { parseTs11SchemaMeta, serializeTs11SchemaMeta } from './ts11'

export interface ParseSchemaMetaOptions {
  /**
   * `auto` detects the profile from the document. An explicit profile is used
   * for caller-selected wire contracts and is reported as unsupported when it
   * is not one of the two pinned profiles.
   */
  readonly profile?: SupportedProfile | 'auto'
  /** Validate strictness against the pinned baseline instead of preserving additions. */
  readonly baselineStrict?: boolean
}

function assertSupportedProfile(profile: SupportedProfile | 'auto'): AdapterDiagnostic | undefined {
  if (profile === 'auto' || SUPPORTED_PROFILES.includes(profile)) {
    return undefined
  }
  return unsupportedOperation(
    'unsupported_profile',
    `supported profiles are ${SUPPORTED_PROFILES.join(', ')}; "${String(profile)}" is not implemented`,
  )
}

/**
 * Parses a SchemaMeta document into the canonical model. Profile detection is
 * explicit: OWF 0.5.4 documents are validated by the real OWF package, TS11
 * v1.0.1 documents by AttestBook's narrow translation extension.
 */
export function parseSchemaMetaDocument(
  document: unknown,
  options: ParseSchemaMetaOptions = {},
): AdapterResult<CanonicalSchemaMeta> {
  const requested = options.profile ?? 'auto'
  const unsupported = assertSupportedProfile(requested)
  if (unsupported !== undefined) {
    return fail([unsupported])
  }

  let profile: SupportedProfile
  const diagnostics: AdapterDiagnostic[] = []

  if (requested === 'auto') {
    const detected = detectProfile(document)
    if (!detected.ok) {
      return detected
    }
    profile = detected.value
    diagnostics.push(...detected.diagnostics)
  } else {
    profile = requested
  }

  const parsed =
    profile === TS11_PROFILE
      ? parseTs11SchemaMeta(document, {
          ...(options.baselineStrict !== undefined
            ? { baselineStrict: options.baselineStrict }
            : {}),
        })
      : parseOwfSchemaMeta(document)

  if (!parsed.ok) {
    return fail([...diagnostics, ...parsed.diagnostics])
  }
  return ok(parsed.value, [...diagnostics, ...parsed.diagnostics])
}

/**
 * Strict validation against the pinned baseline. Unlike `parseSchemaMetaDocument`
 * this rejects members and enumerated values outside the pinned revision instead
 * of preserving them.
 */
export function validateSchemaMetaDocument(
  document: unknown,
  options: Omit<ParseSchemaMetaOptions, 'baselineStrict'> = {},
): AdapterResult<CanonicalSchemaMeta> {
  return parseSchemaMetaDocument(document, { ...options, baselineStrict: true })
}

/** Serializes the canonical model into the requested wire profile. */
export function serializeSchemaMeta(
  schemaMeta: CanonicalSchemaMeta,
  profile: SupportedProfile,
): AdapterResult<Record<string, unknown>> {
  const unsupported = assertSupportedProfile(profile)
  if (unsupported !== undefined) {
    return fail([unsupported])
  }
  return profile === TS11_PROFILE
    ? serializeTs11SchemaMeta(schemaMeta)
    : serializeOwfSchemaMeta(schemaMeta)
}

/**
 * Serializes only the standards document. Product metadata is intentionally not
 * passed to the codec, so it can never appear in a standards artifact.
 */
export function serializeAttestBookSchemaMeta(
  document: AttestBookSchemaMeta,
  profile: SupportedProfile,
): AdapterResult<Record<string, unknown>> {
  return serializeSchemaMeta(document.schemaMeta, profile)
}

/** Builds the OWF object used for signing and reference resolution. */
export function toOwfSchemaMeta(schemaMeta: CanonicalSchemaMeta) {
  return buildOwfSchemaMeta(schemaMeta)
}
