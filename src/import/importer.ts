// Authenticated commit of a compatible import preview (issues #30 and #31).
//
// The importer authenticates the caller before touching the network, builds
// the preview, refuses any source with an incompatible entry (so a catalog
// with a broken entry is never partially imported), then commits every entry
// that is new through one registry transaction.
//
// Re-import is safe by construction:
//
// * every entry has a deterministic import key (source identity + entry
//   identity), stored on the rulebook as `import_key`; a re-import of the same
//   entry finds that rulebook instead of creating a duplicate;
// * unchanged normalized content is a no-op, so re-importing an unchanged
//   source is idempotent;
// * changed content is never written over an existing rulebook. It is reported
//   as a typed conflict that distinguishes a locally edited draft, a rulebook
//   with published/historical versions, an unmodified draft whose source
//   advanced, and a source version change with identical content.
//
// Source URL and provenance (adapter, retrieval time, source digest, entry
// content fingerprint, profile, conformance and the source's own signal) are
// stored on the rulebook and never merged into a standards document.

import { isRegistryError } from '../registry/errors'
import type { Registry } from '../registry/registry'
import type { CreateRulebookInput, JsonObject, Rulebook } from '../registry/types'

import { importError } from './errors'
import {
  importContentFingerprint,
  importEntryIdentity,
  importEntryKey,
  storedImportContent,
} from './identity'
import { previewImport, type ImportOptions, type ImportPreview, type ImportSource } from './preview'
import type { ImportDiagnostic, ImportEntryPreview } from './validate'

/** What happened to one entry of an import source. */
export type ImportEntryDisposition = 'created' | 'unchanged' | 'conflict'

/**
 * Why changed content was not applied. Every code preserves the existing
 * rulebook: the importer never overwrites local or published content.
 */
export type ImportConflictCode =
  'published_content' | 'locally_modified' | 'source_changed' | 'source_version_changed'

/** A reported re-import conflict; the existing rulebook was left unchanged. */
export interface ImportConflict {
  readonly code: ImportConflictCode
  readonly message: string
  readonly rulebookId: string
  /** Published and historical version labels preserved by this conflict. */
  readonly publishedVersions: readonly string[]
  /** True when the stored draft no longer matches the content last imported. */
  readonly locallyModified: boolean
  readonly existingContentFingerprint: string
  readonly incomingContentFingerprint: string
  readonly existingSourceVersion: string | null
  readonly incomingSourceVersion: string | null
}

/** The outcome for one preview entry. */
export interface ImportEntryResult {
  readonly index: number
  readonly disposition: ImportEntryDisposition
  /** Rulebook the entry maps to; `null` only if creation failed. */
  readonly rulebookId: string | null
  /** Deterministic identity stored as `rulebooks.import_key`. */
  readonly entryKey: string
  readonly name: string | null
  readonly sourceId: string | null
  readonly sourceVersion: string | null
  /** Fingerprint of the incoming normalized content. */
  readonly contentFingerprint: string
  readonly conflict: ImportConflict | null
}

export interface ImportResult {
  readonly preview: ImportPreview
  /** Per-entry outcomes, in preview order. */
  readonly entries: readonly ImportEntryResult[]
  /** Rulebooks created by this call (unchanged and conflicted entries write nothing). */
  readonly rulebooks: readonly Rulebook[]
  /** Reported conflicts; each leaves the existing rulebook untouched. */
  readonly conflicts: readonly ImportConflict[]
  /** Source-level re-import findings, such as a serialization-only change. */
  readonly diagnostics: readonly ImportDiagnostic[]
}

export interface RulebookImporterOptions extends ImportOptions {
  readonly registry: Registry
}

function provenanceString(provenance: JsonObject, key: string): string | null {
  const value = provenance[key]
  return typeof value === 'string' ? value : null
}

function buildProvenance(
  entry: ImportEntryPreview,
  preview: ImportPreview,
  importedAt: string,
  contentFingerprint: string,
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
    contentFingerprint,
    importedAt,
  }
}

