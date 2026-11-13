// Schema-reference helpers for the rulebook draft editor (issue #100).
//
// The browser never owns schema storage: hosted documents are registered by
// the provider-authorized API and the returned canonical URI plus SRI pin are
// written into the ordinary `schemaReferences` arrays of the existing Draft
// JSON representation. Everything here is pure so the editor can preview and
// validate locally before it sends anything, and so the tests can exercise the
// exact transformations.

import type { DraftContentDocument, DraftSchemaReference, DraftSchemaReferenceInput } from './types'

/** Profile sent for a JSON Schema document accepted by the hosted workflow. */
export const HOSTED_SCHEMA_KIND = 'json_schema_2020_12' as const

/** Hard bound the registration API enforces on the exact document bytes. */
export const MAX_HOSTED_SCHEMA_BYTES = 262_144

const SUPPORTED_JSON_SCHEMA_DIALECTS = new Set([
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/schema#',
])

/** W3C Subresource Integrity pin (`sha256-…`, `sha384-…` or `sha512-…`). */
const INTEGRITY_PATTERN = /^(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/

export type HostedSchemaPreview =
  | {
      readonly ok: true
      /** Exact UTF-8 byte length that would be registered. */
      readonly byteLength: number
      /** Human title from `title`, when the document carries one. */
      readonly title: string | null
      /** Declared `$schema` dialect, if any. */
      readonly dialect: string | null
      /** Number of top-level keywords, for a quick shape preview. */
      readonly keywordCount: number
    }
  | { readonly ok: false; readonly message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

/**
 * Parses a pasted or uploaded JSON Schema without executing or fetching
 * anything. It mirrors the registration API's structural gate closely enough
 * to give immediate feedback: valid JSON, a 2020-12 object or boolean document,
 * no `$schema` pointing at another dialect, and the byte bound.
 */
export function previewHostedSchema(text: string): HostedSchemaPreview {
  if (text.trim() === '') {
    return { ok: false, message: 'Paste a JSON Schema or choose a .json file.' }
  }
  const byteLength = utf8ByteLength(text)
  if (byteLength > MAX_HOSTED_SCHEMA_BYTES) {
    return {
      ok: false,
      message: `The schema is ${byteLength} bytes; the limit is 256 KiB (262144 bytes).`,
    }
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return { ok: false, message: 'This is not valid JSON.' }
  }
  if (typeof document !== 'boolean' && !isRecord(document)) {
    return { ok: false, message: 'A JSON Schema must be a JSON object or a boolean.' }
  }
  if (isRecord(document) && Object.hasOwn(document, '$schema')) {
    const dialect = document.$schema
    if (typeof dialect !== 'string' || !SUPPORTED_JSON_SCHEMA_DIALECTS.has(dialect)) {
      return {
        ok: false,
        message: 'Declare the JSON Schema 2020-12 dialect in $schema, or omit $schema.',
      }
    }
  }
  const title =
    isRecord(document) && typeof document.title === 'string' && document.title.trim() !== ''
      ? document.title.trim()
      : null
  const dialect =
    isRecord(document) && typeof document.$schema === 'string' ? document.$schema : null
  return {
    ok: true,
    byteLength,
    title,
    dialect,
    keywordCount: isRecord(document) ? Object.keys(document).length : 1,
  }
}

export interface ExternalSchemaValidation {
  /** Form-level errors, keyed by field. */
  readonly errors: { readonly uri?: string; readonly integrity?: string }
  /** The normalized reference to insert; only meaningful when there are no errors. */
  readonly reference: DraftSchemaReferenceInput | null
}

/**
 * Validates the external-reference path. The schema must be addressed by an
 * absolute `https` URL; an SRI value, when supplied, must use a supported
 * algorithm. The URL is normalized the same way the API normalizes it.
 */
export function validateExternalSchema(uri: string, integrity: string): ExternalSchemaValidation {
  const errors: { uri?: string; integrity?: string } = {}
  const rawUri = uri.trim()
  let normalized: string | null = null
  if (rawUri === '') {
    errors.uri = 'A schema URL is required.'
  } else {
    try {
      const parsed = new URL(rawUri)
      if (parsed.protocol !== 'https:') {
        errors.uri = 'Use an absolute https:// schema URL.'
      } else if (parsed.username !== '' || parsed.password !== '') {
        errors.uri = 'The schema URL must not embed credentials.'
      } else {
        normalized = parsed.href
      }
    } catch {
      errors.uri = 'Use an absolute https:// schema URL.'
    }
  }

  const rawIntegrity = integrity.trim()
  if (rawIntegrity !== '' && !INTEGRITY_PATTERN.test(rawIntegrity)) {
    errors.integrity = 'Use a W3C SRI value such as sha256-<base64>, or leave it empty.'
  }

  if (Object.keys(errors).length > 0 || normalized === null) {
    return { errors, reference: null }
  }
  return {
    errors,
    reference: {
      formatIdentifier: '',
      uri: normalized,
      ...(rawIntegrity === '' ? {} : { integrity: rawIntegrity }),
    },
  }
}

/** One attestation as the schema controls present it. */
export interface SchemaControlAttestation {
  readonly index: number
  readonly name: string
  /** Supported formats first, then formats only present on existing references. */
  readonly formats: readonly string[]
  readonly references: readonly DraftSchemaReference[]
}

function attestationName(record: Record<string, unknown>, index: number): string {
  return typeof record.name === 'string' && record.name.trim() !== ''
    ? record.name.trim()
    : `Attestation ${index + 1}`
}

/**
 * Projects the parsed draft document into the attestation/format rows the
 * controls render. Malformed members are tolerated rather than throwing: the
 * raw JSON editor is the authoritative source and the server reports the
 * structural findings.
 */
export function schemaControlAttestations(
  document: DraftContentDocument,
): readonly SchemaControlAttestation[] {
  return (document.attestations as readonly unknown[]).map((entry, index) => {
    const record = isRecord(entry) ? entry : {}
    const name = attestationName(record, index)

    const supported = Array.isArray(record.supportedFormats)
      ? record.supportedFormats.filter((format): format is string => typeof format === 'string')
      : []
    const references: DraftSchemaReference[] = []
    if (Array.isArray(record.schemaReferences)) {
      for (const raw of record.schemaReferences) {
        if (!isRecord(raw)) {
          continue
        }
        if (typeof raw.formatIdentifier !== 'string' || typeof raw.uri !== 'string') {
          continue
        }
        references.push({
          formatIdentifier: raw.formatIdentifier,
          uri: raw.uri,
          integrity: typeof raw.integrity === 'string' ? raw.integrity : null,
        })
      }
    }

    const formats: string[] = []
    for (const format of [
      ...supported,
      ...references.map((reference) => reference.formatIdentifier),
    ]) {
      if (!formats.includes(format)) {
        formats.push(format)
      }
    }
    return { index, name, formats, references }
  })
}

function referenceFor(
  references: readonly DraftSchemaReference[],
  formatIdentifier: string,
): DraftSchemaReference | null {
  return references.find((reference) => reference.formatIdentifier === formatIdentifier) ?? null
}

/** The existing reference for one attestation/format row, if any. */
export function referenceForFormat(
  attestation: SchemaControlAttestation,
  formatIdentifier: string,
): DraftSchemaReference | null {
  return referenceFor(attestation.references, formatIdentifier)
}

export type SchemaReferenceEdit =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }

function readDocumentForEdit(
  documentText: string,
): { readonly root: Record<string, unknown>; readonly attestations: unknown[] } | null {
  let root: unknown
  try {
    root = JSON.parse(documentText)
  } catch {
    return null
  }
  if (!isRecord(root) || !Array.isArray(root.attestations)) {
    return null
  }
  return { root, attestations: root.attestations }
}

function readAttestationForEdit(
  attestations: readonly unknown[],
  index: number,
): Record<string, unknown> | null {
  if (!Number.isInteger(index) || index < 0 || index >= attestations.length) {
    return null
  }
  const attestation = attestations[index]
  return isRecord(attestation) ? attestation : null
}

type EditableSchemaReference = Record<string, unknown>

/**
 * Copies every existing reference object unchanged so members the UI does not
 * model (such as reference `metadata`) survive an edit on another format. A
 * reference that lacks a string `formatIdentifier`/`uri` is malformed, so the
 * edit refuses rather than silently rewriting it.
 */
function readReferencesForEdit(
  attestation: Record<string, unknown>,
): EditableSchemaReference[] | null {
  if (attestation.schemaReferences === undefined) {
    return []
  }
  if (!Array.isArray(attestation.schemaReferences)) {
    return null
  }
  const references: EditableSchemaReference[] = []
  for (const raw of attestation.schemaReferences) {
    if (!isRecord(raw)) {
      return null
    }
    if (typeof raw.formatIdentifier !== 'string' || typeof raw.uri !== 'string') {
      return null
    }
    references.push(raw)
  }
  return references
}

function findReferenceIndex(
  references: readonly EditableSchemaReference[],
  formatIdentifier: string,
): number {
  return references.findIndex((reference) => reference.formatIdentifier === formatIdentifier)
}

/**
 * Inserts (or replaces, because the API allows one reference per format) a
 * schema reference on one attestation. The edit works on the whole parsed
 * document so unknown members and the rulebook-level `schemaReferences` array
 * are preserved; only that one attestation's references change.
 */
export function insertSchemaReference(
  documentText: string,
  attestationIndex: number,
  reference: DraftSchemaReferenceInput,
  expectedName?: string,
): SchemaReferenceEdit {
  const document = readDocumentForEdit(documentText)
  if (document === null) {
    return {
      ok: false,
      message: 'Fix the Draft JSON before adding a schema reference.',
    }
  }
  const attestation = readAttestationForEdit(document.attestations, attestationIndex)
  if (attestation === null) {
    return { ok: false, message: 'That attestation is no longer in the Draft JSON.' }
  }
  if (
    expectedName !== undefined &&
    attestationName(attestation, attestationIndex) !== expectedName.trim()
  ) {
    return {
      ok: false,
      message:
        'The attestation changed while the schema was being registered; insert the reference again.',
    }
  }
  const references = readReferencesForEdit(attestation)
  if (references === null) {
    return {
      ok: false,
      message: 'Fix the attestation schemaReferences array before adding a reference.',
    }
  }
  const next = [...references]
  const index = findReferenceIndex(next, reference.formatIdentifier)
  const inserted: EditableSchemaReference = { ...reference }
  if (index === -1) {
    next.push(inserted)
  } else {
    next[index] = inserted
  }
  attestation.schemaReferences = next
  return { ok: true, text: JSON.stringify(document.root, null, 2) }
}

/** Removes the reference for one attestation/format row. */
export function removeSchemaReference(
  documentText: string,
  attestationIndex: number,
  formatIdentifier: string,
): SchemaReferenceEdit {
  const document = readDocumentForEdit(documentText)
  if (document === null) {
    return {
      ok: false,
      message: 'Fix the Draft JSON before removing a schema reference.',
    }
  }
  const attestation = readAttestationForEdit(document.attestations, attestationIndex)
  if (attestation === null) {
    return { ok: false, message: 'That attestation is no longer in the Draft JSON.' }
  }
  const references = readReferencesForEdit(attestation)
  if (references === null) {
    return {
      ok: false,
      message: 'Fix the attestation schemaReferences array before removing a reference.',
    }
  }
  const index = findReferenceIndex(references, formatIdentifier)
  if (index === -1) {
    return { ok: false, message: 'That schema reference is no longer in the Draft JSON.' }
  }
  references.splice(index, 1)
  attestation.schemaReferences = references
  return { ok: true, text: JSON.stringify(document.root, null, 2) }
}
