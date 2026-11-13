// Strict parsing and profile checks for provider-owned credential schema
// documents (issue #97).
//
// These documents are untrusted input (specification §15), so the bytes are
// bounded, must be exact valid UTF-8 JSON, and the parsed value is bounded in
// nesting depth and node count. Only the two profiles the validation engine can
// apply are accepted: JSON Schema 2020-12 and SD-JWT VC Type Metadata. JSON
// Schema keywords AttestBook cannot evaluate safely are refused at registration
// instead of being stored and reported only when a credential is validated later.
//
// This module never executes a document in the server process: JSON Schema
// compilation and evaluation run in the existing #32 schema sandbox under its
// time, memory, output and concurrency limits, and no remote reference is
// resolved.

import { TypeMetadataFormatSchema } from '@sd-jwt/sd-jwt-vc'

import { findUnsupportedSchemaKeyword, type PendingSchemaDocument } from '../validation/schema'
import { runSchemaSandbox, type SchemaSandboxLimits } from '../validation/schema-sandbox'
import type { RulebookVersionSchemaReference } from './versioning'
import { invalidInput } from './errors'
import {
  CREDENTIAL_SCHEMA_KINDS,
  CREDENTIAL_SCHEMA_MEDIA_TYPES,
  type CredentialSchemaKind,
  type CredentialSchemaMediaType,
} from './types'

/** Hard bound on the exact document bytes accepted for persistence. */
export const MAX_CREDENTIAL_SCHEMA_DOCUMENT_BYTES = 262_144

/** Hard bound on document nesting depth, matching the validation sandbox. */
export const MAX_CREDENTIAL_SCHEMA_DOCUMENT_DEPTH = 64

/** Bound on parsed JSON values; keeps breadth as well as depth bounded. */
export const MAX_CREDENTIAL_SCHEMA_DOCUMENT_NODES = 32_768

/**
 * Hard bound on document associations one provider may create (#99). Replaying
 * an existing provider/content registration stays idempotent at the limit, so a
 * provider is never locked out of the documents it already owns.
 */
export const MAX_CREDENTIAL_SCHEMA_DOCUMENTS_PER_PROVIDER = 100

/** Bound on the type metadata `vct` value; it is a URL, not free text. */
const MAX_VCT_LENGTH = 2_048

const SUPPORTED_JSON_SCHEMA_DIALECTS = new Set([
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/schema#',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Requires one of the supported credential schema profiles. */
export function requireCredentialSchemaKind(value: unknown): CredentialSchemaKind {
  if (
    typeof value !== 'string' ||
    !CREDENTIAL_SCHEMA_KINDS.includes(value as CredentialSchemaKind)
  ) {
    throw invalidInput(
      `kind must be one of ${CREDENTIAL_SCHEMA_KINDS.map((kind) => `"${kind}"`).join(', ')}`,
    )
  }
  return value as CredentialSchemaKind
}

/** The canonical media type for a supported credential schema profile. */
export function credentialSchemaMediaType(kind: CredentialSchemaKind): CredentialSchemaMediaType {
  return CREDENTIAL_SCHEMA_MEDIA_TYPES[kind]
}

/**
 * Requires exact document bytes, bounded and copied so a caller cannot mutate
 * the buffer between the digest computation and the database write.
 */
export function requireCredentialSchemaDocumentBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw invalidInput('bytes must be a Uint8Array of the exact UTF-8 document bytes')
  }
  if (value.byteLength === 0) {
    throw invalidInput('bytes must not be empty')
  }
  if (value.byteLength > MAX_CREDENTIAL_SCHEMA_DOCUMENT_BYTES) {
    throw invalidInput(`bytes must be at most ${MAX_CREDENTIAL_SCHEMA_DOCUMENT_BYTES} bytes`)
  }
  return Uint8Array.from(value)
}

function decodeUtf8(bytes: Uint8Array): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw invalidInput('document bytes must be valid UTF-8')
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw invalidInput('document must not begin with a byte-order mark')
  }
  return text
}

