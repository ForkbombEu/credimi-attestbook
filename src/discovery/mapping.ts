// Association of discovered issuer configurations with pinned rulebook versions (FR-006).
//
// Association is deliberately heuristic and conservative. A configuration can
// only be associated with a published or historical rulebook version: those are
// the immutable, content-addressed snapshots, while a draft is a mutable
// working copy and is never a valid mapping target. The comparison uses the
// format and the type identifier frozen in the snapshot's schema-reference
// URIs, so the resulting pin (`rulebookId`, `version`, `contentDigest`,
// `specVersion`) identifies exact bytes rather than a moving label.
//
// A rulebook can have several matching versions (for example a current
// published version and an older historical one). Those are collapsed to the
// current version of that rulebook so a single history does not look
// ambiguous; configurations that match more than one rulebook are reported as
// ambiguous instead of picking a winner.

import { parseRulebookVersionDocument } from '../registry/versioning'
import type { Rulebook, RulebookVersion, RulebookVersionContent } from '../registry/types'

import type {
  ConfigurationMapping,
  DiscoveredCredentialConfiguration,
  IssuerDiscoveryDiagnostic,
  RulebookMappingIndex,
  RulebookVersionCandidate,
  RulebookVersionPin,
} from './types'

/** The registry reads discovery needs; `Registry` satisfies this structurally. */
export interface RulebookVersionSource {
  listRulebooks(): readonly Rulebook[]
  listRulebookVersions(rulebookId: string): readonly RulebookVersion[]
  getRulebookVersionContent(rulebookId: string, version: string): RulebookVersionContent | null
}

const NO_MATCH_REASON =
  'no published or historical rulebook version records a matching format and type identifier'
const NO_IDENTIFIER_REASON = 'the configuration declares no type identifier'

function diagnostic(code: string, message: string, path?: string): IssuerDiscoveryDiagnostic {
  return path === undefined ? { code, message } : { code, message, path }
}

function candidateFormats(document: ReturnType<typeof parseRulebookVersionDocument>): string[] {
  const formats = new Set<string>()
  for (const attestation of document.attestations) {
    for (const format of attestation.supportedFormats) {
      formats.add(format)
    }
    for (const reference of attestation.schemaReferences) {
      formats.add(reference.formatIdentifier)
    }
  }
  for (const reference of document.schemaReferences) {
    formats.add(reference.formatIdentifier)
  }
  return [...formats]
}

