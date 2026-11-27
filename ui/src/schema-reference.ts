// Schema-reference helpers for the rulebook draft editor (issue #100).
//
// The browser never owns schema storage: hosted documents are registered by
// the provider-authorized API and the returned canonical URI plus SRI pin are
// written into the ordinary `schemaReferences` arrays of the existing Draft
// JSON representation. Everything here is pure so the editor can preview and
// validate locally before it sends anything, and so the tests can exercise the
// exact transformations.

import type { AttestationDraft } from './draft'
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
  readonly attestationLoS: string | null
  readonly bindingType: string | null
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
 * serialized draft document is the authoritative source and the server reports
 * the structural findings.
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
    return {
      index,
      name,
      attestationLoS: typeof record.attestationLoS === 'string' ? record.attestationLoS : null,
      bindingType: typeof record.bindingType === 'string' ? record.bindingType : null,
      formats,
      references,
    }
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
      message: 'The draft document could not be read; add the schema reference again.',
    }
  }
  const attestation = readAttestationForEdit(document.attestations, attestationIndex)
  if (attestation === null) {
    return { ok: false, message: 'That attestation is no longer in the draft.' }
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
      message: 'Fix the attestation schemaReferences array in the draft before adding a reference.',
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
      message: 'The draft document could not be read; remove the schema reference again.',
    }
  }
  const attestation = readAttestationForEdit(document.attestations, attestationIndex)
  if (attestation === null) {
    return { ok: false, message: 'That attestation is no longer in the draft.' }
  }
  const references = readReferencesForEdit(attestation)
  if (references === null) {
    return {
      ok: false,
      message:
        'Fix the attestation schemaReferences array in the draft before removing a reference.',
    }
  }
  const index = findReferenceIndex(references, formatIdentifier)
  if (index === -1) {
    return { ok: false, message: 'That schema reference is no longer in the draft.' }
  }
  references.splice(index, 1)
  attestation.schemaReferences = references
  return { ok: true, text: JSON.stringify(document.root, null, 2) }
}

/**
 * Replaces the editable members of one existing attestation. Members the form
 * does not model survive. A format that is no longer supported also drops its
 * schema reference, because a reference without its format is unrepresentable.
 */
export function replaceAttestation(
  documentText: string,
  attestationIndex: number,
  draft: AttestationDraft,
): SchemaReferenceEdit {
  const document = readDocumentForEdit(documentText)
  if (document === null) {
    return { ok: false, message: 'The draft document could not be read.' }
  }
  const attestation = readAttestationForEdit(document.attestations, attestationIndex)
  if (attestation === null) {
    return { ok: false, message: 'That attestation is no longer in the draft.' }
  }
  const references = readReferencesForEdit(attestation)
  if (references === null) {
    return {
      ok: false,
      message: 'Fix the attestation schemaReferences array in the draft before editing it.',
    }
  }
  const supportedFormats = [...draft.supportedFormats]
  document.attestations[attestationIndex] = {
    ...attestation,
    name: draft.name,
    attestationLoS: draft.attestationLoS,
    bindingType: draft.bindingType,
    supportedFormats,
    schemaReferences: references.filter((reference) =>
      supportedFormats.includes(reference.formatIdentifier as string),
    ),
  }
  return { ok: true, text: JSON.stringify(document.root, null, 2) }
}

/** Appends one attestation with no schema references yet. */
export function addAttestation(documentText: string, draft: AttestationDraft): SchemaReferenceEdit {
  const document = readDocumentForEdit(documentText)
  if (document === null) {
    return { ok: false, message: 'The draft document could not be read.' }
  }
  document.attestations.push({
    name: draft.name,
    attestationLoS: draft.attestationLoS,
    bindingType: draft.bindingType,
    supportedFormats: [...draft.supportedFormats],
    schemaReferences: [],
  })
  return { ok: true, text: JSON.stringify(document.root, null, 2) }
}

/**
 * Removes one attestation. Its format references go with it; rulebook-level
 * `schemaReferences` (attestationId null) are never touched.
 */
export function removeAttestation(
  documentText: string,
  attestationIndex: number,
): SchemaReferenceEdit {
  const document = readDocumentForEdit(documentText)
  if (document === null) {
    return { ok: false, message: 'The draft document could not be read.' }
  }
  if (readAttestationForEdit(document.attestations, attestationIndex) === null) {
    return { ok: false, message: 'That attestation is no longer in the draft.' }
  }
  document.attestations.splice(attestationIndex, 1)
  return { ok: true, text: JSON.stringify(document.root, null, 2) }
}

// ------------------------------------------------- credential types (vct/docType)
//
// The credential type is a member of the hosted JSON Schema, never a bare
// keyword at its root (contract §3): `properties.vct.const` for SD-JWT VC and
// `properties.docType.const` for mdoc, each listed in the root `required`
// array. These helpers merge it into the exact document that is registered.

export type CredentialTypeKeyword = 'vct' | 'docType'

/** The credential-type keyword a format declares, or `null` for other formats. */
export function credentialTypeKeyword(formatIdentifier: string): CredentialTypeKeyword | null {
  if (formatIdentifier === 'dc+sd-jwt') {
    return 'vct'
  }
  if (formatIdentifier === 'mso_mdoc') {
    return 'docType'
  }
  return null
}

/** The credential type a hosted schema already declares, if any. */
export function declaredCredentialType(
  schemaText: string,
  keyword: CredentialTypeKeyword,
): string | null {
  let document: unknown
  try {
    document = JSON.parse(schemaText)
  } catch {
    return null
  }
  if (!isRecord(document) || !isRecord(document.properties)) {
    return null
  }
  const entry = document.properties[keyword]
  if (!isRecord(entry) || typeof entry.const !== 'string' || entry.const === '') {
    return null
  }
  return entry.const
}

