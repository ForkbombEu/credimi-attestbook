// Stable, verifiable export of a published rulebook artifact (issue #42).
//
// A publication export is the exact stored version snapshot plus a manifest
// that states its identity, digest and provenance. It is deliberately built
// only from frozen data: the version row, the stored artifact bytes and the
// snapshot document the bytes contain. The rulebook's mutable working copy is
// never read, so editing the draft after publication cannot change what an
// already-published artifact exports as.
//
// Integrity is the SHA-256 digest of the exact bytes (decision D-6), recomputed
// here before the manifest is produced. There is no publication signature: the
// mandatory OWF package signs only a bare OWF-profile `SchemaMeta` compact JWS,
// while an AttestBook snapshot is not a `SchemaMeta` document and the TS11
// v1.0.1 catalogue-response JWS is not implemented by OWF 0.5.4
// (docs/standards.md §5.8 and §6.2). The manifest reports that boundary
// explicitly instead of inventing proprietary signing semantics (FR-008).

import { sha256Hex } from '../registry/digest'
import type { JsonObject, PublicationStatus, RulebookVersion } from '../registry/types'
import type { RulebookVersionDocument } from '../registry/versioning'

/** Snapshot format marker of the publication export manifest. */
export const PUBLICATION_EXPORT_FORMAT = 'attestbook.publication-export@1'

/** A published or historical version; a draft is not a publication artifact. */
export type ExportablePublicationStatus = Exclude<PublicationStatus, 'draft'>

/**
 * Why this build produces no publication signature. Kept next to the manifest
 * so the exported document and the documentation cannot drift silently.
 */
export const PUBLICATION_SIGNATURE_REASON =
  'OWF 0.5.4 signs only a bare OWF-profile SchemaMeta compact JWS. An AttestBook version snapshot is not a SchemaMeta document and the TS11 v1.0.1 catalogue-response JWS is not implemented by the pinned package, so no publication signature is produced or claimed.'

/** Boundaries a consumer must keep in mind; never a conformance claim. */
export const PUBLICATION_EXPORT_LIMITATIONS: readonly string[] = [
  'Integrity is the SHA-256 digest of the exact exported bytes; consumers must recompute it before trusting the artifact.',
  'The artifact is an AttestBook version snapshot, not a TS11 or OWF standards wire document.',
  'Remote schema documents, issuer trust, protocol conformance and interoperability are not verified by this export.',
]

export type PublicationSignatureStatus = 'unsupported'

export interface PublicationExportSignature {
  readonly status: PublicationSignatureStatus
  readonly reason: string
}

export interface PublicationExportIntegrity {
  readonly algorithm: 'sha256'
  readonly verified: boolean
}

/**
 * Manifest of one published artifact. Every field comes from frozen data; the
 * manifest for a given published version is therefore stable across exports and
 * independent of later working-copy edits.
 */
export interface PublicationExportManifest {
  readonly format: typeof PUBLICATION_EXPORT_FORMAT
  readonly rulebookId: string
  readonly providerId: string
  readonly version: string
  readonly status: ExportablePublicationStatus
  /** Rulebook name frozen in the snapshot. */
  readonly name: string
  /** Source URL frozen in the snapshot; never the mutable rulebook row. */
  readonly sourceUrl: string | null
  readonly specVersion: string
  readonly mediaType: string
  readonly contentDigest: string
  readonly byteLength: number
  /** Set exactly when the version was published; immutable afterwards. */
  readonly createdAt: string
  readonly publishedAt: string
  /** Version provenance frozen when the snapshot was created. */
  readonly provenance: JsonObject
  readonly integrity: PublicationExportIntegrity
  readonly signature: PublicationExportSignature
  readonly limitations: readonly string[]
}

export interface BuildPublicationExportInput {
  readonly version: RulebookVersion
  /** Stable owning provider of the rulebook; publication authority is enforced upstream. */
  readonly providerId: string
  readonly mediaType: string
  /** Exact stored snapshot bytes; never re-serialized here. */
  readonly bytes: Uint8Array
  /** Parsed snapshot document, used only for its frozen identity fields. */
  readonly document: RulebookVersionDocument
}

/**
 * Builds the publication export manifest. Throws when the version is not a
 * publication artifact or when the stored bytes no longer match the recorded
 * digest: a corrupt artifact must never be exported as if it were verified.
 */
export function buildPublicationExportManifest(
  input: BuildPublicationExportInput,
): PublicationExportManifest {
  const { version, document } = input
  if (version.status === 'draft') {
    throw new Error('a draft version is not a publication artifact')
  }
  if (version.publishedAt === null) {
    throw new Error('a published or historical version must carry its publication time')
  }
  if (document.rulebookId !== version.rulebookId || document.version !== version.version) {
    throw new Error('the snapshot document does not match the version row')
  }

  const actualDigest = sha256Hex(input.bytes)
  if (actualDigest !== version.contentDigest) {
    throw new Error(
      `the stored publication artifact has digest ${actualDigest}, not the recorded ${version.contentDigest}`,
    )
  }

  return {
    format: PUBLICATION_EXPORT_FORMAT,
    rulebookId: version.rulebookId,
    providerId: input.providerId,
    version: version.version,
    status: version.status,
    name: document.name,
    sourceUrl: document.sourceUrl,
    specVersion: version.specVersion,
    mediaType: input.mediaType,
    contentDigest: version.contentDigest,
    byteLength: input.bytes.byteLength,
    createdAt: version.createdAt,
    publishedAt: version.publishedAt,
    provenance: version.provenance,
    integrity: { algorithm: 'sha256', verified: true },
    signature: {
      status: 'unsupported',
      reason: PUBLICATION_SIGNATURE_REASON,
    },
    limitations: [...PUBLICATION_EXPORT_LIMITATIONS],
  }
}

const MAX_FILENAME_SLUG_LENGTH = 60

/**
 * Download filename for an exported artifact. The rulebook name is untrusted
 * text, so it is reduced to a bounded ASCII slug before it reaches a
 * `Content-Disposition` header; a name that reduces to nothing falls back to
 * `rulebook`.
 */
export function publicationExportFilename(name: string, version: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_FILENAME_SLUG_LENGTH)
      .replace(/-+$/g, '') || 'rulebook'
  const safeVersion = version.replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '') || 'version'
  return `attestbook-${slug}-${safeVersion}.json`
}
