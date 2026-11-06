// Catalogue assembly, search and filtering (issue #36).
//
// Everything here is pure data logic so it can be unit-tested without a DOM:
// the page combines the public API responses into display rows, then filters
// those rows in the browser. No compatibility status is inferred: a catalogue
// entry is always reported as `NOT_TESTED`, because structural validation is a
// per-credential operation against a pinned rulebook version (D-8/D-17).

import type { CatalogApi } from './api'
import { isAbortError } from './api'
import type { Attestation, Provider, PublicationStatus, Rulebook, RulebookVersion } from './types'

export interface CatalogAttestation {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
}

export interface CatalogEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly providerId: string
  readonly providerName: string
  readonly providerKnown: boolean
  readonly publicationStatus: PublicationStatus
  readonly version: string | null
  readonly versionStatus: PublicationStatus | null
  readonly versionCount: number
  readonly attestations: readonly CatalogAttestation[]
  readonly supportedFormats: readonly string[]
  readonly sourceUrl: string | null
  readonly applicableSpec: string
  readonly updatedAt: string
  /** `true` when the per-rulebook attestation or version read failed. */
  readonly detailsUnavailable: boolean
}

export interface CatalogSnapshot {
  readonly entries: readonly CatalogEntry[]
  /** Filtered total reported by the API; larger than `entries` if truncated. */
  readonly total: number
  readonly truncated: boolean
}

export type StatusFilter = 'all' | PublicationStatus

export interface CatalogFilters {
  readonly query: string
  readonly providerId: string
  readonly status: StatusFilter
}

export const EMPTY_FILTERS: CatalogFilters = {
  query: '',
  providerId: 'all',
  status: 'all',
}

export const PUBLICATION_STATUS_LABELS: Readonly<Record<PublicationStatus, string>> = {
  draft: 'Draft',
  published: 'Published',
  historical: 'Historical',
}

/**
 * The latest version to show for a rulebook: the most recently created
 * published version, or the most recently created version of any status when
 * nothing is published yet. Versions arrive in creation order.
 */
export function selectLatestVersion(versions: readonly RulebookVersion[]): RulebookVersion | null {
  const ordered = [...versions].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const published = ordered.filter((version) => version.status === 'published')
  return published.at(-1) ?? ordered.at(-1) ?? null
}

export function buildCatalogEntry(
  rulebook: Rulebook,
  provider: Provider | undefined,
  attestations: readonly Attestation[],
  versions: readonly RulebookVersion[],
  detailsUnavailable = false,
): CatalogEntry {
  const latest = selectLatestVersion(versions)
  const catalogAttestations = attestations.map((attestation) => ({
    name: attestation.name,
    attestationLoS: attestation.attestationLoS,
    bindingType: attestation.bindingType,
    supportedFormats: [...attestation.supportedFormats],
  }))
  const formats = [
    ...new Set(catalogAttestations.flatMap((attestation) => attestation.supportedFormats)),
  ].sort()

  return {
    id: rulebook.id,
    name: rulebook.name,
    description: rulebook.description,
    providerId: rulebook.providerId,
    providerName: provider?.name ?? rulebook.providerId,
    providerKnown: provider !== undefined,
    publicationStatus: rulebook.publicationStatus,
    version: latest?.version ?? null,
    versionStatus: latest?.status ?? null,
    versionCount: versions.length,
    attestations: catalogAttestations,
    supportedFormats: formats,
    sourceUrl: rulebook.sourceUrl,
    applicableSpec: rulebook.applicableSpec,
    updatedAt: rulebook.updatedAt,
    detailsUnavailable,
  }
}

function entryHaystack(entry: CatalogEntry): string {
  return [
    entry.name,
    entry.description,
    entry.providerName,
    entry.applicableSpec,
    entry.version ?? '',
    ...entry.attestations.map((attestation) => attestation.name),
    ...entry.attestations.map((attestation) => attestation.attestationLoS),
    ...entry.attestations.map((attestation) => attestation.bindingType),
    ...entry.supportedFormats,
  ]
    .join(' ')
    .toLowerCase()
}

/**
 * Case-insensitive search across the fields the catalogue displays. Every
 * whitespace-separated term must match, so "pid issuer" narrows a result.
 */
export function matchesQuery(entry: CatalogEntry, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    return true
  }
  const haystack = entryHaystack(entry)
  return terms.every((term) => haystack.includes(term))
}

export function filterEntries(
  entries: readonly CatalogEntry[],
  filters: CatalogFilters,
): readonly CatalogEntry[] {
  return entries.filter(
    (entry) =>
      matchesQuery(entry, filters.query) &&
      (filters.providerId === 'all' || entry.providerId === filters.providerId) &&
      (filters.status === 'all' || entry.publicationStatus === filters.status),
  )
}

export function isFiltering(filters: CatalogFilters): boolean {
  return filters.query.trim() !== '' || filters.providerId !== 'all' || filters.status !== 'all'
}

export interface SourceDescription {
  /** Absolute http(s) URL, or `null` when the entry has no followable source. */
  readonly href: string | null
  readonly label: string
}

/** Renders a source URL as a safe link; non-http(s) values stay plain text. */
export function describeSource(sourceUrl: string | null): SourceDescription {
  if (sourceUrl === null || sourceUrl === '') {
    return { href: null, label: 'Locally authored' }
  }
  try {
    const url = new URL(sourceUrl)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { href: url.toString(), label: url.host }
    }
  } catch {
    // Fall through to the plain-text form below.
  }
  return { href: null, label: sourceUrl }
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

/** Formats an ISO timestamp for display; an unparseable value is shown as-is. */
export function formatDate(isoTimestamp: string): string {
  const milliseconds = Date.parse(isoTimestamp)
  if (Number.isNaN(milliseconds)) {
    return isoTimestamp
  }
  return dateFormatter.format(new Date(milliseconds))
}

export function providerOptions(
  entries: readonly CatalogEntry[],
): readonly { readonly id: string; readonly name: string }[] {
  const byId = new Map<string, string>()
  for (const entry of entries) {
    byId.set(entry.providerId, entry.providerName)
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Loads the catalogue from the public API. A single failed per-rulebook read
 * marks that row as incomplete instead of blanking the whole catalogue; a
 * failed listing or provider read fails the page.
 */
export async function loadCatalog(api: CatalogApi, signal?: AbortSignal): Promise<CatalogSnapshot> {
  const [providers, page] = await Promise.all([
    api.listProviders(signal),
    api.listRulebooks(signal),
  ])
  const providersById = new Map(providers.map((provider) => [provider.id, provider]))

  const details = await Promise.allSettled(
    page.data.map(async (rulebook) => {
      const [attestations, versions] = await Promise.all([
        api.listAttestations(rulebook.id, signal),
        api.listVersions(rulebook.id, signal),
      ])
      return { attestations, versions }
    }),
  )

  if (signal?.aborted === true) {
    throw new DOMException('The catalog request was aborted.', 'AbortError')
  }
  for (const result of details) {
    if (result.status === 'rejected' && isAbortError(result.reason)) {
      throw result.reason
    }
  }

  const entries = page.data.map((rulebook, index) => {
    const provider = providersById.get(rulebook.providerId)
    const result = details[index]
    if (result?.status === 'fulfilled') {
      return buildCatalogEntry(rulebook, provider, result.value.attestations, result.value.versions)
    }
    return buildCatalogEntry(rulebook, provider, [], [], true)
  })

  return {
    entries,
    total: page.pagination.total,
    truncated: page.pagination.total > entries.length,
  }
}
