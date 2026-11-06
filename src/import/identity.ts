// Deterministic import identity and content fingerprints for safe re-import
// (issue #31).
//
// Re-import must recognise the rulebook created by a previous import of the
// same external entry. The identity is derived only from stable inputs:
//
//   entry key   = SHA-256(source identity + entry identity)
//   fingerprint = SHA-256(normalized rulebook content)
//
// The source identity is the requested https URL (not the post-redirect final
// URL, so a changed redirect does not look like a new source), the
// caller-supplied JSON source URL, the JSON file name, or — for an anonymous
// JSON document with no name or URL — the exact source digest. The entry
// identity prefers the source's own `id`, then the derived rulebook name.
//
// The content fingerprint exists because the source digest is byte-exact (D-6):
// re-serialized JSON (key order, whitespace) has a different digest but the
// same semantic content. The fingerprint canonicalizes object key order, while
// array order stays significant, so a serialization-only change is recognised
// and reported instead of being silently ignored (R5.2, R-17). It is computed
// from the registry-normalized content (the form a write stores), never from
// the raw caller input, so trimming and URL normalization cannot make an
// unchanged source look changed. It is a comparison aid only; it is not
// advertised as a semantic-identity or standards-conformance claim.

import { sha256Hex } from '../registry/digest'
import type { AttestationType, JsonObject, Rulebook, SchemaReference } from '../registry/types'

import type { ImportSourceInfo } from './preview'
import type { ImportEntryPreview } from './validate'

/** Format marker carried inside the canonicalized content fingerprint bytes. */
export const IMPORT_CONTENT_FORMAT = 'attestbook.import-content@1'

/** Format marker carried inside the entry-identity bytes. */
export const IMPORT_ENTRY_FORMAT = 'attestbook.import-entry@1'

/** A schema reference as carried by the normalized import content. */
export interface ImportContentSchemaReference {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity: string | null
  readonly metadata: JsonObject
}

/** An attestation type as carried by the normalized import content. */
export interface ImportContentAttestation {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
  readonly metadata: JsonObject
  readonly schemaReferences: readonly ImportContentSchemaReference[]
}

/** The content that a re-import compares; provenance and timestamps are excluded. */
export interface ImportContent {
  readonly name: string
  readonly description: string
  readonly sourceUrl: string | null
  readonly applicableSpec: string
  readonly attestations: readonly ImportContentAttestation[]
  /** Rulebook-level schema references, outside any attestation type. */
  readonly schemaReferences: readonly ImportContentSchemaReference[]
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item))
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item !== undefined) {
        sorted[key] = canonicalize(item)
      }
    }
    return sorted
  }
  return value
}

/**
 * Serializes a JSON value with object keys sorted recursively, so two
 * semantically equal documents with a different key order produce equal text.
 * Array order stays significant. The values come from bounded JSON parsing or
 * validated registry input, so `JSON.stringify` cannot fail here.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** The stable source identity used to key imported entries. */
export function importSourceIdentity(source: ImportSourceInfo): string {
  if (source.adapter === 'json') {
    if (source.url !== null) {
      return `url:${source.url}`
    }
    if (source.name !== null) {
      return `name:${source.name}`
    }
    // No name or URL: identical bytes are treated as the same source, changed
    // bytes as a different one. This keeps duplicate detection safe (it never
    // matches an unrelated anonymous document) at the cost of not reporting a
    // content change for anonymous JSON; documented in docs/import.md.
    return `content:${source.contentDigest}`
  }
  return `url:${source.requestedUrl ?? source.url ?? 'unknown'}`
}

/** The stable entry identity within one source. */
export function importEntryIdentity(entry: ImportEntryPreview): string {
  if (entry.id !== null) {
    return `id:${entry.id}`
  }
  if (entry.name !== null) {
    return `name:${entry.name}`
  }
  return `index:${entry.index}`
}

/** The deterministic key stored on the rulebook (`rulebooks.import_key`). */
export function importEntryKey(source: ImportSourceInfo, entry: ImportEntryPreview): string {
  return sha256Hex(
    Buffer.from(
      stableJson({
        format: IMPORT_ENTRY_FORMAT,
        source: importSourceIdentity(source),
        entry: importEntryIdentity(entry),
      }),
      'utf8',
    ),
  )
}

/** Lowercase hex SHA-256 of the normalized rulebook content. */
export function importContentFingerprint(content: ImportContent): string {
  return sha256Hex(Buffer.from(stableJson({ format: IMPORT_CONTENT_FORMAT, ...content }), 'utf8'))
}

function toContentReference(reference: SchemaReference): ImportContentSchemaReference {
  return {
    formatIdentifier: reference.formatIdentifier,
    uri: reference.uri,
    integrity: reference.integrity,
    metadata: reference.metadata,
  }
}

/**
 * Rebuilds the normalized content of a rulebook. It is the only content
 * builder: the importer runs it over the registry-normalized input before a
 * write and over the stored rulebook on re-import, so a local edit or a source
 * change is visible as a different fingerprint.
 */
export function storedImportContent(
  rulebook: Rulebook,
  attestations: readonly AttestationType[],
  schemaReferences: readonly SchemaReference[],
): ImportContent {
  const referencesByAttestation = new Map<string, SchemaReference[]>()
  const rulebookLevel: SchemaReference[] = []
  for (const reference of schemaReferences) {
    if (reference.attestationId === null) {
      rulebookLevel.push(reference)
      continue
    }
    const existing = referencesByAttestation.get(reference.attestationId)
    if (existing === undefined) {
      referencesByAttestation.set(reference.attestationId, [reference])
    } else {
      existing.push(reference)
    }
  }

  return {
    name: rulebook.name,
    description: rulebook.description,
    sourceUrl: rulebook.sourceUrl,
    applicableSpec: rulebook.applicableSpec,
    attestations: attestations.map((attestation) => ({
      name: attestation.name,
      attestationLoS: attestation.attestationLoS,
      bindingType: attestation.bindingType,
      supportedFormats: [...attestation.supportedFormats],
      metadata: attestation.metadata,
      schemaReferences: (referencesByAttestation.get(attestation.id) ?? []).map(toContentReference),
    })),
    schemaReferences: rulebookLevel.map(toContentReference),
  }
}
