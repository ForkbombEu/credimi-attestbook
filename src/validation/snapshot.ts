// Parsing of one stored rulebook-version snapshot (issue #32, #53).
//
// A snapshot is the deterministic JSON document frozen at version creation
// (`src/registry/versioning.ts`). Validation reads the exact stored bytes,
// verifies their SHA-256 digest against the version row and only then parses
// the attestation types this module exposes. Parsing is split out of the engine
// so the immutable-snapshot cache can store the parsed value instead of the
// JSON document without duplicating the validation rules.

import type { RulebookVersion } from '../registry/types'
import {
  RULEBOOK_VERSION_FORMAT,
  type RulebookVersionDocument,
  type RulebookVersionSchemaReference,
} from '../registry/versioning'

/** One attestation type as carried by a stored version snapshot. */
export interface SnapshotAttestation {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
  readonly schemaReferences: readonly RulebookVersionSchemaReference[]
}

/**
 * The parsed fields validation needs from one snapshot. The identity fields
 * are kept so a cache hit can prove the parsed value still belongs to the
 * version row it is used for.
 */
export interface ParsedRulebookSnapshot {
  readonly rulebookId: string
  readonly version: string
  readonly specVersion: string
  readonly attestations: readonly SnapshotAttestation[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function parseSnapshotReference(value: unknown): RulebookVersionSchemaReference {
  if (
    !isRecord(value) ||
    typeof value.formatIdentifier !== 'string' ||
    typeof value.uri !== 'string' ||
    !(value.integrity === null || typeof value.integrity === 'string')
  ) {
    throw new Error('the stored rulebook version snapshot has a malformed schema reference')
  }
  return {
    formatIdentifier: value.formatIdentifier,
    uri: value.uri,
    integrity: value.integrity,
  }
}

function parseSnapshotAttestation(value: unknown): SnapshotAttestation {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.attestationLoS !== 'string' ||
    typeof value.bindingType !== 'string' ||
    !isStringArray(value.supportedFormats) ||
    !Array.isArray(value.schemaReferences)
  ) {
    throw new Error('the stored rulebook version snapshot has a malformed attestation type')
  }
  return {
    name: value.name,
    attestationLoS: value.attestationLoS,
    bindingType: value.bindingType,
    supportedFormats: value.supportedFormats,
    schemaReferences: value.schemaReferences.map(parseSnapshotReference),
  }
}

/**
 * Parses and checks the stored snapshot bytes against the version metadata.
 * A mismatch means the registry is inconsistent, not that the caller's
 * credential is invalid, so these failures are internal errors.
 */
export function parseRulebookSnapshot(
  bytes: Uint8Array,
  version: RulebookVersion,
): ParsedRulebookSnapshot {
  let document: unknown
  try {
    document = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new Error('the stored rulebook version snapshot is not valid JSON')
  }
  const candidate = document as Partial<RulebookVersionDocument>
  if (
    !isRecord(document) ||
    candidate.format !== RULEBOOK_VERSION_FORMAT ||
    candidate.rulebookId !== version.rulebookId ||
    candidate.version !== version.version ||
    candidate.specVersion !== version.specVersion ||
    !Array.isArray(candidate.attestations)
  ) {
    throw new Error('the stored rulebook version snapshot does not match its version metadata')
  }
  return {
    rulebookId: version.rulebookId,
    version: version.version,
    specVersion: version.specVersion,
    attestations: candidate.attestations.map(parseSnapshotAttestation),
  }
}
