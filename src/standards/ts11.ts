// EC TS11 v1.0.1 SchemaMeta codec.
//
// OWF 0.5.4 rejects a TS11 v1.0.1-shaped document (docs/standards.md §6), so
// this translation is the narrow, documented extension allowed by
// docs/specification.md §2.1. It never replaces OWF functionality: the OWF
// profile is parsed and validated by the real package in `./owf.ts`.
//
// Differences that cannot be translated in one direction are reported as
// `unsupported_operation` diagnostics instead of being silently dropped.

import {
  fail,
  hasBlockingDiagnostic,
  invalidInput,
  ok,
  preserved,
  unsupportedOperation,
  type AdapterDiagnostic,
  type AdapterResult,
} from './diagnostics'
import type {
  AttestBookSchemaMeta,
  CanonicalSchemaMeta,
  CanonicalSchemaReference,
  CanonicalTrustAuthority,
} from './model'
import {
  isRecord,
  TS11_ATTESTATION_LOS_VALUES,
  TS11_BINDING_TYPE_VALUES,
  TS11_FORMAT_VALUES,
  TS11_FRAMEWORK_TYPE_VALUES,
} from './profiles'
import {
  isAbsoluteUrl,
  isNonEmptyString,
  isSemVer,
  isUuid,
  parseReference,
  parseSri,
  toReferencedUri,
} from './wire'

const TS11_KNOWN_MEMBERS = new Set([
  'id',
  'version',
  'rulebookURI',
  'trustedAuthorities',
  'attestationLoS',
  'bindingType',
  'supportedFormats',
  'schemaURIs',
])

const TS11_TRUST_AUTHORITY_MEMBERS = new Set(['frameworkType', 'value', 'isLOTE'])

const TS11_SCHEMA_REFERENCE_MEMBERS = new Set(['formatIdentifier', 'uri'])

export interface Ts11ParseOptions {
  /**
   * When true, members and enumerated values outside the pinned TS11 v1.0.1
   * baseline are validation errors instead of preserved forward-compatible
   * data. Parsing defaults to preserving them (decision D-5).
   */
  readonly baselineStrict?: boolean
}

function memberPath(basePath: string, member: string): string {
  return basePath === '' ? member : `${basePath}.${member}`
}

function readRequiredString(
  record: Record<string, unknown>,
  member: string,
  basePath: string,
  diagnostics: AdapterDiagnostic[],
): string | undefined {
  const value = record[member]
  const path = memberPath(basePath, member)
  if (!isNonEmptyString(value)) {
    diagnostics.push(
      invalidInput('missing_required_member', `missing or empty required member "${member}"`, path),
    )
    return undefined
  }
  return value
}

function checkBaselineValue(
  value: string,
  allowed: readonly string[],
  path: string,
  strict: boolean,
  diagnostics: AdapterDiagnostic[],
): void {
  if (allowed.includes(value)) {
    return
  }
  if (strict) {
    diagnostics.push(
      invalidInput('invalid_member_value', `"${value}" is not in the TS11 v1.0.1 baseline`, path),
    )
  } else {
    diagnostics.push(
      preserved(
        'preserved_unknown_value',
        `preserved "${value}", which is outside the TS11 v1.0.1 baseline`,
        path,
      ),
    )
  }
}

function collectUnknownMembers(
  record: Record<string, unknown>,
  known: ReadonlySet<string>,
  basePath: string,
  strict: boolean,
  diagnostics: AdapterDiagnostic[],
): Readonly<Record<string, unknown>> | undefined {
  const unknown: Record<string, unknown> = {}
  let found = false

  for (const key of Object.keys(record)) {
    if (known.has(key)) {
      continue
    }
    found = true
    const path = memberPath(basePath, key)
    if (key === '__proto__') {
      diagnostics.push(
        invalidInput('invalid_member_value', 'the "__proto__" member is not accepted', path),
      )
      continue
    }
    if (strict) {
      diagnostics.push(
        invalidInput('invalid_member_value', `unrecognised TS11 v1.0.1 member "${key}"`, path),
      )
    } else {
      unknown[key] = record[key]
      diagnostics.push(
        preserved(
          'preserved_unknown_member',
          `preserved unrecognised member "${key}" for forward compatibility`,
          path,
        ),
      )
    }
  }

  return found ? unknown : undefined
}

