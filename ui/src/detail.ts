// Rulebook detail assembly and display helpers (issue #37, UI-002).
//
// The page reads only the public API. The rulebook record is required: a 404
// is the "rulebook not found" state and any other failure is an error state.
// The related collections (providers, attestation types, schema references and
// versions) degrade section by section, so one failed read does not hide the
// parts of the record that did load.

import type { CatalogApi } from './api'
import { isAbortError } from './api'
import { selectLatestVersion } from './catalog'
import type {
  Attestation,
  HostedSchema,
  Provider,
  Rulebook,
  RulebookVersion,
  SchemaReference,
} from './types'

export interface DetailAvailability {
  readonly provider: boolean
  readonly attestations: boolean
  readonly schemaReferences: boolean
  readonly versions: boolean
}

export interface RulebookDetailSnapshot {
  readonly rulebook: Rulebook
  readonly provider: Provider | null
  readonly attestations: readonly Attestation[]
  readonly schemaReferences: readonly SchemaReference[]
  readonly versions: readonly RulebookVersion[]
  readonly availability: DetailAvailability
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    return { ok: false }
  }
}

export async function loadRulebookDetail(
  api: CatalogApi,
  rulebookId: string,
  signal?: AbortSignal,
): Promise<RulebookDetailSnapshot> {
  // The rulebook itself must exist; its API error carries the 404 (not found)
  // or 5xx status the page reports.
  const rulebook = await api.getRulebook(rulebookId, signal)
  const [providers, attestations, schemaReferences, versions] = await Promise.all([
    settle(api.listProviders(signal)),
    settle(api.listAttestations(rulebookId, signal)),
    settle(api.listSchemaReferences(rulebookId, signal)),
    settle(api.listVersions(rulebookId, signal)),
  ])
  if (signal?.aborted === true) {
    throw new DOMException('The rulebook request was aborted.', 'AbortError')
  }

  const provider = providers.ok
    ? (providers.value.find((candidate) => candidate.id === rulebook.providerId) ?? null)
    : null

  return {
    rulebook,
    provider,
    attestations: attestations.ok ? attestations.value : [],
    schemaReferences: schemaReferences.ok ? schemaReferences.value : [],
    versions: versions.ok ? versions.value : [],
    availability: {
      provider: providers.ok,
      attestations: attestations.ok,
      schemaReferences: schemaReferences.ok,
      versions: versions.ok,
    },
  }
}

/** The schema references that belong to one attestation type. */
export function referencesForAttestation(
  references: readonly SchemaReference[],
  attestationId: string,
): readonly SchemaReference[] {
  return references.filter((reference) => reference.attestationId === attestationId)
}

/** Rulebook-level references, which belong to no attestation type. */
export function rulebookLevelReferences(
  references: readonly SchemaReference[],
): readonly SchemaReference[] {
  return references.filter((reference) => reference.attestationId === null)
}

/** Newest version first; the API lists them in creation order. */
export function versionsNewestFirst(
  versions: readonly RulebookVersion[],
): readonly RulebookVersion[] {
  return [...versions].sort((left, right) => {
    const byDate = right.createdAt.localeCompare(left.createdAt)
    return byDate !== 0 ? byDate : right.version.localeCompare(left.version)
  })
}

/** A stable short form of a SHA-256 digest for the version table. */
export function formatDigest(digest: string): string {
  return digest.length > 16 ? `${digest.slice(0, 16)}…` : digest
}

export interface ExternalTarget {
  readonly href: string | null
  readonly label: string
}

/**
 * Treats a reference URI as a link only when it is an absolute http(s) URL.
 * `javascript:`, `data:` and malformed values stay inert text.
 */
export function describeReference(uri: string): ExternalTarget {
  try {
    const url = new URL(uri)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { href: url.toString(), label: uri }
    }
  } catch {
    // Fall through to inert text.
  }
  return { href: null, label: uri }
}

/** Human-readable name of the attestation a schema reference belongs to. */
export function attestationNameFor(
  attestations: readonly Attestation[],
  attestationId: string | null,
): string {
  if (attestationId === null) {
    return 'Rulebook-level'
  }
  return (
    attestations.find((attestation) => attestation.id === attestationId)?.name ?? 'Unknown type'
  )
}

/** A reference-shaped value that may carry the derived hosted association. */
export interface ReferenceWithHostedSchema {
  readonly integrity: string | null
  readonly hostedSchema?: HostedSchema | null
}

/** Whether the public API associated this exact reference URI with a stored document. */
export function referenceSource(reference: ReferenceWithHostedSchema): 'hosted' | 'external' {
  return reference.hostedSchema == null ? 'external' : 'hosted'
}

/**
 * How the reference's own W3C SRI pin relates to the stored document's digest.
 * `not_hosted` is an ordinary external reference; `missing` means a hosted
 * reference records no pin; `mismatch` means the persisted pin does not identify
 * the stored bytes and must be shown as a warning rather than a success.
 */
export type IntegrityPinState = 'not_hosted' | 'matches' | 'missing' | 'mismatch'

export function hostedIntegrityState(reference: ReferenceWithHostedSchema): IntegrityPinState {
  const hosted = reference.hostedSchema
  if (hosted == null) {
    return 'not_hosted'
  }
  if (reference.integrity === null) {
    return 'missing'
  }
  return reference.integrity === hosted.integrity ? 'matches' : 'mismatch'
}

/** Download filename for the exact hosted schema bytes; stable per document. */
export function hostedSchemaDownloadName(hosted: HostedSchema): string {
  const prefix =
    hosted.kind === 'json_schema_2020_12' ? 'attestbook-json-schema' : 'attestbook-type-metadata'
  return `${prefix}-${hosted.id}.json`
}

/** The most recent version, used to label the current snapshot. */
export function latestVersion(versions: readonly RulebookVersion[]): RulebookVersion | null {
  return selectLatestVersion(versions)
}