export type CredentialTypeMerge =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }

/**
 * Merges an entered credential type into a hosted JSON Schema (contract §3).
 * An existing `const` or `enum` must already contain the same value; otherwise
 * nothing is merged and registration must stop. A boolean or non-object root
 * cannot carry `properties`, and a malformed `properties`/`required` member is
 * refused instead of being rewritten.
 */
export function mergeCredentialType(
  schemaText: string,
  keyword: CredentialTypeKeyword,
  value: string,
): CredentialTypeMerge {
  const credentialType = value.trim()
  let document: unknown
  try {
    document = JSON.parse(schemaText)
  } catch {
    return { ok: false, message: 'This is not valid JSON.' }
  }
  if (!isRecord(document)) {
    return {
      ok: false,
      message: `A schema that is not a JSON object cannot declare ${keyword}; use an object schema.`,
    }
  }
  if (credentialType === '') {
    return { ok: true, text: schemaText }
  }
  const properties = document.properties
  if (properties !== undefined && !isRecord(properties)) {
    return { ok: false, message: 'The schema "properties" member must be an object.' }
  }
  const entry = isRecord(properties) ? properties[keyword] : undefined
  if (entry !== undefined && !isRecord(entry)) {
    return { ok: false, message: `The schema property "${keyword}" must be an object.` }
  }
  if (isRecord(entry)) {
    if (entry.const !== undefined && entry.const !== credentialType) {
      return {
        ok: false,
        message: `The schema declares ${keyword} const ${JSON.stringify(
          entry.const,
        )}, which does not match "${credentialType}".`,
      }
    }
    if (entry.enum !== undefined) {
      const declared = Array.isArray(entry.enum) ? entry.enum : []
      if (!declared.includes(credentialType)) {
        return {
          ok: false,
          message: `The schema's ${keyword} enum does not include "${credentialType}".`,
        }
      }
    }
  }
  const required = document.required
  if (required !== undefined && !Array.isArray(required)) {
    return { ok: false, message: 'The schema "required" member must be an array.' }
  }
  const declaredRequired: readonly unknown[] = Array.isArray(required) ? required : []
  const nextRequired: unknown[] = [...declaredRequired]
  if (!nextRequired.includes(keyword)) {
    nextRequired.push(keyword)
  }
  const nextProperties = {
    ...(isRecord(properties) ? properties : {}),
    [keyword]: { ...(isRecord(entry) ? entry : {}), const: credentialType },
  }
  return {
    ok: true,
    text: JSON.stringify(
      { ...document, properties: nextProperties, required: nextRequired },
      null,
      2,
    ),
  }
}

/**
 * Namespaces declared by an mso_mdoc JSON Schema (contract §4): top-level
 * `properties` members other than `docType` whose subschema is an object
 * schema. Their data elements are that member's properties.
 */
export function mdocNamespaces(schemaText: string): readonly string[] {
  let document: unknown
  try {
    document = JSON.parse(schemaText)
  } catch {
    return []
  }
  if (!isRecord(document) || !isRecord(document.properties)) {
    return []
  }
  return Object.entries(document.properties).flatMap(([name, subschema]) => {
    if (name === 'docType' || !isRecord(subschema)) {
      return []
    }
    const isObjectSchema = subschema.type === 'object' || isRecord(subschema.properties)
    return isObjectSchema ? [name] : []
  })
}

export interface SchemaKeywordWarning {
  readonly kind: 'format' | 'contentEncoding'
  /** Dotted path such as `properties.birth_date.format`. */
  readonly path: string
  readonly value: string
}

const SUPPORTED_CBOR_FORMATS: Readonly<Record<string, true>> = {
  date: true,
  'date-time': true,
}
const MAX_LINT_NODES = 512
const MAX_LINT_DEPTH = 32

function collectKeywordWarnings(
  node: unknown,
  path: string,
  depth: number,
  warnings: SchemaKeywordWarning[],
  budget: { count: number },
): void {
  if (budget.count >= MAX_LINT_NODES || depth > MAX_LINT_DEPTH) {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) =>
      collectKeywordWarnings(item, `${path}${index}.`, depth + 1, warnings, budget),
    )
    return
  }
  if (!isRecord(node)) {
    return
  }
  budget.count += 1
  const format = node.format
  if (typeof format === 'string' && SUPPORTED_CBOR_FORMATS[format] !== true) {
    warnings.push({ kind: 'format', path: `${path}format`, value: format })
  }
  const encoding = node.contentEncoding
  if (typeof encoding === 'string' && encoding !== 'base64') {
    warnings.push({ kind: 'contentEncoding', path: `${path}contentEncoding`, value: encoding })
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'format' || key === 'contentEncoding') {
      continue
    }
    collectKeywordWarnings(value, `${path}${key}.`, depth + 1, warnings, budget)
  }
}

/**
 * Lists `format`/`contentEncoding` values that the mdoc CBOR mapping cannot
 * apply (contract §6). Supported values are `date`, `date-time` and `base64`;
 * anything else is reported rather than silently accepted.
 */
export function cborKeywordWarnings(schemaText: string): readonly SchemaKeywordWarning[] {
  let document: unknown
  try {
    document = JSON.parse(schemaText)
  } catch {
    return []
  }
  const warnings: SchemaKeywordWarning[] = []
  collectKeywordWarnings(document, '', 0, warnings, { count: 0 })
  return warnings
}