function parseTrustAuthorities(
  value: unknown,
  strict: boolean,
  diagnostics: AdapterDiagnostic[],
): CanonicalTrustAuthority[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    diagnostics.push(
      invalidInput('invalid_member_value', 'expected an array', 'trustedAuthorities'),
    )
    return []
  }

  const authorities: CanonicalTrustAuthority[] = []
  value.forEach((entry, index) => {
    const path = `trustedAuthorities.${index}`
    if (!isRecord(entry)) {
      diagnostics.push(
        invalidInput('invalid_member_value', 'expected a TrustAuthority object', path),
      )
      return
    }

    const unknownMembers = collectUnknownMembers(
      entry,
      TS11_TRUST_AUTHORITY_MEMBERS,
      path,
      strict,
      diagnostics,
    )
    const frameworkType = readRequiredString(entry, 'frameworkType', path, diagnostics)
    const authorityValue = readRequiredString(entry, 'value', path, diagnostics)
    if (frameworkType !== undefined) {
      checkBaselineValue(
        frameworkType,
        TS11_FRAMEWORK_TYPE_VALUES,
        `${path}.frameworkType`,
        strict,
        diagnostics,
      )
    }

    let isLOTE: boolean | undefined
    if (entry.isLOTE !== undefined) {
      if (typeof entry.isLOTE !== 'boolean') {
        diagnostics.push(
          invalidInput('invalid_member_value', 'expected a boolean', `${path}.isLOTE`),
        )
      } else {
        isLOTE = entry.isLOTE
        if (isLOTE && frameworkType !== undefined && frameworkType !== 'etsi_tl') {
          diagnostics.push(
            invalidInput(
              'invalid_member_value',
              'isLOTE may only be true for frameworkType "etsi_tl"',
              `${path}.isLOTE`,
            ),
          )
        }
      }
    }

    if (frameworkType === undefined || authorityValue === undefined) {
      return
    }

    authorities.push({
      frameworkType,
      value: authorityValue,
      ...(isLOTE !== undefined ? { isLOTE } : {}),
      ...(unknownMembers !== undefined ? { unknownMembers } : {}),
    })
  })

  return authorities
}

function parseSchemaReferences(
  value: unknown,
  strict: boolean,
  diagnostics: AdapterDiagnostic[],
): CanonicalSchemaReference[] {
  if (!Array.isArray(value)) {
    diagnostics.push(
      invalidInput(
        'missing_required_member',
        'missing or invalid required member "schemaURIs"',
        'schemaURIs',
      ),
    )
    return []
  }
  if (value.length === 0) {
    diagnostics.push(
      invalidInput('invalid_member_value', 'at least one schema URI is required', 'schemaURIs'),
    )
    return []
  }

  const references: CanonicalSchemaReference[] = []
  value.forEach((entry, index) => {
    const path = `schemaURIs.${index}`
    if (!isRecord(entry)) {
      diagnostics.push(invalidInput('invalid_member_value', 'expected a Schema object', path))
      return
    }

    const unknownMembers = collectUnknownMembers(
      entry,
      TS11_SCHEMA_REFERENCE_MEMBERS,
      path,
      strict,
      diagnostics,
    )
    const formatIdentifier = readRequiredString(entry, 'formatIdentifier', path, diagnostics)
    if (formatIdentifier !== undefined) {
      checkBaselineValue(
        formatIdentifier,
        TS11_FORMAT_VALUES,
        `${path}.formatIdentifier`,
        strict,
        diagnostics,
      )
    }

    const reference = parseReference(entry.uri, `${path}.uri`, diagnostics)
    if (formatIdentifier === undefined || reference === undefined) {
      return
    }

    references.push({
      formatIdentifier,
      uri: reference.uri,
      ...(reference.integrity !== undefined ? { integrity: reference.integrity } : {}),
      ...(unknownMembers !== undefined ? { unknownMembers } : {}),
    })
  })

  return references
}

