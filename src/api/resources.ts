// Public projections of registry, import and validation results (issue #34).
//
// The service modules expose internal fields that must never leave the HTTP
// boundary: rulebook provenance, rulebook/attestation/schema-reference metadata
// and the import identity (`importKey`) are registry-internal product data (see
// docs/registry.md §4). Every response is built through these projections and
// parsed with the shared Zod schema, so an accidental extra field is stripped
// and a missing or mistyped field becomes a server error instead of a silent
// contract drift.

import type {
  ImportPreview,
  ImportResult,
  ImportEntryPreview,
  ImportDiagnostic,
  ImportedSchemaReference,
} from '../import'
import type { PublicationReadiness, VersionContentDiff } from '../lifecycle'
import type { PublicationExportManifest } from '../publication'
import type {
  AttestationType,
  DraftContent,
  Provider,
  Rulebook,
  RulebookVersion,
  SchemaReference,
} from '../registry/types'
import type { CredentialValidationResult } from '../validation'

import {
  attestationDetailSchema,
  credentialValidationResultSchema,
  draftRulebookSchema,
  importPreviewSchema,
  importResultSchema,
  providerSchema,
  publicationExportManifestSchema,
  publicationReadinessSchema,
  rulebookSchema,
  rulebookVersionDocumentSchema,
  rulebookVersionSchema,
  schemaReferenceSchema,
  versionDiffSchema,
} from './schemas'

/** Public catalogue projection of a provider; authority and metadata stay internal. */
export function toProviderResource(provider: Provider) {
  return providerSchema.parse({
    id: provider.id,
    name: provider.name,
    createdAt: provider.createdAt,
  })
}

export function toRulebookResource(rulebook: Rulebook) {
  return rulebookSchema.parse({
    id: rulebook.id,
    providerId: rulebook.providerId,
    name: rulebook.name,
    description: rulebook.description,
    sourceUrl: rulebook.sourceUrl,
    applicableSpec: rulebook.applicableSpec,
    publicationStatus: rulebook.publicationStatus,
    createdAt: rulebook.createdAt,
    updatedAt: rulebook.updatedAt,
  })
}

export function toSchemaReferenceResource(reference: SchemaReference) {
  return schemaReferenceSchema.parse({
    id: reference.id,
    rulebookId: reference.rulebookId,
    attestationId: reference.attestationId,
    formatIdentifier: reference.formatIdentifier,
    uri: reference.uri,
    integrity: reference.integrity,
    createdAt: reference.createdAt,
  })
}

export function toAttestationResource(
  attestation: AttestationType,
  schemaReferences: readonly SchemaReference[],
) {
  return attestationDetailSchema.parse({
    id: attestation.id,
    rulebookId: attestation.rulebookId,
    name: attestation.name,
    attestationLoS: attestation.attestationLoS,
    bindingType: attestation.bindingType,
    supportedFormats: [...attestation.supportedFormats],
    createdAt: attestation.createdAt,
    schemaReferences: schemaReferences.map(toSchemaReferenceResource),
  })
}

/** Public editable projection of one draft working copy (#40). */
export function toDraftRulebookResource(content: DraftContent) {
  const { rulebook, attestations, schemaReferences } = content
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
  return draftRulebookSchema.parse({
    id: rulebook.id,
    providerId: rulebook.providerId,
    name: rulebook.name,
    description: rulebook.description,
    sourceUrl: rulebook.sourceUrl,
    applicableSpec: rulebook.applicableSpec,
    publicationStatus: rulebook.publicationStatus,
    attestations: attestations.map((attestation) => ({
      name: attestation.name,
      attestationLoS: attestation.attestationLoS,
      bindingType: attestation.bindingType,
      supportedFormats: [...attestation.supportedFormats],
      schemaReferences: (referencesByAttestation.get(attestation.id) ?? []).map(
        toDraftSchemaReferenceResource,
      ),
    })),
    schemaReferences: rulebookLevel.map(toDraftSchemaReferenceResource),
    createdAt: rulebook.createdAt,
    updatedAt: rulebook.updatedAt,
  })
}

function toDraftSchemaReferenceResource(reference: SchemaReference) {
  return {
    formatIdentifier: reference.formatIdentifier,
    uri: reference.uri,
    integrity: reference.integrity,
  }
}

export function toRulebookVersionResource(version: RulebookVersion) {
  return rulebookVersionSchema.parse({
    id: version.id,
    rulebookId: version.rulebookId,
    version: version.version,
    status: version.status,
    contentDigest: version.contentDigest,
    specVersion: version.specVersion,
    createdAt: version.createdAt,
    publishedAt: version.publishedAt,
  })
}

/** Public projection of a deterministic comparison of two versions (#41). */
export function toVersionDiffResource(
  from: RulebookVersion,
  to: RulebookVersion,
  diff: VersionContentDiff,
) {
  return versionDiffSchema.parse({
    from: toRulebookVersionResource(from),
    to: toRulebookVersionResource(to),
    identical: diff.identical,
    changes: diff.changes.map((change) => ({
      path: change.path,
      kind: change.kind,
      ...(change.before === undefined ? {} : { before: change.before }),
      ...(change.after === undefined ? {} : { after: change.after }),
    })),
    summary: { ...diff.summary },
  })
}

/** Public projection of a publication-readiness assessment (#41). */
export function toPublicationReadinessResource(
  version: RulebookVersion,
  readiness: PublicationReadiness,
) {
  return publicationReadinessSchema.parse({
    version: toRulebookVersionResource(version),
    ready: readiness.ready,
    checks: readiness.checks.map((check) => ({
      id: check.id,
      status: check.status,
      message: check.message,
    })),
    limitations: [...readiness.limitations],
  })
}

