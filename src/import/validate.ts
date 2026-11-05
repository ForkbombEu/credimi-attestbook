// Per-entry validation and conformance classification for rulebook import (#30).
//
// The preview orchestrator in `preview.ts` hands each catalog entry to this
// module. Structural validity comes from the pinned TS11/OWF adapter; the
// import layer adds its own bounds for schema references, derives the product
// name and keeps a source's self-reported conformance separate from the
// AttestBook classification.

import {
  detectProfile,
  parseSchemaMetaDocument,
  TS11_PROFILE,
  validateSchemaMetaDocument,
  type AdapterDiagnostic,
  type CanonicalSchemaMeta,
  type SupportedProfile,
} from '../standards'
import { isRecord } from '../standards/profiles'
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_INTEGRITY_LENGTH,
  MAX_METADATA_BYTES,
  MAX_NAME_LENGTH,
  MAX_SCHEMA_REFERENCES_PER_ATTESTATION,
  MAX_STRING_ARRAY_ITEMS,
  MAX_URL_LENGTH,
} from '../registry/validation'

import type { ImportLimits } from './limits'

/** Conformance classification required by FR-004 / requirement R4.4. */
export const CONFORMANCE_CLASSIFICATIONS = [
  'conformant_subset',
  'partial',
  'not_verified',
  'prose_only',
] as const

export type ConformanceClassification = (typeof CONFORMANCE_CLASSIFICATIONS)[number]

/** A source's own conformance claim, retained separately from AttestBook's. */
export interface SourceConformanceSignal {
  readonly level: string
  readonly missing?: readonly string[]
}

/** A validated schema reference retained from the imported document. */
export interface ImportedSchemaReference {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity?: string
  /** OWF meta/unknown members retained as registry-internal metadata. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Diagnostic kind used by the import pipeline; `limit` marks a bound breach. */
export type ImportDiagnosticKind = AdapterDiagnostic['kind'] | 'limit'

export interface ImportDiagnostic {
  readonly kind: ImportDiagnosticKind
  readonly code: string
  readonly message: string
  readonly path?: string
}

export type ImportEntryStructuralStatus = 'valid' | 'invalid'

/** One catalog entry's validation, compatibility and provenance summary. */
export interface ImportEntryPreview {
  readonly index: number
  readonly structuralStatus: ImportEntryStructuralStatus
  /** True only when the entry is structurally valid and its references are safe. */
  readonly compatible: boolean
  readonly profile: SupportedProfile | null
  readonly conformance: ConformanceClassification
  readonly sourceConformance: SourceConformanceSignal | null
  readonly diagnostics: readonly ImportDiagnostic[]
  readonly schemaReferences: readonly ImportedSchemaReference[]
  readonly name: string | null
  readonly description: string
  readonly id: string | null
  readonly version: string | null
  /** Canonical document used by the authenticated import; `null` when invalid. */
  readonly canonical: CanonicalSchemaMeta | null
}

function toDiagnostic(entry: AdapterDiagnostic): ImportDiagnostic {
  return {
    kind: entry.kind,
    code: entry.code,
    message: entry.message,
    ...(entry.path !== undefined ? { path: entry.path } : {}),
  }
}

function entryDiagnostic(
  kind: ImportDiagnosticKind,
  code: string,
  message: string,
  path: string,
): ImportDiagnostic {
  return { kind, code, message, path }
}

export function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > maxLength) {
    return undefined
  }
  return trimmed
}

function firstBoundedString(values: readonly unknown[], maxLength: number): string | undefined {
  for (const value of values) {
    const candidate = boundedString(value, maxLength)
    if (candidate !== undefined) {
      return candidate
    }
  }
  return undefined
}

function readSourceConformance(
  record: Readonly<Record<string, unknown>>,
  diagnostics: ImportDiagnostic[],
): SourceConformanceSignal | null {
  const raw = record.conformance
  if (raw === undefined) {
    return null
  }

  if (typeof raw === 'string') {
    const level = boundedString(raw, 40)
    if (level === undefined) {
      diagnostics.push(
        entryDiagnostic(
          'preserved',
          'invalid_source_conformance',
          'the source conformance claim is not a bounded non-empty string and was ignored',
          'conformance',
        ),
      )
      return null
    }
    return { level }
  }

  if (!isRecord(raw)) {
    diagnostics.push(
      entryDiagnostic(
        'preserved',
        'invalid_source_conformance',
        'the source conformance claim is not an object or string and was ignored',
        'conformance',
      ),
    )
    return null
  }

  const level = boundedString(raw.level, 40)
  if (level === undefined) {
    diagnostics.push(
      entryDiagnostic(
        'preserved',
        'invalid_source_conformance',
        'the source conformance claim has no bounded "level" string and was ignored',
        'conformance.level',
      ),
    )
    return null
  }

  const missing: string[] = []
  if (Array.isArray(raw.missing)) {
    for (const item of raw.missing.slice(0, 32)) {
      const member = boundedString(item, 200)
      if (member !== undefined) {
        missing.push(member)
      }
    }
  }
  return missing.length > 0 ? { level, missing } : { level }
}