function parseSupportedFormats(
  value: unknown,
  strict: boolean,
  diagnostics: AdapterDiagnostic[],
): string[] {
  if (!Array.isArray(value)) {
    diagnostics.push(
      invalidInput(
        'missing_required_member',
        'missing or invalid required member "supportedFormats"',
        'supportedFormats',
      ),
    )
    return []
  }
  if (value.length === 0) {
    diagnostics.push(
      invalidInput(
        'invalid_member_value',
        'at least one supported format is required',
        'supportedFormats',
      ),
    )
    return []
  }

  const formats: string[] = []
  value.forEach((entry, index) => {
    const path = `supportedFormats.${index}`
    if (!isNonEmptyString(entry)) {
      diagnostics.push(
        invalidInput('invalid_member_value', 'expected a format identifier string', path),
      )
      return
    }
    if (formats.includes(entry)) {
      diagnostics.push(
        invalidInput('invalid_member_value', `duplicate supported format "${entry}"`, path),
      )
      return
    }
    checkBaselineValue(entry, TS11_FORMAT_VALUES, path, strict, diagnostics)
    formats.push(entry)
  })

  return formats
}

/**
 * Parses and validates an EC TS11 v1.0.1 SchemaMeta document into the canonical
 * model. This is AttestBook's translation extension; it is only used because
 * the pinned OWF package cannot parse the TS11 wire shape.
 */
export function parseTs11SchemaMeta(
  document: unknown,
  options: Ts11ParseOptions = {},
): AdapterResult<CanonicalSchemaMeta> {
  const strict = options.baselineStrict === true
  const diagnostics: AdapterDiagnostic[] = []

  if (!isRecord(document)) {
    return fail([
      invalidInput('invalid_schema_meta', 'a SchemaMeta document must be a JSON object'),
    ])
  }

  const unknownMembers = collectUnknownMembers(
    document,
    TS11_KNOWN_MEMBERS,
    '',
    strict,
    diagnostics,
  )

  let id: string | undefined
  if (document.id !== undefined) {
    if (!isNonEmptyString(document.id) || !isUuid(document.id)) {
      diagnostics.push(
        invalidInput('invalid_ts11_id', 'TS11 v1.0.1 requires a UUID when "id" is present', 'id'),
      )
    } else {
      id = document.id
    }
  }

  const version = readRequiredString(document, 'version', '', diagnostics)
  if (version !== undefined && !isSemVer(version)) {
    diagnostics.push(invalidInput('invalid_member_value', 'expected a SemVer version', 'version'))
  }

  const rulebookReference = parseReference(document.rulebookURI, 'rulebookURI', diagnostics)

  const attestationLoS = readRequiredString(document, 'attestationLoS', '', diagnostics)
  if (attestationLoS !== undefined) {
    checkBaselineValue(
      attestationLoS,
      TS11_ATTESTATION_LOS_VALUES,
      'attestationLoS',
      strict,
      diagnostics,
    )
  }

  const bindingType = readRequiredString(document, 'bindingType', '', diagnostics)
  if (bindingType !== undefined) {
    checkBaselineValue(bindingType, TS11_BINDING_TYPE_VALUES, 'bindingType', strict, diagnostics)
  }

  const supportedFormats = parseSupportedFormats(document.supportedFormats, strict, diagnostics)
  const schemaURIs = parseSchemaReferences(document.schemaURIs, strict, diagnostics)
  const trustedAuthorities = parseTrustAuthorities(document.trustedAuthorities, strict, diagnostics)

  for (const [index, reference] of schemaURIs.entries()) {
    if (supportedFormats.length > 0 && !supportedFormats.includes(reference.formatIdentifier)) {
      diagnostics.push(
        invalidInput(
          'invalid_member_value',
          `format "${reference.formatIdentifier}" is not listed in supportedFormats`,
          `schemaURIs.${index}.formatIdentifier`,
        ),
      )
    }
  }
  for (const format of supportedFormats) {
    if (!schemaURIs.some((reference) => reference.formatIdentifier === format)) {
      diagnostics.push(
        invalidInput(
          'invalid_member_value',
          `supported format "${format}" has no schema URI`,
          'supportedFormats',
        ),
      )
    }
  }

  if (
    hasBlockingDiagnostic(diagnostics) ||
    version === undefined ||
    rulebookReference === undefined ||
    attestationLoS === undefined ||
    bindingType === undefined
  ) {
    return fail(diagnostics)
  }

  const schemaMeta: CanonicalSchemaMeta = {
    version,
    rulebookURI: rulebookReference.uri,
    trustedAuthorities,
    attestationLoS,
    bindingType,
    supportedFormats,
    schemaURIs,
    unknownMembers: unknownMembers ?? {},
    ...(id !== undefined ? { id } : {}),
    ...(rulebookReference.integrity !== undefined
      ? { rulebookIntegrity: rulebookReference.integrity }
      : {}),
  }

  return ok(schemaMeta, diagnostics)
}

