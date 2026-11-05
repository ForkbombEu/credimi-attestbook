// OWF `@owf/eudi-attestation-schema` 0.5.4 SchemaMeta codec.
//
// Structural validation, builders and serialization for the OWF profile are
// delegated to the real pinned package. This module only translates between its
// public data model and the canonical AttestBook model; it must not reimplement
// validation that OWF already provides.

import {
  validateSchemaMeta,
  type SchemaMeta,
  type SchemaURI,
  type TrustAuthority,
} from '@owf/eudi-attestation-schema'

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
  CanonicalSchemaMeta,
  CanonicalSchemaReference,
  CanonicalTrustAuthority,
} from './model'
import { isRecord, OWF_FORMAT_VALUES, OWF_FRAMEWORK_TYPE_VALUES } from './profiles'
import { isAbsoluteUrl, isNonEmptyString, parseSri } from './wire'

const OWF_KNOWN_MEMBERS = new Set([
  'id',
  'iat',
  'version',
  'rulebookURI',
  'rulebookIntegrity',
  'trustedAuthorities',
  'attestationLoS',
  'bindingType',
  'schemaURIs',
  'issuanceProfile',
])

/**
 * Parses an OWF 0.5.4 SchemaMeta document through `validateSchemaMeta` from the
 * real package, then translates it into the canonical model.
 */
export function parseOwfSchemaMeta(document: unknown): AdapterResult<CanonicalSchemaMeta> {
  const validation = validateSchemaMeta(document)
  if (!validation.valid) {
    return fail(
      validation.errors.map((error) =>
        invalidInput(
          'invalid_schema_meta',
          error.message,
          error.path === '' ? undefined : error.path,
        ),
      ),
    )
  }

  const wire = document as SchemaMeta
  const diagnostics: AdapterDiagnostic[] = []

  const trustedAuthorities: CanonicalTrustAuthority[] = (wire.trustedAuthorities ?? []).map(
    (authority: TrustAuthority) =>
      authority.frameworkType === 'etsi_tl'
        ? {
            frameworkType: authority.frameworkType,
            value: authority.value,
            verificationMethod: {
              type: authority.verificationMethod.type,
              x509Certificate: authority.verificationMethod.x509Certificate,
            },
          }
        : {
            frameworkType: authority.frameworkType,
            value: authority.value,
          },
  )

  const schemaURIs: CanonicalSchemaReference[] = wire.schemaURIs.map((reference: SchemaURI) => ({
    formatIdentifier: reference.formatIdentifier,
    uri: reference.uri,
    integrity: reference.integrity,
    meta: reference.meta,
  }))

  const supportedFormats = [...new Set(schemaURIs.map((reference) => reference.formatIdentifier))]

  const unknownMembers: Record<string, unknown> = {}
  const record = document as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!OWF_KNOWN_MEMBERS.has(key)) {
      unknownMembers[key] = record[key]
      diagnostics.push(
        preserved(
          'preserved_unknown_member',
          `preserved unrecognised OWF member "${key}" for forward compatibility`,
          key,
        ),
      )
    }
  }

  const schemaMeta: CanonicalSchemaMeta = {
    id: wire.id,
    version: wire.version,
    rulebookURI: wire.rulebookURI,
    rulebookIntegrity: wire.rulebookIntegrity,
    trustedAuthorities,
    attestationLoS: wire.attestationLoS,
    bindingType: wire.bindingType,
    supportedFormats,
    schemaURIs,
    unknownMembers,
    ...(wire.iat !== undefined ? { iat: wire.iat } : {}),
    ...(wire.issuanceProfile !== undefined ? { issuanceProfile: wire.issuanceProfile } : {}),
  }

  return ok(schemaMeta, diagnostics)
}

