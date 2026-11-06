// Pure editor helpers for the rulebook draft page (issue #40).
//
// The browser parses the JSON editor locally so a syntax error is shown
// immediately, then asks the server to validate the same document. Field
// requirements that the registry enforces are only checked here for a fast
// form-level message; the server remains authoritative.

import type {
  DraftAttestation,
  DraftAttestationInput,
  DraftContentDocument,
  DraftDiagnostic,
  DraftRulebook,
  DraftSchemaReference,
  DraftSchemaReferenceInput,
  SaveDraftRequest,
} from './types'

/** Profile label used for a new draft; the server validates this baseline. */
export const DEFAULT_APPLICABLE_SPEC = 'ts11@1.0.1'

/** The metadata form state of the editor. */
export interface DraftMetadata {
  readonly name: string
  readonly description: string
  readonly sourceUrl: string
  readonly applicableSpec: string
}

export const EMPTY_METADATA: DraftMetadata = {
  name: '',
  description: '',
  sourceUrl: '',
  applicableSpec: DEFAULT_APPLICABLE_SPEC,
}

export const EMPTY_DRAFT_DOCUMENT: DraftContentDocument = {
  attestations: [],
  schemaReferences: [],
}

export type DraftParseResult =
  | { readonly ok: true; readonly document: DraftContentDocument }
  | { readonly ok: false; readonly message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses the JSON editor text. Only the container shape is checked here:
 * per-attestation validation is the server's job, and echoing it locally would
 * create two rules that could disagree.
 */
export function parseDraftDocument(text: string): DraftParseResult {
  if (text.trim() === '') {
    return { ok: false, message: 'The JSON editor is empty. Add an attestations array.' }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, message: 'The JSON editor does not contain valid JSON.' }
  }
  if (!isRecord(value)) {
    return { ok: false, message: 'The JSON document must be an object.' }
  }
  const attestations = value.attestations ?? []
  if (!Array.isArray(attestations)) {
    return { ok: false, message: '"attestations" must be an array.' }
  }
  const schemaReferences = value.schemaReferences ?? []
  if (!Array.isArray(schemaReferences)) {
    return { ok: false, message: '"schemaReferences" must be an array.' }
  }
  return {
    ok: true,
    document: {
      attestations: attestations as readonly DraftAttestation[],
      schemaReferences: schemaReferences as readonly DraftSchemaReference[],
    },
  }
}

/** Stable, human-editable JSON for the editor. */
export function serializeDraftDocument(document: DraftContentDocument): string {
  return JSON.stringify(
    {
      attestations: document.attestations.map((attestation) => ({
        name: attestation.name,
        attestationLoS: attestation.attestationLoS,
        bindingType: attestation.bindingType,
        supportedFormats: attestation.supportedFormats,
        schemaReferences: attestation.schemaReferences.map((reference) => ({
          formatIdentifier: reference.formatIdentifier,
          uri: reference.uri,
          ...(reference.integrity === null ? {} : { integrity: reference.integrity }),
        })),
      })),
      schemaReferences: document.schemaReferences.map((reference) => ({
        formatIdentifier: reference.formatIdentifier,
        uri: reference.uri,
        ...(reference.integrity === null ? {} : { integrity: reference.integrity }),
      })),
    },
    null,
    2,
  )
}

/** Extracts the editable JSON document from a loaded draft. */
export function documentFromDraft(draft: DraftRulebook): DraftContentDocument {
  return {
    attestations: draft.attestations,
    schemaReferences: draft.schemaReferences,
  }
}

/** Builds the request body shared by create, save and validate. */
export function draftRequest(
  metadata: DraftMetadata,
  document: DraftContentDocument,
): SaveDraftRequest {
  const sourceUrl = metadata.sourceUrl.trim()
  return {
    name: metadata.name,
    description: metadata.description,
    // One body works for create, save and validate. The create contract does
    // not accept null, while PUT treats an omitted source URL as clearing it.
    ...(sourceUrl === '' ? {} : { sourceUrl }),
    applicableSpec: metadata.applicableSpec,
    // Pass the parsed document through unchanged: the server's whitelist
    // projection and registry validation are authoritative, and rewriting
    // malformed entries here could crash the page before they can be reported.
    attestations: document.attestations as unknown as readonly DraftAttestationInput[],
    schemaReferences: document.schemaReferences as unknown as readonly DraftSchemaReferenceInput[],
  }
}

export interface DraftDiagnosticCounts {
  readonly errors: number
  readonly warnings: number
}

export function countDiagnostics(diagnostics: readonly DraftDiagnostic[]): DraftDiagnosticCounts {
  let errors = 0
  let warnings = 0
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') {
      errors += 1
    } else {
      warnings += 1
    }
  }
  return { errors, warnings }
}

/** One short, plain-language summary of the latest validation report. */
export function validationSummary(diagnostics: readonly DraftDiagnostic[]): string {
  const { errors, warnings } = countDiagnostics(diagnostics)
  if (errors === 0 && warnings === 0) {
    return 'No validation findings.'
  }
  const parts: string[] = []
  if (errors > 0) {
    parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`)
  }
  if (warnings > 0) {
    parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`)
  }
  return `${parts.join(' and ')} found.`
}

/** Turns `attestations.0.schemaReferences.1.uri` into a readable location. */
export function describeDiagnosticPath(path: string | undefined): string {
  if (path === undefined || path === '') {
    return 'Document'
  }
  return path.replaceAll('.', ' › ')
}

/** Returns form-level metadata errors, keyed by field. */
export function validateMetadata(metadata: DraftMetadata): Readonly<Record<string, string>> {
  const errors: Record<string, string> = {}
  if (metadata.name.trim() === '') {
    errors.name = 'A rulebook name is required.'
  }
  if (metadata.applicableSpec.trim() === '') {
    errors.applicableSpec = 'An applicable specification is required.'
  }
  return errors
}