function buildTrustAuthorityWire(
  authority: CanonicalTrustAuthority,
  path: string,
  diagnostics: AdapterDiagnostic[],
): Record<string, unknown> | undefined {
  if (!isNonEmptyString(authority.frameworkType)) {
    diagnostics.push(
      invalidInput(
        'invalid_member_value',
        'expected a framework type string',
        `${path}.frameworkType`,
      ),
    )
    return undefined
  }
  if (!isNonEmptyString(authority.value)) {
    diagnostics.push(
      invalidInput('invalid_member_value', 'expected a trust authority value', `${path}.value`),
    )
    return undefined
  }
  if (authority.frameworkType === 'x509') {
    diagnostics.push(
      unsupportedOperation(
        'unsupported_trust_authority',
        'the OWF "x509" direct-anchor trust framework has no TS11 v1.0.1 representation',
        `${path}.frameworkType`,
      ),
    )
    return undefined
  }
  if (authority.verificationMethod !== undefined) {
    diagnostics.push(
      unsupportedOperation(
        'unsupported_trust_authority',
        'TS11 v1.0.1 TrustAuthority has no verificationMethod member',
        `${path}.verificationMethod`,
      ),
    )
    return undefined
  }
  if (!(TS11_FRAMEWORK_TYPE_VALUES as readonly string[]).includes(authority.frameworkType)) {
    diagnostics.push(
      preserved(
        'preserved_unknown_value',
        `serialized trust framework "${authority.frameworkType}", which is outside the pinned TS11 v1.0.1 baseline`,
        `${path}.frameworkType`,
      ),
    )
  }
  if (authority.isLOTE !== undefined) {
    if (typeof authority.isLOTE !== 'boolean') {
      diagnostics.push(invalidInput('invalid_member_value', 'expected a boolean', `${path}.isLOTE`))
      return undefined
    }
    if (authority.isLOTE && authority.frameworkType !== 'etsi_tl') {
      diagnostics.push(
        invalidInput(
          'invalid_member_value',
          'isLOTE may only be true for frameworkType "etsi_tl"',
          `${path}.isLOTE`,
        ),
      )
      return undefined
    }
  }
  if (authority.unknownMembers !== undefined) {
    for (const key of Object.keys(authority.unknownMembers)) {
      if (TS11_TRUST_AUTHORITY_MEMBERS.has(key)) {
        diagnostics.push(
          invalidInput(
            'invalid_member_value',
            `preserved member "${key}" collides with a TS11 member`,
            `${path}.${key}`,
          ),
        )
        return undefined
      }
    }
  }

  const wire: Record<string, unknown> = {
    frameworkType: authority.frameworkType,
    value: authority.value,
  }
  if (authority.isLOTE !== undefined) {
    wire.isLOTE = authority.isLOTE
  }
  if (authority.unknownMembers !== undefined) {
    Object.assign(wire, authority.unknownMembers)
  }
  return wire
}