const CONFORMANCE_RANK: Readonly<Record<ConformanceClassification, number>> = {
  prose_only: 0,
  not_verified: 1,
  partial: 2,
  conformant_subset: 3,
}

/** A source claim may lower, never raise, AttestBook's own classification. */
function applySourceConformance(
  base: ConformanceClassification,
  signal: SourceConformanceSignal | null,
): ConformanceClassification {
  if (signal === null) {
    return base
  }
  const level = signal.level.toLowerCase().replace(/[-\s]+/g, '_')
  let claimed: ConformanceClassification | undefined
  if (level === 'prose' || level === 'prose_only') {
    claimed = 'prose_only'
  } else if (
    level === 'none' ||
    level === 'not_verified' ||
    level === 'unverified' ||
    level === 'unknown'
  ) {
    claimed = 'not_verified'
  } else if (level === 'partial') {
    claimed = 'partial'
  }
  if (claimed === undefined) {
    return base
  }
  return CONFORMANCE_RANK[claimed] <= CONFORMANCE_RANK[base] ? claimed : base
}

interface SchemaReferenceRead {
  readonly references: readonly ImportedSchemaReference[]
  readonly compatible: boolean
}

function hasControlCharacter(value: string, allowLayoutWhitespace: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code !== 127 && code >= 32) {
      continue
    }
    if (allowLayoutWhitespace && (code === 9 || code === 10 || code === 13)) {
      continue
    }
    return true
  }
  return false
}

const INTEGRITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9+/=_-]+$/

/** Mirrors the registry's attestation-field limits so the preview cannot
 * report an entry as compatible when `createRulebooks` would refuse it. */
function checkAttestationFields(
  canonical: CanonicalSchemaMeta,
  diagnostics: ImportDiagnostic[],
): boolean {
  let compatible = true
  const boundedField = (value: string, path: string): void => {
    if (value.trim() === '' || value.length > MAX_NAME_LENGTH) {
      diagnostics.push(
        entryDiagnostic(
          'limit',
          'registry_field_limit',
          `the field must be non-empty and at most ${MAX_NAME_LENGTH} characters`,
          path,
        ),
      )
      compatible = false
    } else if (hasControlCharacter(value, false)) {
      diagnostics.push(
        entryDiagnostic(
          'invalid_input',
          'registry_field_invalid',
          'the field contains a control character',
          path,
        ),
      )
      compatible = false
    }
  }

  boundedField(canonical.attestationLoS, 'attestationLoS')
  boundedField(canonical.bindingType, 'bindingType')

  if (canonical.supportedFormats.length > MAX_STRING_ARRAY_ITEMS) {
    diagnostics.push(
      entryDiagnostic(
        'limit',
        'registry_field_limit',
        `supportedFormats exceeds the registry's ${MAX_STRING_ARRAY_ITEMS}-item limit`,
        'supportedFormats',
      ),
    )
    compatible = false
  }
  const seenFormats = new Set<string>()
  canonical.supportedFormats.forEach((format, index) => {
    boundedField(format, `supportedFormats.${index}`)
    if (seenFormats.has(format)) {
      diagnostics.push(
        entryDiagnostic(
          'invalid_input',
          'registry_field_invalid',
          `supportedFormats repeats "${format}"`,
          `supportedFormats.${index}`,
        ),
      )
      compatible = false
    }
    seenFormats.add(format)
  })

  return compatible
}

function checkDerivedFields(
  name: string,
  description: string,
  diagnostics: ImportDiagnostic[],
): boolean {
  let compatible = true
  if (name.length > MAX_NAME_LENGTH) {
    diagnostics.push(
      entryDiagnostic(
        'limit',
        'registry_field_limit',
        `the derived rulebook name exceeds the registry's ${MAX_NAME_LENGTH}-character limit`,
        'name',
      ),
    )
    compatible = false
  }
  if (hasControlCharacter(name, false)) {
    diagnostics.push(
      entryDiagnostic(
        'invalid_input',
        'registry_field_invalid',
        'the derived rulebook name contains a control character',
        'name',
      ),
    )
    compatible = false
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    diagnostics.push(
      entryDiagnostic(
        'limit',
        'registry_field_limit',
        `the derived description exceeds the registry's ${MAX_DESCRIPTION_LENGTH}-character limit`,
        'description',
      ),
    )
    compatible = false
  }
  if (hasControlCharacter(description, true)) {
    diagnostics.push(
      entryDiagnostic(
        'invalid_input',
        'registry_field_invalid',
        'the derived description contains a control character',
        'description',
      ),
    )
    compatible = false
  }
  return compatible
}

