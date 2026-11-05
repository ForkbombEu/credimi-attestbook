// Catalog-envelope recognition for URL/JSON imports (issue #30).
//
// The initial supported sources are a single SchemaMeta document, a bare array
// of SchemaMeta entries, and the common catalog envelopes observed in the
// survey: SIROS `{ data: [...] }`, FIDES `{ content: [...] }` and generic
// `{ schemas | entries | rulebooks: [...] }` lists. JWS compact catalogue
// responses are not supported by this slice and are reported as such rather
// than being silently passed to `JSON.parse`.

import { importError } from './errors'
import type { ImportLimits } from './limits'
import { isRecord } from '../standards/profiles'

/** Supported catalog document shapes. */
export type CatalogEnvelopeKind = 'single' | 'array' | 'catalog'

/** Catalog envelope members recognised by this slice, in precedence order. */
export const CATALOG_ENVELOPE_MEMBERS = [
  'data',
  'content',
  'schemas',
  'entries',
  'rulebooks',
] as const

/** Non-structural envelope metadata retained as source provenance. */
const ENVELOPE_METADATA_MEMBERS = [
  'schemaVersion',
  'catalogType',
  'lastUpdated',
  'updatedAt',
  'version',
] as const

export interface ExtractedCatalog {
  readonly kind: CatalogEnvelopeKind
  /** Envelope member that carried the entries, e.g. `data`; `null` otherwise. */
  readonly member: string | null
  readonly entries: readonly unknown[]
  readonly envelopeMetadata: Readonly<Record<string, unknown>>
}

const SCHEMA_META_CUES = [
  'schemaURIs',
  'rulebookURI',
  'attestationLoS',
  'bindingType',
  'supportedFormats',
] as const

function looksLikeSchemaMeta(record: Record<string, unknown>): boolean {
  return SCHEMA_META_CUES.some((member) => Object.prototype.hasOwnProperty.call(record, member))
}

function readEnvelopeMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  for (const member of ENVELOPE_METADATA_MEMBERS) {
    if (!Object.prototype.hasOwnProperty.call(record, member)) {
      continue
    }
    const value = record[member]
    if (typeof value === 'string') {
      metadata[member] = value.length <= 200 ? value : value.slice(0, 200)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      metadata[member] = value
    }
  }
  return metadata
}

/**
 * Extracts the SchemaMeta entries from a parsed import document and enforces
 * the envelope entry limit. Entry structure is validated per entry by the
 * preview, so one malformed entry does not hide the others.
 */
export function extractCatalogEntries(document: unknown, limits: ImportLimits): ExtractedCatalog {
  if (Array.isArray(document)) {
    return finish('array', null, document, {}, limits)
  }

  if (!isRecord(document)) {
    throw importError(
      'invalid_catalog',
      'the import document must be a SchemaMeta object, an array of entries or a supported catalog envelope',
    )
  }

  if (looksLikeSchemaMeta(document)) {
    return { kind: 'single', member: null, entries: [document], envelopeMetadata: {} }
  }

  for (const member of CATALOG_ENVELOPE_MEMBERS) {
    if (!Object.prototype.hasOwnProperty.call(document, member)) {
      continue
    }
    const entries = document[member]
    if (!Array.isArray(entries)) {
      throw importError('invalid_catalog', `catalog member "${member}" must be an array`, member)
    }
    return finish('catalog', member, entries, readEnvelopeMetadata(document), limits)
  }

  // A JWS compact serialization is a string, so it is caught above; an object
  // with no recognised entries is not a supported catalog in this slice.
  throw importError(
    'invalid_catalog',
    `the import document is not a supported catalog; expected one of ${CATALOG_ENVELOPE_MEMBERS.join(', ')}`,
  )
}

function finish(
  kind: CatalogEnvelopeKind,
  member: string | null,
  entries: readonly unknown[],
  envelopeMetadata: Readonly<Record<string, unknown>>,
  limits: ImportLimits,
): ExtractedCatalog {
  if (entries.length === 0) {
    throw importError('invalid_catalog', 'the import document contains no catalog entries')
  }
  if (entries.length > limits.maxCatalogEntries) {
    throw importError(
      'entry_limit',
      `the import document contains more than ${limits.maxCatalogEntries} catalog entries`,
    )
  }
  return { kind, member, entries, envelopeMetadata }
}
