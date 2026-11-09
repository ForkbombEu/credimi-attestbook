// Input normalisation for the verifier-constraint API (FR-014, issue #45).
//
// The request is bounded before any schema document reaches the inspector: the
// same rulebook-identifier, semantic-version, attestation-name, schema-document
// and URI limits as credential validation. Messages name fields only; they
// never echo schema document content.

import { invalidInput } from '../registry/errors'
import { requireIdentifier, requireSemanticVersion, requireText } from '../registry/validation'
import {
  MAX_ATTESTATION_TYPE_LENGTH,
  MAX_FORMAT_LENGTH,
  MAX_SCHEMA_DOCUMENT_LENGTH,
  MAX_SCHEMA_DOCUMENTS,
  MAX_SCHEMA_URI_LENGTH,
} from '../validation/request'
import type { SchemaDocumentInput } from '../validation/types'

import type { ResolveVerifierConstraintsInput } from './types'

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
 * Validates and normalises an untyped `POST /api/v1/verifiers/constraints`
 * body. Throws a `RegistryError` with code `invalid_input` on a malformed
 * request.
 */
export function parseResolveVerifierConstraintsInput(
  value: unknown,
): ResolveVerifierConstraintsInput {
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
  const format =
    value.format === undefined ? undefined : requireText(value.format, 'format', MAX_FORMAT_LENGTH)
  const schemaDocuments = parseSchemaDocuments(value.schemaDocuments)

  return {
    rulebookId,
    rulebookVersion,
    attestationType,
    ...(format === undefined ? {} : { format }),
    ...(schemaDocuments === undefined ? {} : { schemaDocuments }),
  }
}