function buildOwfTrustAuthority(
  authority: CanonicalTrustAuthority,
  path: string,
  diagnostics: AdapterDiagnostic[],
): TrustAuthority | undefined {
  if (!isNonEmptyString(authority.value)) {
    diagnostics.push(
      invalidInput('invalid_member_value', 'expected a trust authority value', `${path}.value`),
    )
    return undefined
  }
  if (authority.unknownMembers !== undefined && Object.keys(authority.unknownMembers).length > 0) {
    diagnostics.push(
      unsupportedOperation(
        'unsupported_schema_meta_member',
        'OWF 0.5.4 TrustAuthority is strict and has no members beyond frameworkType/value',
        path,
      ),
    )
    return undefined
  }

  if (authority.frameworkType === 'etsi_tl') {
    if (authority.isLOTE !== undefined) {
      diagnostics.push(
        unsupportedOperation(
          'unsupported_trust_authority',
          'OWF 0.5.4 TrustAuthority has no "isLOTE" member',
          `${path}.isLOTE`,
        ),
      )
      return undefined
    }
    const verificationMethod = authority.verificationMethod
    if (
      verificationMethod === undefined ||
      verificationMethod.type !== 'X509Certificate' ||
      !isNonEmptyString(verificationMethod.x509Certificate)
    ) {
      diagnostics.push(
        unsupportedOperation(
          'unsupported_trust_authority',
          'OWF 0.5.4 requires an X509Certificate verificationMethod for etsi_tl, which TS11 v1.0.1 does not carry',
          `${path}.verificationMethod`,
        ),
      )
      return undefined
    }
    return {
      frameworkType: 'etsi_tl',
      value: authority.value,
      verificationMethod: {
        type: 'X509Certificate',
        x509Certificate: verificationMethod.x509Certificate,
      },
    }
  }

  if (authority.frameworkType === 'x509') {
    if (authority.isLOTE !== undefined || authority.verificationMethod !== undefined) {
      diagnostics.push(
        unsupportedOperation(
          'unsupported_trust_authority',
          'the OWF "x509" direct anchor has no isLOTE or verificationMethod members',
          path,
        ),
      )
      return undefined
    }
    return { frameworkType: 'x509', value: authority.value }
  }

  diagnostics.push(
    unsupportedOperation(
      'unsupported_trust_authority',
      `OWF 0.5.4 cannot represent trust framework "${authority.frameworkType}"; supported values are ${OWF_FRAMEWORK_TYPE_VALUES.join(', ')}`,
      `${path}.frameworkType`,
    ),
  )
  return undefined
}