/**
 * Rejects a document whose JSON text repeats a member name in any object
 * (I-JSON, RFC 7493). `JSON.parse` silently keeps the last value, so two
 * parsers could see different schemas in the same exact bytes. The input has
 * already been parsed successfully, so this scan only has to find object keys.
 */
function assertNoDuplicateMemberNames(text: string): void {
  let index = 0
  let depth = 0

  function fail(): never {
    throw invalidInput('document must not repeat a member name')
  }

  function enter(): void {
    depth += 1
    if (depth > MAX_CREDENTIAL_SCHEMA_DOCUMENT_DEPTH) {
      throw invalidInput(
        `document must be nested at most ${MAX_CREDENTIAL_SCHEMA_DOCUMENT_DEPTH} levels deep`,
      )
    }
  }

  function leave(): void {
    depth -= 1
  }

  function skipWhitespace(): void {
    while (index < text.length && /\s/.test(text[index] ?? '')) {
      index += 1
    }
  }

  function readString(): string {
    const start = index
    index += 1
    while (index < text.length) {
      const character = text[index]
      if (character === '\\') {
        index += 2
        continue
      }
      if (character === '"') {
        index += 1
        return JSON.parse(text.slice(start, index)) as string
      }
      index += 1
    }
    return fail()
  }

  function skipValue(): void {
    skipWhitespace()
    const character = text[index]
    if (character === '{') {
      skipObject()
      return
    }
    if (character === '[') {
      skipArray()
      return
    }
    if (character === '"') {
      readString()
      return
    }
    while (index < text.length && !/[\s,\]}]/.test(text[index] ?? '')) {
      index += 1
    }
  }

  function skipObject(): void {
    index += 1
    enter()
    try {
      const keys = new Set<string>()
      skipWhitespace()
      if (text[index] === '}') {
        index += 1
        return
      }
      while (true) {
        skipWhitespace()
        if (text[index] !== '"') {
          fail()
        }
        const key = readString()
        if (keys.has(key)) {
          fail()
        }
        keys.add(key)
        skipWhitespace()
        if (text[index] !== ':') {
          fail()
        }
        index += 1
        skipValue()
        skipWhitespace()
        if (text[index] === ',') {
          index += 1
          continue
        }
        if (text[index] === '}') {
          index += 1
          return
        }
        fail()
      }
    } finally {
      leave()
    }
  }

  function skipArray(): void {
    index += 1
    enter()
    try {
      skipWhitespace()
      if (text[index] === ']') {
        index += 1
        return
      }
      while (true) {
        skipValue()
        skipWhitespace()
        if (text[index] === ',') {
          index += 1
          continue
        }
        if (text[index] === ']') {
          index += 1
          return
        }
        fail()
      }
    } finally {
      leave()
    }
  }

  skipValue()
  skipWhitespace()
  if (index !== text.length) {
    fail()
  }
}

/** Bounds the parsed value's node count and nesting depth without recursion. */
function assertBoundedJsonValue(document: unknown): void {
  const stack: { readonly value: unknown; readonly depth: number }[] = [
    { value: document, depth: 0 },
  ]
  let nodes = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) {
      break
    }
    nodes += 1
    if (nodes > MAX_CREDENTIAL_SCHEMA_DOCUMENT_NODES) {
      throw invalidInput(
        `document must contain at most ${MAX_CREDENTIAL_SCHEMA_DOCUMENT_NODES} JSON values`,
      )
    }
    if (current.depth > MAX_CREDENTIAL_SCHEMA_DOCUMENT_DEPTH) {
      throw invalidInput(
        `document must be nested at most ${MAX_CREDENTIAL_SCHEMA_DOCUMENT_DEPTH} levels deep`,
      )
    }
    const value = current.value
    if (Array.isArray(value)) {
      for (const item of value) {
        stack.push({ value: item, depth: current.depth + 1 })
      }
    } else if (isRecord(value)) {
      for (const item of Object.values(value)) {
        stack.push({ value: item, depth: current.depth + 1 })
      }
    }
  }
}

