// Wire types of the public product API that the catalog consumes (issue #36).
//
// These mirror the stable response fields of src/api/schemas.ts. The UI only
// reads the public projection: provider, rulebook, attestation, schema
// reference and version metadata. It never receives registry-internal
// provenance, metadata or tokens.

export type PublicationStatus = 'draft' | 'published' | 'historical'

export interface Provider {
  readonly id: string
  readonly name: string
  readonly createdAt: string
}

export interface Rulebook {
  readonly id: string
  readonly providerId: string
  readonly name: string
  readonly description: string
  readonly sourceUrl: string | null
  readonly applicableSpec: string
  readonly publicationStatus: PublicationStatus
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SchemaReference {
  readonly id: string
  readonly rulebookId: string
  /** Attestation type this reference belongs to; `null` for rulebook-level. */
  readonly attestationId: string | null
  readonly formatIdentifier: string
  readonly uri: string
  /** W3C SRI value such as `sha256-...`, when the source carries one. */
  readonly integrity: string | null
  readonly createdAt: string
}

export interface Attestation {
  readonly id: string
  readonly rulebookId: string
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
  readonly schemaReferences: readonly SchemaReference[]
  readonly createdAt: string
}

export interface RulebookVersion {
  readonly id: string
  readonly rulebookId: string
  readonly version: string
  readonly status: PublicationStatus
  readonly contentDigest: string
  readonly specVersion: string
  readonly createdAt: string
  readonly publishedAt: string | null
}

export interface Pagination {
  readonly limit: number
  readonly offset: number
  readonly total: number
}

export interface RulebookPage {
  readonly data: readonly Rulebook[]
  readonly pagination: Pagination
}
