// Input normalisation for the credential validation API (issue #32).
//
// Callers may use the engine directly or go through HTTP. Both paths validate
// the same bounded shape here so a request cannot become an unbounded parser or
// schema-compiler input. Messages name fields only; raw credential material and
// claim values are never included.

import { invalidInput } from '../registry/errors'
import { requireIdentifier, requireSemanticVersion, requireText } from '../registry/validation'

import type { CredentialArtifactInput, SchemaDocumentInput, ValidateCredentialInput } from './types'

/** Maximum credential artifact length accepted by the API (UTF-16 code units). */
export const MAX_CREDENTIAL_LENGTH = 512 * 1024
/** Maximum number of schema documents in one request. */
export const MAX_SCHEMA_DOCUMENTS = 4
/** Maximum length of one supplied schema document. */
export const MAX_SCHEMA_DOCUMENT_LENGTH = 128 * 1024
/** Maximum attestation type name length. */
export const MAX_ATTESTATION_TYPE_LENGTH = 200
/** Maximum explicit format identifier length. */
export const MAX_FORMAT_LENGTH = 100
/** Maximum schema reference URI length. */
export const MAX_SCHEMA_URI_LENGTH = 2_048

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keeps the exact text: schema integrity is verified over these bytes. */
function requireExactString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw invalidInput(`${field} must be a string`)
  }
  if (value === '') {
    throw invalidInput(`${field} must not be empty`)
  }
  if (value.length > maxLength) {
    throw invalidInput(`${field} must be at most ${maxLength} characters`)
  }
  return value
}

function parseCredentialArtifact(value: unknown): CredentialArtifactInput {
  if (typeof value === 'string') {
    return requireExactString(value, 'credential', MAX_CREDENTIAL_LENGTH)
  }
  if (!isRecord(value)) {
    throw invalidInput('credential must be a string or an object with a value')
  }
  const rawValue = requireExactString(value.value, 'credential.value', MAX_CREDENTIAL_LENGTH)
  if (value.format === undefined) {
    return { value: rawValue }
  }
  return {
    format: requireText(value.format, 'credential.format', MAX_FORMAT_LENGTH),
    value: rawValue,
  }
}

function parseSchemaDocuments(value: unknown): readonly SchemaDocumentInput[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw invalidInput('schemaDocuments must be an array')
  }
  if (value.length > MAX_SCHEMA_DOCUMENTS) {
    throw invalidInput(`schemaDocuments must contain at most ${MAX_SCHEMA_DOCUMENTS} items`)
  }

  const documents: SchemaDocumentInput[] = []
  const seen = new Set<string>()
  value.forEach((entry, index) => {
    const field = `schemaDocuments[${index}]`
    if (!isRecord(entry)) {
      throw invalidInput(`${field} must be an object`)
    }
    const uri = requireText(entry.uri, `${field}.uri`, MAX_SCHEMA_URI_LENGTH)
    if (seen.has(uri)) {
      throw invalidInput(`schemaDocuments must not repeat the URI "${uri}"`)
    }
    seen.add(uri)
    documents.push({
      uri,
      content: requireExactString(entry.content, `${field}.content`, MAX_SCHEMA_DOCUMENT_LENGTH),
    })
  })
  return documents
}

/**
 * Validates and normalises an untyped `POST /api/v1/credentials/validate` body.
 * Throws a `RegistryError` with code `invalid_input` on a malformed request.
 */
export function parseValidateCredentialInput(value: unknown): ValidateCredentialInput {
  if (!isRecord(value)) {
    throw invalidInput('request body must be a JSON object')
  }

  const rulebookId = requireIdentifier(value.rulebookId, 'rulebookId')
  const rulebookVersion = requireSemanticVersion(value.rulebookVersion, 'rulebookVersion')
  const attestationType = requireText(
    value.attestationType,
    'attestationType',
    MAX_ATTESTATION_TYPE_LENGTH,
  )
  const credential = parseCredentialArtifact(value.credential)
  const schemaDocuments = parseSchemaDocuments(value.schemaDocuments)

  return {
    rulebookId,
    rulebookVersion,
    attestationType,
    credential,
    ...(schemaDocuments === undefined ? {} : { schemaDocuments }),
  }
}