function readSchemaReferences(
  canonical: CanonicalSchemaMeta,
  limits: ImportLimits,
  diagnostics: ImportDiagnostic[],
): SchemaReferenceRead {
  const references: ImportedSchemaReference[] = []
  let compatible = true

  const maxReferences = Math.min(
    limits.maxSchemaReferencesPerEntry,
    MAX_SCHEMA_REFERENCES_PER_ATTESTATION,
  )
  if (canonical.schemaURIs.length > maxReferences) {
    diagnostics.push(
      entryDiagnostic(
        'limit',
        'schema_reference_limit',
        `the entry has more than ${maxReferences} schema references`,
        'schemaURIs',
      ),
    )
    compatible = false
  }

  const maxReferenceLength = Math.min(limits.maxSchemaReferenceLength, MAX_URL_LENGTH)
  const seenFormats = new Set<string>()
  canonical.schemaURIs.slice(0, maxReferences).forEach((reference, index) => {
    const path = `schemaURIs.${index}.uri`
    if (
      reference.formatIdentifier.trim() === '' ||
      reference.formatIdentifier.length > MAX_NAME_LENGTH ||
      hasControlCharacter(reference.formatIdentifier, false)
    ) {
      diagnostics.push(
        entryDiagnostic(
          'limit',
          'registry_field_limit',
          `formatIdentifier must be non-empty, control-free and at most ${MAX_NAME_LENGTH} characters`,
          `schemaURIs.${index}.formatIdentifier`,
        ),
      )
      compatible = false
      return
    }
    if (seenFormats.has(reference.formatIdentifier)) {
      diagnostics.push(
        entryDiagnostic(
          'invalid_input',
          'registry_field_invalid',
          `schema references repeat the formatIdentifier "${reference.formatIdentifier}"`,
          `schemaURIs.${index}.formatIdentifier`,
        ),
      )
      compatible = false
      return
    }
    seenFormats.add(reference.formatIdentifier)
    if (hasControlCharacter(reference.uri, false)) {
      diagnostics.push(
        entryDiagnostic(
          'invalid_input',
          'schema_reference_invalid',
          'the schema reference must not contain control characters',
          path,
        ),
      )
      compatible = false
      return
    }
    if (reference.uri.length > maxReferenceLength) {
      diagnostics.push(
        entryDiagnostic(
          'limit',
          'schema_reference_limit',
          `the schema reference exceeds the ${maxReferenceLength}-character limit`,
          path,
        ),
      )
      compatible = false
      return
    }

    let parsed: URL
    try {
      parsed = new URL(reference.uri)
    } catch {
      diagnostics.push(
        entryDiagnostic(
          'invalid_input',
          'schema_reference_invalid',
          'the schema reference must be an absolute URL',
          path,
        ),
      )
      compatible = false
      return
    }

    if (parsed.protocol !== 'https:') {
      diagnostics.push(
        entryDiagnostic(
          'unsupported_operation',
          'schema_reference_invalid',
          'schema references must use https; other schemes are not fetched or stored',
          path,
        ),
      )
      compatible = false
      return
    }
    if (parsed.username !== '' || parsed.password !== '') {
      diagnostics.push(
        entryDiagnostic(
          'invalid_input',
          'schema_reference_invalid',
          'the schema reference must not embed credentials',
          path,
        ),
      )
      compatible = false
      return
    }
    if (reference.integrity !== undefined) {
      if (
        reference.integrity.length > MAX_INTEGRITY_LENGTH ||
        !INTEGRITY_PATTERN.test(reference.integrity)
      ) {
        diagnostics.push(
          entryDiagnostic(
            'invalid_input',
            'registry_field_invalid',
            'the schema reference integrity is not a bounded W3C SRI value',
            `schemaURIs.${index}.integrity`,
          ),
        )
        compatible = false
        return
      }
    }

    const metadata: Record<string, unknown> = {}
    if (reference.meta !== undefined) {
      metadata.meta = reference.meta
    }
    if (reference.unknownMembers !== undefined) {
      metadata.unknownMembers = reference.unknownMembers
    }
    if (Object.keys(metadata).length > 0) {
      let serialized: string | undefined
      try {
        serialized = JSON.stringify(metadata)
      } catch {
        serialized = undefined
      }
      if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
        diagnostics.push(
          entryDiagnostic(
            'limit',
            'registry_field_limit',
            `the schema reference metadata exceeds the registry's ${MAX_METADATA_BYTES}-byte limit`,
            `schemaURIs.${index}.metadata`,
          ),
        )
        compatible = false
        return
      }
    }

    references.push({
      formatIdentifier: reference.formatIdentifier,
      uri: parsed.href,
      ...(reference.integrity !== undefined ? { integrity: reference.integrity } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    })
  })

  return { references, compatible }
}

