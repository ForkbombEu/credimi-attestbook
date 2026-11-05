// Bounded, read-only import preview for URL and JSON rulebook sources (#30).
//
// A preview never writes to the registry. It retrieves a source under the §15
// controls, parses it with limits, validates every catalog entry against the
// pinned TS11/OWF adapter, classifies conformance, records provenance and
// returns a per-entry compatibility report. The authenticated import in
// `importer.ts` only commits entries this preview marks compatible.

import { sha256Hex } from '../registry/digest'
import { OWF_PROFILE } from '../standards'
import { isRecord } from '../standards/profiles'

import { extractCatalogEntries, type CatalogEnvelopeKind } from './catalog'
import { importError } from './errors'
import { fetchImportDocument, type ImportHttpTransport } from './http'
import { encodeImportText, parseBoundedJson } from './json'
import { resolveImportLimits, type ImportLimits, type ImportLimitOverrides } from './limits'
import type { HostResolver } from './url'
import { validateImportUrl } from './url'
import {
  boundedString,
  previewCatalogEntry,
  type ConformanceClassification,
  type ImportDiagnostic,
  type ImportEntryPreview,
} from './validate'

export interface ImportCompatibility {
  readonly compatible: boolean
  readonly totalEntries: number
  readonly validEntries: number
  readonly invalidEntries: number
  /** Structurally valid entries that are still unsafe to import (e.g. bad refs). */
  readonly incompatibleEntries: number
  readonly conformantSubset: number
  readonly partial: number
  readonly notVerified: number
  readonly proseOnly: number
  readonly schemaReferenceCount: number
  readonly limitations: readonly string[]
}

export interface ImportSourceInfo {
  readonly adapter: 'url' | 'json'
  /** Final source URL for URL imports, or a caller-supplied JSON source URL. */
  readonly url: string | null
  /** Original requested URL when redirects were followed. */
  readonly requestedUrl: string | null
  /** Caller-supplied file name for JSON imports. */
  readonly name: string | null
  readonly retrievedAt: string
  readonly contentType: string | null
  readonly status: number | null
  readonly byteLength: number
  readonly contentDigest: string
  readonly redirects: readonly string[]
  readonly envelope: {
    readonly kind: CatalogEnvelopeKind
    readonly member: string | null
    readonly metadata: Readonly<Record<string, unknown>>
  }
}

export interface ImportPreview {
  readonly source: ImportSourceInfo
  readonly entries: readonly ImportEntryPreview[]
  readonly compatibility: ImportCompatibility
  readonly diagnostics: readonly ImportDiagnostic[]
}

export interface UrlImportSource {
  readonly kind: 'url'
  readonly url: string
}

export interface JsonImportSource {
  readonly kind: 'json'
  readonly content: string | Uint8Array
  /** Optional file name retained as provenance (never used as a path). */
  readonly name?: string
  /** Optional original URL retained as provenance; never fetched. */
  readonly sourceUrl?: string
}

export type ImportSource = UrlImportSource | JsonImportSource

export interface ImportOptions {
  readonly limits?: ImportLimitOverrides
  readonly transport?: ImportHttpTransport
  readonly resolveHostname?: HostResolver
  readonly now?: () => string
  /** Monotonic clock used for the fetch deadline; injectable for tests. */
  readonly monotonicNow?: () => number
}

const MAX_SOURCE_NAME_LENGTH = 255

function limitationsFor(entries: readonly ImportEntryPreview[]): string[] {
  const limitations: string[] = []
  const partial = entries.filter((entry) => entry.conformance === 'partial').length
  const notVerified = entries.filter((entry) => entry.conformance === 'not_verified').length
  const proseOnly = entries.filter((entry) => entry.conformance === 'prose_only').length
  const owf = entries.filter((entry) => entry.profile === OWF_PROFILE).length
  const references = entries.reduce((total, entry) => total + entry.schemaReferences.length, 0)

  if (partial > 0) {
    limitations.push(
      `${partial} ${partial === 1 ? 'entry is' : 'entries are'} only partially compatible with the TS11 v1.0.1 baseline`,
    )
  }
  if (owf > 0) {
    limitations.push(
      `${owf} ${owf === 1 ? 'entry uses' : 'entries use'} the OWF 0.5.4 profile and are classified as partial against TS11`,
    )
  }
  if (notVerified > 0) {
    limitations.push(
      `${notVerified} ${notVerified === 1 ? 'entry has' : 'entries have'} unverified conformance and will not be treated as TS11-conformant`,
    )
  }
  if (proseOnly > 0) {
    limitations.push(
      `${proseOnly} prose-only ${proseOnly === 1 ? 'entry is' : 'entries are'} not machine-readable`,
    )
  }
  if (references > 0) {
    limitations.push(
      'schema references are retained and bounded but are not fetched, resolved or integrity-verified by this import slice',
    )
  }
  return limitations
}