/** Public projection of a publication export manifest (#42). */
export function toPublicationExportManifestResource(manifest: PublicationExportManifest) {
  return publicationExportManifestSchema.parse({
    format: manifest.format,
    rulebookId: manifest.rulebookId,
    providerId: manifest.providerId,
    version: manifest.version,
    status: manifest.status,
    name: manifest.name,
    sourceUrl: manifest.sourceUrl,
    specVersion: manifest.specVersion,
    mediaType: manifest.mediaType,
    contentDigest: manifest.contentDigest,
    byteLength: manifest.byteLength,
    createdAt: manifest.createdAt,
    publishedAt: manifest.publishedAt,
    provenance: { ...manifest.provenance },
    integrity: {
      algorithm: manifest.integrity.algorithm,
      verified: manifest.integrity.verified,
    },
    signature: {
      status: manifest.signature.status,
      reason: manifest.signature.reason,
    },
    limitations: [...manifest.limitations],
  })
}

/**
 * Validates that stored snapshot bytes still match the documented version
 * document shape. The bytes themselves are returned unchanged: re-serializing
 * them would invalidate the content digest.
 */
export function assertVersionDocument(bytes: Uint8Array): void {
  const text = new TextDecoder().decode(bytes)
  rulebookVersionDocumentSchema.parse(JSON.parse(text))
}

function toImportDiagnosticResource(diagnostic: ImportDiagnostic) {
  return {
    kind: diagnostic.kind,
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
  }
}

function toImportedSchemaReferenceResource(reference: ImportedSchemaReference) {
  return {
    formatIdentifier: reference.formatIdentifier,
    uri: reference.uri,
    ...(reference.integrity === undefined ? {} : { integrity: reference.integrity }),
    ...(reference.metadata === undefined ? {} : { metadata: reference.metadata }),
  }
}

function toImportEntryPreviewResource(entry: ImportEntryPreview) {
  return {
    index: entry.index,
    structuralStatus: entry.structuralStatus,
    compatible: entry.compatible,
    profile: entry.profile,
    conformance: entry.conformance,
    sourceConformance:
      entry.sourceConformance === null
        ? null
        : {
            level: entry.sourceConformance.level,
            ...(entry.sourceConformance.missing === undefined
              ? {}
              : { missing: [...entry.sourceConformance.missing] }),
          },
    diagnostics: entry.diagnostics.map(toImportDiagnosticResource),
    schemaReferences: entry.schemaReferences.map(toImportedSchemaReferenceResource),
    name: entry.name,
    description: entry.description,
    id: entry.id,
    version: entry.version,
  }
}

/**
 * Returns the preview without the importer-internal canonical document. The
 * canonical document is derived data used only to commit an import; echoing it
 * would duplicate the whole source in every preview response.
 */
export function toImportPreviewResource(preview: ImportPreview) {
  return importPreviewSchema.parse({
    source: {
      adapter: preview.source.adapter,
      url: preview.source.url,
      requestedUrl: preview.source.requestedUrl,
      name: preview.source.name,
      retrievedAt: preview.source.retrievedAt,
      contentType: preview.source.contentType,
      status: preview.source.status,
      byteLength: preview.source.byteLength,
      contentDigest: preview.source.contentDigest,
      redirects: [...preview.source.redirects],
      envelope: {
        kind: preview.source.envelope.kind,
        member: preview.source.envelope.member,
        metadata: { ...preview.source.envelope.metadata },
      },
    },
    entries: preview.entries.map(toImportEntryPreviewResource),
    compatibility: {
      ...preview.compatibility,
      limitations: [...preview.compatibility.limitations],
    },
    diagnostics: preview.diagnostics.map(toImportDiagnosticResource),
  })
}

/** Projects an import result; imported rulebooks lose their internal fields. */
export function toImportResultResource(result: ImportResult) {
  return importResultSchema.parse({
    preview: toImportPreviewResource(result.preview),
    entries: result.entries.map((entry) => ({
      index: entry.index,
      disposition: entry.disposition,
      rulebookId: entry.rulebookId,
      entryKey: entry.entryKey,
      name: entry.name,
      sourceId: entry.sourceId,
      sourceVersion: entry.sourceVersion,
      contentFingerprint: entry.contentFingerprint,
      conflict:
        entry.conflict === null
          ? null
          : {
              code: entry.conflict.code,
              message: entry.conflict.message,
              rulebookId: entry.conflict.rulebookId,
              publishedVersions: [...entry.conflict.publishedVersions],
              locallyModified: entry.conflict.locallyModified,
              existingContentFingerprint: entry.conflict.existingContentFingerprint,
              incomingContentFingerprint: entry.conflict.incomingContentFingerprint,
              existingSourceVersion: entry.conflict.existingSourceVersion,
              incomingSourceVersion: entry.conflict.incomingSourceVersion,
            },
    })),
    rulebooks: result.rulebooks.map(toRulebookResource),
    conflicts: result.conflicts.map((conflict) => ({
      code: conflict.code,
      message: conflict.message,
      rulebookId: conflict.rulebookId,
      publishedVersions: [...conflict.publishedVersions],
      locallyModified: conflict.locallyModified,
      existingContentFingerprint: conflict.existingContentFingerprint,
      incomingContentFingerprint: conflict.incomingContentFingerprint,
      existingSourceVersion: conflict.existingSourceVersion,
      incomingSourceVersion: conflict.incomingSourceVersion,
    })),
    diagnostics: result.diagnostics.map(toImportDiagnosticResource),
  })
}

/**
 * Validates the validation engine's result against the published response
 * schema, so the engine and the OpenAPI contract cannot drift silently.
 */
export function toCredentialValidationResource(result: CredentialValidationResult) {
  return credentialValidationResultSchema.parse(result)
}
