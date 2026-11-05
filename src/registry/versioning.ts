// Deterministic serialization of a rulebook version snapshot (issue #29).
//
// A version's content digest is SHA-256 over the exact bytes produced here
// (decision D-6). The snapshot is generated from the registry's product model,
// not from a TS11/OWF wire type: it deliberately excludes mutable internal
// metadata, provenance and product state, so the same semantic rulebook content
// produces the same bytes and the digest stays reproducible. Provenance,
// publication state and timestamps live on the version row, never inside the
// snapshot.
//
// The document is only an internal, content-addressed artifact. It is not a
// standards document and makes no TS11/OWF conformance claim; import (#30) and
// the API/UI slices (#34, #37) decide what bytes are published and exported.

import type { AttestationType, Rulebook, SchemaReference } from './types'

/** Format marker carried inside the snapshot so a stored artifact is self-describing. */
export const RULEBOOK_VERSION_FORMAT = 'attestbook.rulebook-version@1'

/** Media type recorded with the snapshot artifact. */
export const RULEBOOK_VERSION_MEDIA_TYPE = 'application/vnd.attestbook.rulebook-version+json'

/** A schema reference as carried by a version snapshot; no internal metadata. */
export interface RulebookVersionSchemaReference {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity: string | null
}

/** An attestation type as carried by a version snapshot; no internal metadata. */
export interface RulebookVersionAttestation {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
  readonly schemaReferences: readonly RulebookVersionSchemaReference[]
}

/** The exact JSON document stored as a rulebook version's artifact. */
export interface RulebookVersionDocument {
  readonly format: typeof RULEBOOK_VERSION_FORMAT
  readonly rulebookId: string
  readonly version: string
  readonly specVersion: string
  readonly name: string
  readonly description: string
  readonly sourceUrl: string | null
  readonly attestations: readonly RulebookVersionAttestation[]
  /** Rulebook-level schema references, outside any attestation type. */
  readonly schemaReferences: readonly RulebookVersionSchemaReference[]
}

export interface BuildRulebookVersionDocumentInput {
  readonly rulebook: Rulebook
  /** Version label the snapshot is frozen under. */
  readonly version: string
  /** Profile the snapshot is authored against, e.g. `ts11@1.0.1`. */
  readonly specVersion: string
  readonly attestations: readonly AttestationType[]
  readonly schemaReferences: readonly SchemaReference[]
}

function toSnapshotReference(reference: SchemaReference): RulebookVersionSchemaReference {
  // Property order is fixed so serialization is deterministic.
  return {
    formatIdentifier: reference.formatIdentifier,
    uri: reference.uri,
    integrity: reference.integrity,
  }
}

/**
 * Builds the snapshot document for a rulebook at one version. Field order and
 * array order are deterministic for a given stored state: attestations are
 * listed in registry order and references follow their attestation.
 */
export function buildRulebookVersionDocument(
  input: BuildRulebookVersionDocumentInput,
): RulebookVersionDocument {
  const { rulebook, version, specVersion, attestations, schemaReferences } = input
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
    format: RULEBOOK_VERSION_FORMAT,
    rulebookId: rulebook.id,
    version,
    specVersion,
    name: rulebook.name,
    description: rulebook.description,
    sourceUrl: rulebook.sourceUrl,
    // Fixed key order: the snapshot bytes must be stable for the same content.
    attestations: attestations.map((attestation) => ({
      name: attestation.name,
      attestationLoS: attestation.attestationLoS,
      bindingType: attestation.bindingType,
      supportedFormats: [...attestation.supportedFormats],
      schemaReferences: (referencesByAttestation.get(attestation.id) ?? []).map(
        toSnapshotReference,
      ),
    })),
    schemaReferences: rulebookLevel.map(toSnapshotReference),
  }
}

/** Serializes a snapshot document to the exact UTF-8 bytes that are digested. */
export function serializeRulebookVersion(document: RulebookVersionDocument): Uint8Array {
  return Buffer.from(JSON.stringify(document), 'utf8')
}