function candidateTypeIdentifiers(
  document: ReturnType<typeof parseRulebookVersionDocument>,
): readonly { readonly formatIdentifier: string; readonly value: string }[] {
  const identifiers: { formatIdentifier: string; value: string }[] = []
  const seen = new Set<string>()
  const add = (formatIdentifier: string, value: string): void => {
    const key = `${formatIdentifier}\u0000${value}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    identifiers.push({ formatIdentifier, value })
  }
  for (const attestation of document.attestations) {
    for (const reference of attestation.schemaReferences) {
      add(reference.formatIdentifier, reference.uri)
    }
  }
  for (const reference of document.schemaReferences) {
    add(reference.formatIdentifier, reference.uri)
  }
  return identifiers
}

/**
 * Builds the bounded mapping index from the registry's immutable versions.
 * A corrupt stored snapshot is reported and skipped rather than failing the
 * whole discovery run; the version it belongs to simply cannot be a candidate.
 */
export function buildRulebookMappingIndex(source: RulebookVersionSource): RulebookMappingIndex {
  const diagnostics: IssuerDiscoveryDiagnostic[] = []
  const candidates: RulebookVersionCandidate[] = []

  const rulebooks = [...source.listRulebooks()].sort((left, right) =>
    left.name === right.name
      ? left.id.localeCompare(right.id)
      : left.name.localeCompare(right.name),
  )

  for (const rulebook of rulebooks) {
    for (const version of source.listRulebookVersions(rulebook.id)) {
      if (version.status === 'draft') {
        continue
      }
      if (version.publishedAt === null) {
        diagnostics.push(
          diagnostic(
            'invalid_rulebook_version',
            'a published or historical rulebook version has no publication time and was skipped',
            `${rulebook.id}@${version.version}`,
          ),
        )
        continue
      }
      const content = source.getRulebookVersionContent(rulebook.id, version.version)
      if (content === null) {
        diagnostics.push(
          diagnostic(
            'invalid_rulebook_version',
            'a rulebook version has no stored snapshot and was skipped',
            `${rulebook.id}@${version.version}`,
          ),
        )
        continue
      }

      let document: ReturnType<typeof parseRulebookVersionDocument>
      try {
        document = parseRulebookVersionDocument(content.bytes)
      } catch {
        diagnostics.push(
          diagnostic(
            'invalid_rulebook_version',
            'a stored rulebook version snapshot could not be parsed and was skipped',
            `${rulebook.id}@${version.version}`,
          ),
        )
        continue
      }

      candidates.push({
        rulebookId: rulebook.id,
        rulebookName: rulebook.name,
        version: version.version,
        contentDigest: version.contentDigest,
        specVersion: version.specVersion,
        status: version.status,
        publishedAt: version.publishedAt,
        formats: candidateFormats(document),
        typeIdentifiers: candidateTypeIdentifiers(document),
      })
    }
  }

  candidates.sort((left, right) => {
    const name = left.rulebookName.localeCompare(right.rulebookName)
    if (name !== 0) {
      return name
    }
    const id = left.rulebookId.localeCompare(right.rulebookId)
    return id !== 0 ? id : left.version.localeCompare(right.version)
  })

  return { candidates, diagnostics }
}

function preferredForRulebook(
  candidates: readonly RulebookVersionCandidate[],
): RulebookVersionCandidate | null {
  let preferred: RulebookVersionCandidate | null = null
  for (const candidate of candidates) {
    if (preferred === null) {
      preferred = candidate
      continue
    }
    if (preferred.status !== candidate.status) {
      preferred = candidate.status === 'published' ? candidate : preferred
      continue
    }
    if (candidate.publishedAt > preferred.publishedAt) {
      preferred = candidate
      continue
    }
    if (candidate.publishedAt === preferred.publishedAt && candidate.version > preferred.version) {
      preferred = candidate
    }
  }
  return preferred
}

function toPin(candidate: RulebookVersionCandidate): RulebookVersionPin {
  return {
    rulebookId: candidate.rulebookId,
    rulebookName: candidate.rulebookName,
    version: candidate.version,
    contentDigest: candidate.contentDigest,
    specVersion: candidate.specVersion,
  }
}

/** Associates one configuration with at most one pinned version per rulebook. */
export function mapConfiguration(
  configuration: DiscoveredCredentialConfiguration,
  index: RulebookMappingIndex,
): ConfigurationMapping {
  // A `vct` is kept verbatim as a case-sensitive type identifier, while an
  // https `vct` is also recorded as a normalized schema reference. Compare the
  // rulebook's frozen URIs with both so a casing-insensitive URL normalization
  // cannot hide a real match.
  const typeValues = new Set([
    ...configuration.typeIdentifiers.map((identifier) => identifier.value),
    ...configuration.schemaReferences
      .filter((reference) => reference.source === 'vct')
      .map((reference) => reference.uri),
  ])
  if (typeValues.size === 0) {
    return { status: 'unmatched', candidates: [], reason: NO_IDENTIFIER_REASON }
  }

  const matching = index.candidates.filter(
    (candidate) =>
      candidate.formats.includes(configuration.format) &&
      candidate.typeIdentifiers.some(
        (identifier) =>
          identifier.formatIdentifier === configuration.format && typeValues.has(identifier.value),
      ),
  )
  if (matching.length === 0) {
    return { status: 'unmatched', candidates: [], reason: NO_MATCH_REASON }
  }

  const byRulebook = new Map<string, RulebookVersionCandidate[]>()
  for (const candidate of matching) {
    const existing = byRulebook.get(candidate.rulebookId)
    if (existing === undefined) {
      byRulebook.set(candidate.rulebookId, [candidate])
    } else {
      existing.push(candidate)
    }
  }

  const pins: RulebookVersionPin[] = []
  for (const candidates of byRulebook.values()) {
    const preferred = preferredForRulebook(candidates)
    if (preferred !== null) {
      pins.push(toPin(preferred))
    }
  }
  pins.sort((left, right) => {
    const name = left.rulebookName.localeCompare(right.rulebookName)
    return name !== 0 ? name : left.rulebookId.localeCompare(right.rulebookId)
  })

  if (pins.length === 1) {
    const pin = pins[0]
    if (pin !== undefined) {
      return { status: 'matched', candidates: [pin], reason: null }
    }
  }
  return { status: 'ambiguous', candidates: pins, reason: null }
}
