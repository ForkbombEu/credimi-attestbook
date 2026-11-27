// Credential-type assessment for publication readiness.
//
// A credential type is never a rulebook field: it lives inside the hosted
// schema as `properties.vct.const` (dc+sd-jwt) or `properties.docType.const`
// plus at least one namespace (mso_mdoc). AttestBook never fetches an external
// schema, so an external reference cannot be verified; that is a warning, not
// a failure. The assessment is pure: the caller resolves canonical hosted
// references from local storage and passes the stored document here.

import type { CredentialSchemaKind } from '../registry/types'
import type { RulebookVersionDocument } from '../registry/versioning'

/** The credential formats whose type declaration this check understands. */
export const CREDENTIAL_TYPE_FORMATS = ['dc+sd-jwt', 'mso_mdoc'] as const
export type CredentialTypeFormat = (typeof CREDENTIAL_TYPE_FORMATS)[number]

export interface CredentialSchemaResolution {
  readonly kind: CredentialSchemaKind
  readonly document: unknown
}

/**
 * Resolves a schema reference hosted by this deployment to its stored document.
 * `null` means the reference is external: AttestBook does not fetch it.
 */
export type CredentialSchemaResolver = (uri: string) => CredentialSchemaResolution | null

export interface CredentialTypeIssue {
  readonly attestation: string
  readonly format: CredentialTypeFormat
  /** The reference URI; empty when the attestation declares no reference. */
  readonly uri: string
  readonly status: 'fail' | 'warn'
  readonly reason: string
}

export interface CredentialTypesAssessment {
  readonly status: 'pass' | 'fail' | 'warn' | 'not_applicable'
  readonly message: string
  readonly issues: readonly CredentialTypeIssue[]
}

const MAX_REPORTED_ISSUES = 5
const MAX_MESSAGE_LENGTH = 800
const MAX_URI_IN_MESSAGE = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function hasNamespace(properties: Record<string, unknown>): boolean {
  return Object.entries(properties).some(
    ([name, subSchema]) =>
      name !== 'docType' &&
      isRecord(subSchema) &&
      (subSchema.type === 'object' || isRecord(subSchema.properties)),
  )
}

function propertiesOf(document: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(document.properties) ? document.properties : null
}

/**
 * Returns why the resolved document does not declare the required credential
 * type, or `null` when it does.
 */
function credentialTypeProblem(
  resolution: CredentialSchemaResolution,
  format: CredentialTypeFormat,
): string | null {
  const document = isRecord(resolution.document) ? resolution.document : null

  if (format === 'dc+sd-jwt') {
    if (resolution.kind === 'sd_jwt_vc_type_metadata') {
      return document !== null && isNonEmptyString(document.vct)
        ? null
        : 'the type metadata must declare a non-empty root vct'
    }
    const properties = document === null ? null : propertiesOf(document)
    const vctSchema = properties === null ? null : properties.vct
    return isRecord(vctSchema) && isNonEmptyString(vctSchema.const)
      ? null
      : 'properties.vct.const must be a non-empty string'
  }

  if (resolution.kind !== 'json_schema_2020_12') {
    return 'an mso_mdoc credential requires a JSON Schema with properties.docType.const and at least one namespace'
  }

  const properties = document === null ? null : propertiesOf(document)
  const problems: string[] = []
  const docTypeSchema = properties === null ? null : properties.docType
  if (!isRecord(docTypeSchema) || !isNonEmptyString(docTypeSchema.const)) {
    problems.push('properties.docType.const must be a non-empty string')
  }
  if (properties === null || !hasNamespace(properties)) {
    problems.push(
      'at least one namespace (a non-docType object member of properties) must be declared',
    )
  }
  return problems.length === 0 ? null : problems.join(' and ')
}

function described(issue: CredentialTypeIssue): string {
  const uri =
    issue.uri === ''
      ? 'no schema reference'
      : issue.uri.length > MAX_URI_IN_MESSAGE
        ? `${issue.uri.slice(0, MAX_URI_IN_MESSAGE)}…`
        : issue.uri
  return `"${issue.attestation}" (${issue.format}, ${uri}): ${issue.reason}`
}

function describeIssues(issues: readonly CredentialTypeIssue[]): string {
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map(described)
  const remaining = issues.length - shown.length
  return `${shown.join('; ')}${remaining > 0 ? `; and ${String(remaining)} more` : ''}`
}

function bounded(message: string): string {
  return message.length <= MAX_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
}

/**
 * Assesses the declared credential types of one rulebook version.
 *
 * For each attestation and each declared format, `fail` means the credential
 * type cannot be known or is not declared by the hosted document; `warn` means
 * the document is external and therefore unverifiable. Any fail wins over a
 * warn; no declared `dc+sd-jwt`/`mso_mdoc` format is `not_applicable`.
 */
export function assessCredentialTypes(
  document: RulebookVersionDocument,
  resolve: CredentialSchemaResolver,
): CredentialTypesAssessment {
  const issues: CredentialTypeIssue[] = []
  let declared = 0

  for (const attestation of document.attestations) {
    for (const format of CREDENTIAL_TYPE_FORMATS) {
      if (!attestation.supportedFormats.includes(format)) {
        continue
      }
      declared += 1
      const reference = attestation.schemaReferences.find(
        (candidate) => candidate.formatIdentifier === format,
      )
      if (reference === undefined) {
        issues.push({
          attestation: attestation.name,
          format,
          uri: '',
          status: 'fail',
          reason: `no ${format} schema reference is declared`,
        })
        continue
      }
      const resolution = resolve(reference.uri)
      if (resolution === null) {
        const declaration =
          format === 'dc+sd-jwt'
            ? 'properties.vct.const = "<vct>"'
            : 'properties.docType.const = "<docType>" and at least one namespace'
        issues.push({
          attestation: attestation.name,
          format,
          uri: reference.uri,
          status: 'warn',
          reason: `the schema is external, so AttestBook cannot verify it; it must declare ${declaration}`,
        })
        continue
      }
      const problem = credentialTypeProblem(resolution, format)
      if (problem !== null) {
        issues.push({
          attestation: attestation.name,
          format,
          uri: reference.uri,
          status: 'fail',
          reason: problem,
        })
      }
    }
  }

  if (declared === 0) {
    return {
      status: 'not_applicable',
      message:
        'No attestation type declares the dc+sd-jwt or mso_mdoc format, so no credential type is required.',
      issues,
    }
  }

  const failures = issues.filter((issue) => issue.status === 'fail')
  if (failures.length > 0) {
    return {
      status: 'fail',
      message: bounded(
        `The credential type requirements are not met: ${describeIssues(failures)}.`,
      ),
      issues,
    }
  }

  const warnings = issues.filter((issue) => issue.status === 'warn')
  if (warnings.length > 0) {
    return {
      status: 'warn',
      message: bounded(
        `The credential type cannot be fully verified: ${describeIssues(warnings)}.`,
      ),
      issues,
    }
  }

  return {
    status: 'pass',
    message: 'Every declared credential format has a verifiable credential type.',
    issues,
  }
}
