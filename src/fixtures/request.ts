// Input normalisation for the issuer fixture-generation API (issue #44).
//
// The request is bounded before it reaches the schema synthesiser: the same
// rulebook-identifier, semantic-version, attestation-name, schema-document and
// URI limits as credential validation, plus a bounded override list. A message
// names fields only; it never echoes an override value or a schema document.

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

import type { GenerateIssuerFixtureInput, IssuerFixtureOverrideInput } from './types'

/** Maximum number of attribute overrides accepted in one request. */
export const MAX_FIXTURE_OVERRIDES = 64

/** Maximum length of one override JSON Pointer. */
export const MAX_FIXTURE_OVERRIDE_PATH_LENGTH = 512

/** Maximum nesting depth of one override value. */
const MAX_OVERRIDE_VALUE_DEPTH = 32

/** Maximum JSON nodes in one override value. */
const MAX_OVERRIDE_VALUE_NODES = 4_096

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
 * A JSON Pointer that addresses an instance location. The empty root pointer
 * and malformed `~` escapes are rejected because an override replaces one
 * selected attribute, never the whole payload.
 */
function requireOverridePath(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw invalidInput(`${field} must be a string`)
  }
  if (value === '' || value === '/') {
    throw invalidInput(`${field} must address an attribute below the payload root`)
  }
  if (value.length > MAX_FIXTURE_OVERRIDE_PATH_LENGTH) {
    throw invalidInput(`${field} must be at most ${MAX_FIXTURE_OVERRIDE_PATH_LENGTH} characters`)
  }
  if (!value.startsWith('/')) {
    throw invalidInput(`${field} must be a JSON Pointer starting with "/"`)
  }
  for (const segment of value.slice(1).split('/')) {
    if (/~(?![01])/.test(segment)) {
      throw invalidInput(`${field} is not a valid JSON Pointer`)
    }
  }
  return value
}

/** Bounds and shape-checks one override value without echoing it. */
function requireJsonValue(
  value: unknown,
  field: string,
  depth: number,
  budget: { nodes: number },
): void {
  budget.nodes += 1
  if (budget.nodes > MAX_OVERRIDE_VALUE_NODES) {
    throw invalidInput(`${field} exceeds the JSON node bound`)
  }
  if (depth > MAX_OVERRIDE_VALUE_DEPTH) {
    throw invalidInput(`${field} exceeds the JSON nesting bound`)
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw invalidInput(`${field} must contain only finite numbers`)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      requireJsonValue(entry, field, depth + 1, budget)
    }
    return
  }
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidInput(`${field} must be a plain JSON value`)
    }
    for (const entry of Object.values(value)) {
      requireJsonValue(entry, field, depth + 1, budget)
    }
    return
  }
  throw invalidInput(`${field} must be a JSON value`)
}

function parseOverrides(value: unknown): readonly IssuerFixtureOverrideInput[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw invalidInput('overrides must be an array')
  }
  if (value.length > MAX_FIXTURE_OVERRIDES) {
    throw invalidInput(`overrides must contain at most ${MAX_FIXTURE_OVERRIDES} items`)
  }

  const overrides: IssuerFixtureOverrideInput[] = []
  const seen = new Set<string>()
  value.forEach((entry, index) => {
    const field = `overrides[${index}]`
    if (!isRecord(entry)) {
      throw invalidInput(`${field} must be an object`)
    }
    const path = requireOverridePath(entry.path, `${field}.path`)
    if (seen.has(path)) {
      throw invalidInput(`overrides must not repeat the path "${path}"`)
    }
    seen.add(path)
    requireJsonValue(entry.value, `${field}.value`, 0, { nodes: 0 })
    overrides.push({ path, value: entry.value })
  })
  return overrides
}

/**
 * Validates and normalises an untyped `POST /api/v1/issuers/fixtures` body.
 * Throws a `RegistryError` with code `invalid_input` on a malformed request.
 */
export function parseGenerateIssuerFixtureInput(value: unknown): GenerateIssuerFixtureInput {
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
  const overrides = parseOverrides(value.overrides)

  return {
    rulebookId,
    rulebookVersion,
    attestationType,
    ...(format === undefined ? {} : { format }),
    ...(schemaDocuments === undefined ? {} : { schemaDocuments }),
    ...(overrides === undefined ? {} : { overrides }),
  }
}