function deriveName(
  record: Readonly<Record<string, unknown>>,
  canonical: CanonicalSchemaMeta,
): string {
  const unknown = canonical.unknownMembers
  const candidate = firstBoundedString(
    [
      record.title,
      record.displayName,
      record.attestationType,
      record.name,
      unknown.title,
      unknown.displayName,
      unknown.attestationType,
      unknown.name,
    ],
    200,
  )
  if (candidate !== undefined) {
    return candidate
  }
  if (canonical.id !== undefined) {
    return `Imported rulebook ${canonical.id}`.slice(0, 200)
  }
  return `Imported rulebook ${canonical.version}`.slice(0, 200)
}

function deriveDescription(
  record: Readonly<Record<string, unknown>>,
  canonical: CanonicalSchemaMeta,
): string {
  const description = firstBoundedString(
    [record.description, canonical.unknownMembers.description],
    10_000,
  )
  return description ?? ''
}

/**
 * Validates one catalog entry. Structural errors are reported per entry so a
 * preview names every broken entry instead of only the first one.
 */
export function previewCatalogEntry(
  entry: unknown,
  index: number,
  limits: ImportLimits,
): ImportEntryPreview {
  const diagnostics: ImportDiagnostic[] = []
  const base = {
    index,
    profile: null,
    sourceConformance: null,
    schemaReferences: [] as readonly ImportedSchemaReference[],
    id: null,
    version: null,
  }

  if (!isRecord(entry)) {
    return {
      ...base,
      structuralStatus: 'invalid',
      compatible: false,
      conformance: 'not_verified',
      diagnostics: [
        entryDiagnostic(
          'invalid_input',
          'invalid_import_entry',
          'the catalog entry must be a JSON object',
          `entries.${index}`,
        ),
      ],
      name: null,
      description: '',
      canonical: null,
    }
  }

  const sourceConformance = readSourceConformance(entry, diagnostics)

  const detected = detectProfile(entry)
  if (!detected.ok) {
    return {
      ...base,
      structuralStatus: 'invalid',
      compatible: false,
      conformance: 'not_verified',
      diagnostics: [...diagnostics, ...detected.diagnostics.map(toDiagnostic)],
      name:
        firstBoundedString([entry.title, entry.displayName, entry.attestationType], 200) ?? null,
      description: firstBoundedString([entry.description], 10_000) ?? '',
      sourceConformance,
      canonical: null,
    }
  }

  const profile = detected.value
  const parsed = parseSchemaMetaDocument(entry, { profile })
  if (!parsed.ok) {
    return {
      ...base,
      profile,
      structuralStatus: 'invalid',
      compatible: false,
      conformance: 'not_verified',
      diagnostics: [...diagnostics, ...parsed.diagnostics.map(toDiagnostic)],
      name:
        firstBoundedString([entry.title, entry.displayName, entry.attestationType], 200) ?? null,
      description: firstBoundedString([entry.description], 10_000) ?? '',
      sourceConformance,
      canonical: null,
    }
  }

  const canonical = parsed.value
  const strict = validateSchemaMetaDocument(entry, { profile })
  const baseConformance: ConformanceClassification =
    profile === TS11_PROFILE && strict.ok ? 'conformant_subset' : 'partial'
  const conformance = applySourceConformance(baseConformance, sourceConformance)

  const schemaReferences = readSchemaReferences(canonical, limits, diagnostics)
  const fieldsCompatible = checkAttestationFields(canonical, diagnostics)
  const name = deriveName(entry, canonical)
  const description = deriveDescription(entry, canonical)
  const productCompatible = checkDerivedFields(name, description, diagnostics)

  return {
    index,
    structuralStatus: 'valid',
    compatible: schemaReferences.compatible && fieldsCompatible && productCompatible,
    profile,
    conformance,
    sourceConformance,
    diagnostics,
    schemaReferences: schemaReferences.references,
    name,
    description,
    id: canonical.id ?? null,
    version: canonical.version,
    canonical,
  }
}