function buildSchemaReferenceWire(
  reference: CanonicalSchemaReference,
  path: string,
  diagnostics: AdapterDiagnostic[],
): Record<string, unknown> | undefined {
  if (!isNonEmptyString(reference.formatIdentifier)) {
    diagnostics.push(
      invalidInput(
        'invalid_member_value',
        'expected a format identifier string',
        `${path}.formatIdentifier`,
      ),
    )
    return undefined
  }
  if (!isNonEmptyString(reference.uri) || !isAbsoluteUrl(reference.uri)) {
    diagnostics.push(
      invalidInput('invalid_member_value', 'expected an absolute URI', `${path}.uri`),
    )
    return undefined
  }
  if (reference.integrity !== undefined) {
    const sri = parseSri(reference.integrity)
    if (sri === undefined) {
      diagnostics.push(
        invalidInput(
          'invalid_member_value',
          'expected a W3C SRI value such as sha256-<base64>',
          `${path}.integrity`,
        ),
      )
      return undefined
    }
  }
  if (reference.meta !== undefined) {
    diagnostics.push(
      unsupportedOperation(
        'unsupported_schema_meta_member',
        'TS11 v1.0.1 Schema has no format-specific "meta" member',
        `${path}.meta`,
      ),
    )
    return undefined
  }
  if (reference.unknownMembers !== undefined) {
    for (const key of Object.keys(reference.unknownMembers)) {
      if (TS11_SCHEMA_REFERENCE_MEMBERS.has(key)) {
        diagnostics.push(
          invalidInput(
            'invalid_member_value',
            `preserved member "${key}" collides with a TS11 member`,
            `${path}.${key}`,
          ),
        )
        return undefined
      }
    }
  }

  const wire: Record<string, unknown> = {
    formatIdentifier: reference.formatIdentifier,
    uri: toReferencedUri(reference.uri, reference.integrity),
  }
  if (reference.unknownMembers !== undefined) {
    Object.assign(wire, reference.unknownMembers)
  }
  return wire
}

/**
 * Serializes the canonical model into an EC TS11 v1.0.1 SchemaMeta document.
 * Values that only exist in the OWF profile, or that TS11 cannot represent, are
 * reported as unsupported instead of being dropped.
 */