function toCreateRulebookInput(
  entry: ImportEntryPreview,
  preview: ImportPreview,
  importedAt: string,
  entryKey: string,
  contentFingerprint: string,
): CreateRulebookInput {
  const canonical = entry.canonical
  if (canonical === null || entry.profile === null) {
    throw importError('import_rejected', 'the import entry has no validated document')
  }

  if (entry.name === null) {
    throw importError('import_rejected', 'the import entry has no derived rulebook name')
  }
  const name = entry.name

  return {
    name,
    description: entry.description,
    ...(preview.source.url !== null ? { sourceUrl: preview.source.url } : {}),
    importKey: entryKey,
    provenance: buildProvenance(entry, preview, importedAt, contentFingerprint),
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
   * Retrieves, validates and commits one source. Authentication happens before
   * any network request. An incompatible entry aborts the whole import before
   * any write. New entries are created in one transaction; existing entries are
   * either an idempotent no-op or a reported conflict, never an overwrite.
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
    const keyed = preview.entries.map((entry) => ({
      entry,
      entryKey: importEntryKey(preview.source, entry),
    }))
    const seen = new Map<string, ImportEntryPreview>()
    for (const item of keyed) {
      const first = seen.get(item.entryKey)
      if (first !== undefined) {
        throw importError(
          'import_rejected',
          `entries ${first.index} and ${item.entry.index} share the import identity "${importEntryIdentity(item.entry)}"; no rulebook was written`,
        )
      }
      seen.set(item.entryKey, item.entry)
    }

    const outcomes = keyed.map(({ entry, entryKey }) =>
      this.classifyEntry(accessToken, entry, preview, importedAt, entryKey),
    )

    const createdRulebooks = this.createNewRulebooks(
      accessToken,
      outcomes
        .filter((outcome) => outcome.disposition === 'created')
        .map((outcome) => outcome.input),
    )
    const createdByIdentity = new Map(
      outcomes
        .filter((outcome) => outcome.disposition === 'created')
        .map((outcome, index) => [outcome.entryKey, createdRulebooks[index] ?? null]),
    )

    const entries: ImportEntryResult[] = outcomes.map((outcome) => {
      const created =
        outcome.disposition === 'created' ? (createdByIdentity.get(outcome.entryKey) ?? null) : null
      const existing = outcome.existing
      const rulebook = created ?? existing
      return {
        index: outcome.entry.index,
        disposition: outcome.disposition,
        rulebookId: rulebook?.id ?? null,
        entryKey: outcome.entryKey,
        name: outcome.entry.name,
        sourceId: outcome.entry.id,
        sourceVersion: outcome.entry.version,
        contentFingerprint: outcome.contentFingerprint,
        conflict: outcome.conflict,
      }
    })

    const conflicts = entries
      .map((entry) => entry.conflict)
      .filter((conflict): conflict is ImportConflict => conflict !== null)
    const diagnostics = this.reimportDiagnostics(entries, outcomes, preview)

    return { preview, entries, rulebooks: createdRulebooks, conflicts, diagnostics }
  }

  private createNewRulebooks(
    accessToken: string,
    inputs: readonly CreateRulebookInput[],
  ): readonly Rulebook[] {
    if (inputs.length === 0) {
      return []
    }
    try {
      // One transaction for all new entries: a registry refusal cannot leave
      // earlier entries behind as partial drafts.
      return this.registry.createRulebooks(accessToken, inputs)
    } catch (error) {
      if (isRegistryError(error) && (error.code === 'invalid_input' || error.code === 'conflict')) {
        throw importError(
          'import_rejected',
          'the registry refused the imported rulebook content; no rulebook was written',
        )
      }
      throw error
    }
  }

  /**
   * Classifies one preview entry against an existing rulebook with the same
   * import key. Only an entry with no existing rulebook is written.
   */
  private classifyEntry(
    accessToken: string,
    entry: ImportEntryPreview,
    preview: ImportPreview,
    importedAt: string,
    entryKey: string,
  ): ClassifiedEntry {
    // The fingerprint covers only the content a write would store, so it is
    // computed from the registry-normalized input (with a placeholder
    // provenance) and then written into the final provenance.
    const provisional = toCreateRulebookInput(entry, preview, importedAt, entryKey, '')
    const contentFingerprint = this.normalizedContentFingerprint(accessToken, provisional)
    const input: CreateRulebookInput = {
      ...provisional,
      provenance: buildProvenance(entry, preview, importedAt, contentFingerprint),
    }

    const existing = this.registry.findImportedRulebook(accessToken, entryKey)
    if (existing === null) {
      return {
        entry,
        entryKey,
        contentFingerprint,
        disposition: 'created',
        input,
        existing: null,
        conflict: null,
      }
    }

    return this.classifyExisting(existing, entry, entryKey, contentFingerprint, input)
  }

  /**
   * Fingerprints the content exactly as `createRulebooks` would store it, so a
   * later re-import of the same source compares like with like. Validation
   * failures use the same import rejection as a refused write.
   */
  private normalizedContentFingerprint(accessToken: string, input: CreateRulebookInput): string {
    try {
      const prepared = this.registry.normalizeRulebookInput(accessToken, input)
      return importContentFingerprint(
        storedImportContent(prepared.rulebook, prepared.attestations, prepared.schemaReferences),
      )
    } catch (error) {
      if (isRegistryError(error) && (error.code === 'invalid_input' || error.code === 'conflict')) {
        throw importError(
          'import_rejected',
          'the registry would refuse the imported rulebook content; no rulebook was written',
        )
      }
      throw error
    }
  }

  private classifyExisting(
    existing: Rulebook,
    entry: ImportEntryPreview,
    entryKey: string,
    incomingFingerprint: string,
    input: CreateRulebookInput,
  ): ClassifiedEntry {
    const currentFingerprint = importContentFingerprint(
      storedImportContent(
        existing,
        this.registry.listAttestations(existing.id),
        this.registry.listSchemaReferences(existing.id),
      ),
    )
    const publishedVersions = this.registry
      .listRulebookVersions(existing.id)
      .filter((version) => version.status !== 'draft')
      .map((version) => version.version)
    const lastFingerprint = provenanceString(existing.provenance, 'contentFingerprint')
    const lastSourceVersion = provenanceString(existing.provenance, 'sourceVersion')
    const locallyModified = lastFingerprint === null || currentFingerprint !== lastFingerprint

    if (incomingFingerprint === currentFingerprint) {
      if (lastSourceVersion !== entry.version) {
        return {
          entry,
          entryKey,
          contentFingerprint: incomingFingerprint,
          disposition: 'conflict',
          input,
          existing,
          conflict: {
            code: 'source_version_changed',
            message: `the source version changed from ${lastSourceVersion ?? 'unknown'} to ${entry.version ?? 'unknown'} while the normalized content stayed identical; nothing was written`,
            rulebookId: existing.id,
            publishedVersions,
            locallyModified: false,
            existingContentFingerprint: currentFingerprint,
            incomingContentFingerprint: incomingFingerprint,
            existingSourceVersion: lastSourceVersion,
            incomingSourceVersion: entry.version,
          },
        }
      }
      return {
        entry,
        entryKey,
        contentFingerprint: incomingFingerprint,
        disposition: 'unchanged',
        input,
        existing,
        conflict: null,
      }
    }

    const code: ImportConflictCode =
      publishedVersions.length > 0
        ? 'published_content'
        : locallyModified
          ? 'locally_modified'
          : 'source_changed'
    const message =
      code === 'published_content'
        ? 'the rulebook has published or historical versions; imported content is never written over them'
        : code === 'locally_modified'
          ? 'the draft differs from the content last imported; local edits are preserved and nothing was written'
          : 'the source content differs from the imported draft; re-import reports the change and writes nothing'

    return {
      entry,
      entryKey,
      contentFingerprint: incomingFingerprint,
      disposition: 'conflict',
      input,
      existing,
      conflict: {
        code,
        message,
        rulebookId: existing.id,
        publishedVersions,
        locallyModified,
        existingContentFingerprint: currentFingerprint,
        incomingContentFingerprint: incomingFingerprint,
        existingSourceVersion: lastSourceVersion,
        incomingSourceVersion: entry.version,
      },
    }
  }

  /**
   * Reports a source whose exact bytes changed while every entry's normalized
   * content stayed identical (for example re-serialized JSON). The import is
   * still a no-op; the difference is reported rather than silently ignored
   * (R5.2, R-17).
   */
  private reimportDiagnostics(
    entries: readonly ImportEntryResult[],
    outcomes: readonly ClassifiedEntry[],
    preview: ImportPreview,
  ): readonly ImportDiagnostic[] {
    if (entries.length === 0 || !entries.every((entry) => entry.disposition === 'unchanged')) {
      return []
    }
    const previousDigests = new Set(
      outcomes
        .map((outcome) => outcome.existing)
        .filter((existing): existing is Rulebook => existing !== null)
        .map((existing) => provenanceString(existing.provenance, 'contentDigest'))
        .filter((digest): digest is string => digest !== null),
    )
    if (previousDigests.size !== 1 || previousDigests.has(preview.source.contentDigest)) {
      return []
    }
    return [
      {
        kind: 'change',
        code: 'serialization_only_change',
        message:
          'the source bytes changed but every entry has the same normalized content; nothing was written',
      },
    ]
  }
}

interface ClassifiedEntry {
  readonly entry: ImportEntryPreview
  readonly entryKey: string
  readonly contentFingerprint: string
  readonly disposition: ImportEntryDisposition
  readonly input: CreateRulebookInput
  readonly existing: Rulebook | null
  readonly conflict: ImportConflict | null
}