function summarize(entries: readonly ImportEntryPreview[]): ImportCompatibility {
  const count = (classification: ConformanceClassification): number =>
    entries.filter((entry) => entry.conformance === classification).length
  const validEntries = entries.filter((entry) => entry.structuralStatus === 'valid').length
  const invalidEntries = entries.length - validEntries
  const incompatibleEntries = entries.filter((entry) => !entry.compatible).length

  return {
    compatible: invalidEntries === 0 && incompatibleEntries === 0,
    totalEntries: entries.length,
    validEntries,
    invalidEntries,
    incompatibleEntries,
    conformantSubset: count('conformant_subset'),
    partial: count('partial'),
    notVerified: count('not_verified'),
    proseOnly: count('prose_only'),
    schemaReferenceCount: entries.reduce(
      (total, entry) => total + entry.schemaReferences.length,
      0,
    ),
    limitations: limitationsFor(entries),
  }
}

function assertSource(source: ImportSource): void {
  if (!isRecord(source) || (source.kind !== 'url' && source.kind !== 'json')) {
    throw importError('invalid_source', 'the import source must be a url or json source')
  }
}

interface LoadedSource {
  readonly bytes: Uint8Array
  readonly info: Omit<ImportSourceInfo, 'envelope'>
}

async function loadSource(
  source: ImportSource,
  limits: ImportLimits,
  options: ImportOptions,
): Promise<LoadedSource> {
  if (source.kind === 'url') {
    const fetched = await fetchImportDocument(source.url, {
      limits,
      ...(options.transport !== undefined ? { transport: options.transport } : {}),
      ...(options.resolveHostname !== undefined
        ? { resolveHostname: options.resolveHostname }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.monotonicNow !== undefined ? { monotonicNow: options.monotonicNow } : {}),
    })
    return {
      bytes: fetched.bytes,
      info: {
        adapter: 'url',
        url: fetched.finalUrl,
        requestedUrl: fetched.requestedUrl,
        name: null,
        retrievedAt: fetched.fetchedAt,
        contentType: fetched.contentType,
        status: fetched.status,
        byteLength: fetched.bytes.byteLength,
        contentDigest: sha256Hex(fetched.bytes),
        redirects: fetched.redirects,
      },
    }
  }

  const content = source.content
  let bytes: Uint8Array
  if (typeof content === 'string') {
    bytes = encodeImportText(content, limits)
  } else if (content instanceof Uint8Array) {
    if (content.byteLength > limits.maxSourceBytes) {
      throw importError(
        'response_too_large',
        `the import document exceeds the ${limits.maxSourceBytes}-byte limit`,
      )
    }
    bytes = content
  } else {
    throw importError('invalid_source', 'the JSON import content must be a string or Uint8Array')
  }

  const name =
    source.name === undefined ? null : (boundedString(source.name, MAX_SOURCE_NAME_LENGTH) ?? null)
  if (source.name !== undefined && name === null) {
    throw importError(
      'invalid_source',
      'the JSON import source name must be a bounded non-empty string',
    )
  }

  const sourceUrl =
    source.sourceUrl === undefined ? null : validateImportUrl(source.sourceUrl, limits).href
  const now = options.now ?? (() => new Date().toISOString())

  return {
    bytes,
    info: {
      adapter: 'json',
      url: sourceUrl,
      requestedUrl: null,
      name,
      retrievedAt: now(),
      contentType: 'application/json',
      status: null,
      byteLength: bytes.byteLength,
      contentDigest: sha256Hex(bytes),
      redirects: [],
    },
  }
}

/**
 * Retrieves (URL) or accepts (JSON) one source and returns a bounded preview
 * with per-entry structural diagnostics, conformance, compatibility and
 * provenance. No registry write happens here.
 */
export async function previewImport(
  source: ImportSource,
  options: ImportOptions = {},
): Promise<ImportPreview> {
  assertSource(source)
  const limits = resolveImportLimits(options.limits)
  const loaded = await loadSource(source, limits, options)
  const parsed = parseBoundedJson(loaded.bytes, limits)
  const catalog = extractCatalogEntries(parsed.value, limits)
  const entries = catalog.entries.map((entry, index) => previewCatalogEntry(entry, index, limits))

  const sourceInfo: ImportSourceInfo = {
    ...loaded.info,
    envelope: {
      kind: catalog.kind,
      member: catalog.member,
      metadata: catalog.envelopeMetadata,
    },
  }

  const compatibility = summarize(entries)
  const diagnostics: ImportDiagnostic[] = []
  if (compatibility.schemaReferenceCount > 0) {
    diagnostics.push({
      kind: 'not_tested',
      code: 'schema_references_not_resolved',
      message:
        'schema references are retained but were not fetched, resolved or integrity-verified by this import slice',
    })
  }

  return { source: sourceInfo, entries, compatibility, diagnostics }
}
