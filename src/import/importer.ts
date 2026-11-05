// Authenticated commit of a compatible import preview (issue #30).
//
// The importer authenticates the caller before touching the network, builds
// the preview, refuses any source with an incompatible entry (so a catalog
// with a broken entry is never partially imported), then creates draft
// rulebooks through the existing registry service. Source URL and provenance
// (adapter, retrieval time, content digest, profile, conformance and the
// source's own signal) are stored on the rulebook and never merged into a
// standards document.
//
// Re-import idempotency and conflict detection are issue #31; this slice only
// creates the initial draft.

import type { Registry } from '../registry/registry'
import type { JsonObject, Rulebook } from '../registry/types'

import { importError } from './errors'
import { previewImport, type ImportOptions, type ImportPreview, type ImportSource } from './preview'
import type { ImportEntryPreview } from './validate'

export interface ImportResult {
  readonly preview: ImportPreview
  readonly rulebooks: readonly Rulebook[]
}

export interface RulebookImporterOptions extends ImportOptions {
  readonly registry: Registry
}

function buildProvenance(
  entry: ImportEntryPreview,
  preview: ImportPreview,
  importedAt: string,
): JsonObject {
  const source = preview.source
  return {
    adapter: source.adapter,
    ...(source.url !== null ? { sourceUrl: source.url } : {}),
    ...(source.requestedUrl !== null && source.requestedUrl !== source.url
      ? { requestedUrl: source.requestedUrl }
      : {}),
    ...(source.name !== null ? { sourceName: source.name } : {}),
    retrievedAt: source.retrievedAt,
    contentType: source.contentType,
    byteLength: source.byteLength,
    contentDigest: source.contentDigest,
    redirects: [...source.redirects],
    envelope: {
      kind: source.envelope.kind,
      ...(source.envelope.member !== null ? { member: source.envelope.member } : {}),
      metadata: source.envelope.metadata,
    },
    entryIndex: entry.index,
    ...(entry.id !== null ? { sourceId: entry.id } : {}),
    ...(entry.version !== null ? { sourceVersion: entry.version } : {}),
    profile: entry.profile,
    conformance: entry.conformance,
    ...(entry.sourceConformance !== null ? { sourceConformance: entry.sourceConformance } : {}),
    importedAt,
  }
}

function toCreateRulebookInput(
  entry: ImportEntryPreview,
  preview: ImportPreview,
  importedAt: string,
) {
  const canonical = entry.canonical
  if (canonical === null || entry.profile === null) {
    throw importError('import_rejected', 'the import entry has no validated document')
  }

  const name = entry.name ?? `Imported rulebook ${entry.version ?? entry.index}`.slice(0, 200)

  return {
    name,
    description: entry.description,
    ...(preview.source.url !== null ? { sourceUrl: preview.source.url } : {}),
    provenance: buildProvenance(entry, preview, importedAt),
    applicableSpec: entry.profile,
    attestations: [
      {
        name,
        attestationLoS: canonical.attestationLoS,
        bindingType: canonical.bindingType,
        supportedFormats: [...canonical.supportedFormats],
        schemaReferences: entry.schemaReferences.map((reference) => ({
          formatIdentifier: reference.formatIdentifier,
          uri: reference.uri,
          ...(reference.integrity !== undefined ? { integrity: reference.integrity } : {}),
          ...(reference.metadata !== undefined ? { metadata: reference.metadata } : {}),
        })),
        metadata: {
          profile: entry.profile,
          conformance: entry.conformance,
        },
      },
    ],
  }
}

/**
 * Service-level import entry point. The HTTP API (#34/#35) will expose the
 * preview and import operations; this class keeps the security and persistence
 * seams testable without a transport.
 */
export class RulebookImporter {
  private readonly registry: Registry
  private readonly options: ImportOptions
  private readonly now: () => string

  constructor(options: RulebookImporterOptions) {
    const { registry, ...importOptions } = options
    this.registry = registry
    this.options = importOptions
    this.now = options.now ?? (() => new Date().toISOString())
  }

  /** Read-only preview; performs no registry write. */
  preview(source: ImportSource): Promise<ImportPreview> {
    return previewImport(source, this.options)
  }

  /**
   * Retrieves, validates and commits every entry of one source as a draft
   * rulebook. Authentication happens before any network request. An
   * incompatible entry aborts the whole import before any write.
   */
  async import(accessToken: string, source: ImportSource): Promise<ImportResult> {
    this.registry.authenticate(accessToken)
    const preview = await previewImport(source, this.options)

    const incompatible = preview.entries.filter((entry) => !entry.compatible)
    if (incompatible.length > 0) {
      const indexes = incompatible.map((entry) => entry.index).join(', ')
      throw importError(
        'import_rejected',
        `the import source contains incompatible entries (${indexes}); no rulebook was written`,
      )
    }

    const importedAt = this.now()
    const rulebooks = preview.entries.map((entry) =>
      this.registry.createRulebook(accessToken, toCreateRulebookInput(entry, preview, importedAt)),
    )

    return { preview, rulebooks }
  }
}