function assertJsonSchemaStructure(document: unknown): void {
  if (typeof document !== 'boolean' && !isRecord(document)) {
    throw invalidInput('a JSON Schema 2020-12 document must be a JSON object or boolean schema')
  }

  if (isRecord(document) && Object.hasOwn(document, '$schema')) {
    const dialect = document.$schema
    if (typeof dialect !== 'string' || !SUPPORTED_JSON_SCHEMA_DIALECTS.has(dialect)) {
      throw invalidInput('a JSON Schema document must declare the 2020-12 dialect or omit $schema')
    }
  }

  const unsupported = findUnsupportedSchemaKeyword(document)
  if (unsupported !== null) {
    throw invalidInput(`document uses the unsupported JSON Schema keyword "${unsupported.keyword}"`)
  }
}

function assertTypeMetadataDocument(document: unknown): void {
  if (!isRecord(document)) {
    throw invalidInput('SD-JWT VC Type Metadata must be a JSON object')
  }
  const result = TypeMetadataFormatSchema.safeParse(document)
  if (!result.success) {
    throw invalidInput('document is not a supported SD-JWT VC Type Metadata document')
  }
  if (result.data.vct.trim() === '' || result.data.vct.length > MAX_VCT_LENGTH) {
    throw invalidInput(
      `type metadata vct must be a non-empty string of at most ${MAX_VCT_LENGTH} characters`,
    )
  }
}

/**
 * Strictly parses and structurally checks a document before persistence and
 * returns the parsed value. The JSON Schema compile step is async and runs in
 * the #32 sandbox (`assertCredentialSchemaDocumentCompiles`); nothing is written
 * by this function.
 */
export function assertCredentialSchemaDocumentStructure(
  bytes: Uint8Array,
  kind: CredentialSchemaKind,
): unknown {
  const text = decodeUtf8(bytes)
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw invalidInput('document bytes must be valid JSON')
  }
  assertBoundedJsonValue(document)
  assertNoDuplicateMemberNames(text)
  if (kind === 'json_schema_2020_12') {
    assertJsonSchemaStructure(document)
  } else {
    assertTypeMetadataDocument(document)
  }
  return document
}

/** Placeholder reference for a compile-only sandbox evaluation. */
const REGISTRATION_REFERENCE: RulebookVersionSchemaReference = {
  formatIdentifier: 'registration',
  uri: 'urn:attestbook:registration',
  integrity: null,
}

/**
 * Compiles a JSON Schema document in the #32 schema sandbox, so untrusted
 * schemas cannot block the server process. A compile failure or a sandbox
 * resource limit is an `invalid_input`; an unavailable, busy or failed sandbox
 * is a server fault and fails closed.
 */
export async function assertCredentialSchemaDocumentCompiles(
  document: unknown,
  limits?: SchemaSandboxLimits,
): Promise<void> {
  const item: PendingSchemaDocument = {
    index: 0,
    reference: REGISTRATION_REFERENCE,
    kind: 'json_schema',
    document,
    integrityFindings: [],
  }
  const outcome = await runSchemaSandbox(
    {
      items: [item],
      input: { claims: {}, packedPayload: {}, disclosureMap: {}, vct: '' },
    },
    limits,
  )
  if (
    outcome.kind === 'timeout' ||
    outcome.kind === 'memory_exceeded' ||
    outcome.kind === 'output_exceeded'
  ) {
    throw invalidInput('document exceeds the schema compilation resource limits')
  }
  if (outcome.kind !== 'ok') {
    throw new Error(`schema compilation sandbox ${outcome.kind}`)
  }
  const application = outcome.results[0]?.application
  if (application === undefined) {
    throw invalidInput('document is not a compilable JSON Schema 2020-12 document')
  }
  const codes = application.findings.map((finding) => finding.code)
  if (
    codes.some(
      (code) =>
        code === 'invalid_json_schema' ||
        code === 'unsupported_schema_keyword' ||
        code === 'unsupported_schema_dialect',
    )
  ) {
    throw invalidInput('document is not a compilable JSON Schema 2020-12 document')
  }
}