export function serializeTs11SchemaMeta(
  schemaMeta: CanonicalSchemaMeta,
): AdapterResult<Record<string, unknown>> {
  const diagnostics: AdapterDiagnostic[] = []

  if (schemaMeta.iat !== undefined) {
    diagnostics.push(
      unsupportedOperation(
        'unsupported_schema_meta_member',
        'TS11 v1.0.1 SchemaMeta has no "iat" member',
        'iat',
      ),
    )
  }
  if (schemaMeta.issuanceProfile !== undefined) {
    diagnostics.push(
      unsupportedOperation(
        'unsupported_schema_meta_member',
        'TS11 v1.0.1 SchemaMeta has no "issuanceProfile" member',
        'issuanceProfile',
      ),
    )
  }

  if (schemaMeta.id !== undefined && !isUuid(schemaMeta.id)) {
    diagnostics.push(
      invalidInput('invalid_ts11_id', 'TS11 v1.0.1 requires a UUID when "id" is present', 'id'),
    )
  }

  if (!isNonEmptyString(schemaMeta.version) || !isSemVer(schemaMeta.version)) {
    diagnostics.push(invalidInput('invalid_member_value', 'expected a SemVer version', 'version'))
  }
  if (!isNonEmptyString(schemaMeta.rulebookURI) || !isAbsoluteUrl(schemaMeta.rulebookURI)) {
    diagnostics.push(
      invalidInput('invalid_member_value', 'expected an absolute rulebook URI', 'rulebookURI'),
    )
  }
  if (schemaMeta.rulebookIntegrity !== undefined) {
    if (parseSri(schemaMeta.rulebookIntegrity) === undefined) {
      diagnostics.push(
        invalidInput(
          'invalid_member_value',
          'expected a W3C SRI value such as sha256-<base64>',
          'rulebookIntegrity',
        ),
      )
    }
  }

  const supportedFormats: string[] = []
  schemaMeta.supportedFormats.forEach((format, index) => {
    const path = `supportedFormats.${index}`
    if (!isNonEmptyString(format)) {
      diagnostics.push(
        invalidInput('invalid_member_value', 'expected a format identifier string', path),
      )
      return
    }
    if (supportedFormats.includes(format)) {
      diagnostics.push(
        invalidInput('invalid_member_value', `duplicate supported format "${format}"`, path),
      )
      return
    }
    if (!(TS11_FORMAT_VALUES as readonly string[]).includes(format)) {
      diagnostics.push(
        preserved(
          'preserved_unknown_value',
          `serialized "${format}", which is outside the pinned TS11 v1.0.1 baseline`,
          path,
        ),
      )
    }
    supportedFormats.push(format)
  })
  if (supportedFormats.length === 0) {
    diagnostics.push(
      invalidInput(
        'missing_required_member',
        'at least one supported format is required',
        'supportedFormats',
      ),
    )
  }

  if (!isNonEmptyString(schemaMeta.attestationLoS)) {
    diagnostics.push(
      invalidInput(
        'missing_required_member',
        'expected an attestation level of security',
        'attestationLoS',
      ),
    )
  } else if (
    !(TS11_ATTESTATION_LOS_VALUES as readonly string[]).includes(schemaMeta.attestationLoS)
  ) {
    diagnostics.push(
      preserved(
        'preserved_unknown_value',
        `serialized "${schemaMeta.attestationLoS}", which is outside the pinned TS11 v1.0.1 baseline`,
        'attestationLoS',
      ),
    )
  }
  if (!isNonEmptyString(schemaMeta.bindingType)) {
    diagnostics.push(
      invalidInput('missing_required_member', 'expected a binding type', 'bindingType'),
    )
  } else if (!(TS11_BINDING_TYPE_VALUES as readonly string[]).includes(schemaMeta.bindingType)) {
    diagnostics.push(
      preserved(
        'preserved_unknown_value',
        `serialized "${schemaMeta.bindingType}", which is outside the pinned TS11 v1.0.1 baseline`,
        'bindingType',
      ),
    )
  }

  const schemaURIs: Record<string, unknown>[] = []
  if (schemaMeta.schemaURIs.length === 0) {
    diagnostics.push(
      invalidInput('missing_required_member', 'at least one schema URI is required', 'schemaURIs'),
    )
  }
  schemaMeta.schemaURIs.forEach((reference, index) => {
    const wire = buildSchemaReferenceWire(reference, `schemaURIs.${index}`, diagnostics)
    if (wire !== undefined) {
      schemaURIs.push(wire)
    }
  })

  for (const [index, reference] of schemaMeta.schemaURIs.entries()) {
    if (supportedFormats.length > 0 && !supportedFormats.includes(reference.formatIdentifier)) {
      diagnostics.push(
        invalidInput(
          'invalid_member_value',
          `format "${reference.formatIdentifier}" is not listed in supportedFormats`,
          `schemaURIs.${index}.formatIdentifier`,
        ),
      )
    }
  }
  for (const format of supportedFormats) {
    if (!schemaMeta.schemaURIs.some((reference) => reference.formatIdentifier === format)) {
      diagnostics.push(
        invalidInput(
          'invalid_member_value',
          `supported format "${format}" has no schema URI`,
          'supportedFormats',
        ),
      )
    }
  }

  const trustedAuthorities: Record<string, unknown>[] = []
  schemaMeta.trustedAuthorities.forEach((authority, index) => {
    const wire = buildTrustAuthorityWire(authority, `trustedAuthorities.${index}`, diagnostics)
    if (wire !== undefined) {
      trustedAuthorities.push(wire)
    }
  })

  if (schemaMeta.unknownMembers !== undefined) {
    for (const key of Object.keys(schemaMeta.unknownMembers)) {
      if (TS11_KNOWN_MEMBERS.has(key)) {
        diagnostics.push(
          invalidInput(
            'invalid_member_value',
            `preserved member "${key}" collides with a TS11 member`,
            key,
          ),
        )
      }
    }
  }

  if (hasBlockingDiagnostic(diagnostics)) {
    return fail(diagnostics)
  }

  const wire: Record<string, unknown> = {
    version: schemaMeta.version,
    rulebookURI: toReferencedUri(schemaMeta.rulebookURI, schemaMeta.rulebookIntegrity),
    attestationLoS: schemaMeta.attestationLoS,
    bindingType: schemaMeta.bindingType,
    supportedFormats,
    schemaURIs,
  }
  if (schemaMeta.id !== undefined) {
    wire.id = schemaMeta.id
  }
  if (trustedAuthorities.length > 0) {
    wire.trustedAuthorities = trustedAuthorities
  }
  if (schemaMeta.unknownMembers !== undefined) {
    Object.assign(wire, schemaMeta.unknownMembers)
  }

  return ok(wire, diagnostics)
}

/** True when the canonical document can be represented by the TS11 profile. */
export function isTs11Representable(schemaMeta: CanonicalSchemaMeta): boolean {
  return serializeTs11SchemaMeta(schemaMeta).ok
}

/** Convenience wrapper: serializes the standards document, never product metadata. */
export function serializeAttestBookTs11(
  document: AttestBookSchemaMeta,
): AdapterResult<Record<string, unknown>> {
  return serializeTs11SchemaMeta(document.schemaMeta)
}