function buildOwfSchemaUri(
  reference: CanonicalSchemaReference,
  path: string,
  diagnostics: AdapterDiagnostic[],
): SchemaURI | undefined {
  if (!(OWF_FORMAT_VALUES as readonly string[]).includes(reference.formatIdentifier)) {
    diagnostics.push(
      unsupportedOperation(
        'unsupported_format',
        `OWF 0.5.4 supports only ${OWF_FORMAT_VALUES.join(', ')}; cannot represent "${reference.formatIdentifier}"`,
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
  if (reference.integrity === undefined) {
    diagnostics.push(
      unsupportedOperation(
        'unsupported_schema_meta_member',
        'OWF 0.5.4 requires a per-schema integrity value; TS11 v1.0.1 allows it to be absent',
        `${path}.integrity`,
      ),
    )
    return undefined
  }
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
  if (sri.algorithm !== 'sha256') {
    diagnostics.push(
      unsupportedOperation(
        'unsupported_sri_algorithm',
        `OWF 0.5.4 verifies sha256 SRI only; "${sri.algorithm}" cannot be represented`,
        `${path}.integrity`,
      ),
    )
    return undefined
  }
  if (reference.meta === undefined) {
    diagnostics.push(
      unsupportedOperation(
        'unsupported_schema_meta_member',
        'OWF 0.5.4 requires format-specific "meta"; TS11 v1.0.1 does not carry it',
        `${path}.meta`,
      ),
    )
    return undefined
  }
  if (reference.unknownMembers !== undefined && Object.keys(reference.unknownMembers).length > 0) {
    diagnostics.push(
      unsupportedOperation(
        'unsupported_schema_meta_member',
        'OWF 0.5.4 Schema is strict and has no members beyond uri/integrity/formatIdentifier/meta',
        path,
      ),
    )
    return undefined
  }

  return {
    formatIdentifier: reference.formatIdentifier,
    uri: reference.uri,
    integrity: reference.integrity,
    meta: reference.meta,
  } as unknown as SchemaURI
}

/**
 * Builds an OWF 0.5.4 SchemaMeta object from the canonical model. The result is
 * validated with `validateSchemaMeta` from the real package before it is
 * returned, so serialization and OWF validation cannot disagree.
 */
export function buildOwfSchemaMeta(schemaMeta: CanonicalSchemaMeta): AdapterResult<SchemaMeta> {
  const diagnostics: AdapterDiagnostic[] = []

  if (!isNonEmptyString(schemaMeta.id)) {
    diagnostics.push(invalidInput('missing_required_member', 'OWF 0.5.4 requires an "id"', 'id'))
  }
  if (!isNonEmptyString(schemaMeta.version)) {
    diagnostics.push(
      invalidInput('missing_required_member', 'expected a SemVer version', 'version'),
    )
  }
  if (!isNonEmptyString(schemaMeta.rulebookURI) || !isAbsoluteUrl(schemaMeta.rulebookURI)) {
    diagnostics.push(
      invalidInput('invalid_member_value', 'expected an absolute rulebook URI', 'rulebookURI'),
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
  }
  if (!isNonEmptyString(schemaMeta.bindingType)) {
    diagnostics.push(
      invalidInput('missing_required_member', 'expected a binding type', 'bindingType'),
    )
  }

  if (schemaMeta.rulebookIntegrity === undefined) {
    diagnostics.push(
      unsupportedOperation(
        'unsupported_schema_meta_member',
        'OWF 0.5.4 requires a sha256 rulebookIntegrity; TS11 v1.0.1 allows rulebookURI without an #integrity fragment',
        'rulebookIntegrity',
      ),
    )
  } else {
    const sri = parseSri(schemaMeta.rulebookIntegrity)
    if (sri === undefined) {
      diagnostics.push(
        invalidInput(
          'invalid_member_value',
          'expected a W3C SRI value such as sha256-<base64>',
          'rulebookIntegrity',
        ),
      )
    } else if (sri.algorithm !== 'sha256') {
      diagnostics.push(
        unsupportedOperation(
          'unsupported_sri_algorithm',
          `OWF 0.5.4 verifies sha256 SRI only; "${sri.algorithm}" cannot be represented`,
          'rulebookIntegrity',
        ),
      )
    }
  }

  for (const [index, format] of schemaMeta.supportedFormats.entries()) {
    if (!(OWF_FORMAT_VALUES as readonly string[]).includes(format)) {
      diagnostics.push(
        unsupportedOperation(
          'unsupported_format',
          `OWF 0.5.4 supports only ${OWF_FORMAT_VALUES.join(', ')}; cannot represent "${format}"`,
          `supportedFormats.${index}`,
        ),
      )
    }
  }

  if (schemaMeta.schemaURIs.length === 0) {
    diagnostics.push(
      invalidInput(
        'missing_required_member',
        'OWF 0.5.4 requires at least one schema URI',
        'schemaURIs',
      ),
    )
  }
  const schemaURIs: SchemaURI[] = []
  schemaMeta.schemaURIs.forEach((reference, index) => {
    if (!schemaMeta.supportedFormats.includes(reference.formatIdentifier)) {
      diagnostics.push(
        invalidInput(
          'invalid_member_value',
          `format "${reference.formatIdentifier}" is not listed in supportedFormats`,
          `schemaURIs.${index}.formatIdentifier`,
        ),
      )
    }
    const wire = buildOwfSchemaUri(reference, `schemaURIs.${index}`, diagnostics)
    if (wire !== undefined) {
      schemaURIs.push(wire)
    }
  })
  for (const format of schemaMeta.supportedFormats) {
    if (!schemaMeta.schemaURIs.some((reference) => reference.formatIdentifier === format)) {
      diagnostics.push(
        unsupportedOperation(
          'unsupported_format',
          `OWF 0.5.4 derives formats from schemaURIs; supported format "${format}" has no schema URI`,
          'supportedFormats',
        ),
      )
    }
  }

  const trustedAuthorities: TrustAuthority[] = []
  schemaMeta.trustedAuthorities.forEach((authority, index) => {
    const wire = buildOwfTrustAuthority(authority, `trustedAuthorities.${index}`, diagnostics)
    if (wire !== undefined) {
      trustedAuthorities.push(wire)
    }
  })

  if (schemaMeta.iat !== undefined && (!Number.isInteger(schemaMeta.iat) || schemaMeta.iat < 0)) {
    diagnostics.push(invalidInput('invalid_member_value', 'expected a non-negative integer', 'iat'))
  }

  if (hasBlockingDiagnostic(diagnostics)) {
    return fail(diagnostics)
  }

  const id = schemaMeta.id
  const version = schemaMeta.version
  const rulebookURI = schemaMeta.rulebookURI
  const rulebookIntegrity = schemaMeta.rulebookIntegrity
  const attestationLoS = schemaMeta.attestationLoS
  const bindingType = schemaMeta.bindingType
  if (
    !isNonEmptyString(id) ||
    !isNonEmptyString(version) ||
    !isNonEmptyString(rulebookURI) ||
    !isNonEmptyString(rulebookIntegrity) ||
    !isNonEmptyString(attestationLoS) ||
    !isNonEmptyString(bindingType)
  ) {
    return fail(diagnostics)
  }

  const wire: SchemaMeta = {
    id,
    version,
    rulebookURI,
    rulebookIntegrity,
    attestationLoS: attestationLoS as SchemaMeta['attestationLoS'],
    bindingType: bindingType as SchemaMeta['bindingType'],
    schemaURIs,
    ...(trustedAuthorities.length > 0 ? { trustedAuthorities } : {}),
    ...(schemaMeta.iat !== undefined ? { iat: schemaMeta.iat } : {}),
    ...(schemaMeta.issuanceProfile !== undefined
      ? {
          issuanceProfile: schemaMeta.issuanceProfile,
        }
      : {}),
    ...schemaMeta.unknownMembers,
  }

  const validation = validateSchemaMeta(wire)
  if (!validation.valid) {
    return fail([
      ...diagnostics,
      ...validation.errors.map((error) =>
        invalidInput(
          'invalid_schema_meta',
          error.message,
          error.path === '' ? undefined : error.path,
        ),
      ),
    ])
  }

  return ok(wire, diagnostics)
}

/**
 * Serializes the canonical model as a plain JSON-ready OWF 0.5.4 document.
 * Validation is still performed by `buildOwfSchemaMeta` through the real
 * package; this wrapper only widens the type for JSON serialization.
 */
export function serializeOwfSchemaMeta(
  schemaMeta: CanonicalSchemaMeta,
): AdapterResult<Record<string, unknown>> {
  const built = buildOwfSchemaMeta(schemaMeta)
  if (!built.ok) {
    return built
  }
  return ok(built.value as unknown as Record<string, unknown>, built.diagnostics)
}

/** True when the canonical document can be represented by the OWF profile. */
export function isOwfRepresentable(schemaMeta: CanonicalSchemaMeta): boolean {
  return buildOwfSchemaMeta(schemaMeta).ok
}

export function isOwfSchemaMetaDocument(value: unknown): value is SchemaMeta {
  return isRecord(value) && validateSchemaMeta(value).valid
}
