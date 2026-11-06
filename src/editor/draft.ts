// Live validation of a rulebook editor draft document (issue #40).
//
// The editor edits the registry's normalized working-copy rows as one product
// document (metadata, attestation types and schema references). This module
// gives the browser immediate feedback without writing anything:
//
//   1. structural checks mirror the registry's bounded input rules and are the
//      authoritative "can this be saved?" signal (severity `error`);
//   2. for the supported TS11 v1.0.1 baseline, each attestation type is
//      projected into a SchemaMeta document and validated by the real standards
//      adapter, so invalid vocabularies, formats and schema references are
//      reported with their draft path (severity `error`);
//   3. incomplete but save-able draft values (an attestation without a format
//      or schema reference yet) are reported as `warning`s.
//
// The projection is only a validation input. Nothing is persisted from it, and
// unknown profiles are reported as a limitation instead of being silently
// validated against the wrong baseline.

import {
  parseSchemaMetaDocument,
  TS11_PROFILE,
  type AdapterDiagnostic,
  type SupportedProfile,
} from '../standards'
import { isRegistryError } from '../registry/errors'
import {
  MAX_ATTESTATIONS_PER_RULEBOOK,
  MAX_NAME_LENGTH,
  MAX_SCHEMA_REFERENCES_PER_ATTESTATION,
  MAX_SPEC_LENGTH,
  requireAbsoluteHttpUrl,
  requireDescription,
  requireIntegrity,
  requireStringArray,
  requireText,
} from '../registry/validation'

/** Baseline used for standards-level live validation. */
export const DRAFT_VALIDATION_PROFILE: SupportedProfile = TS11_PROFILE

/** Stable diagnostic severities for the editor contract. */
export const DRAFT_DIAGNOSTIC_SEVERITIES = ['error', 'warning'] as const
export type DraftDiagnosticSeverity = (typeof DRAFT_DIAGNOSTIC_SEVERITIES)[number]

/** One live validation finding. `path` is a dotted path within the draft. */
export interface DraftDiagnostic {
  readonly severity: DraftDiagnosticSeverity
  readonly code: string
  readonly message: string
  readonly path?: string
}

/** The result of validating one unsaved draft document. */
export interface DraftValidationReport {
  /** True when no structural or standards-level `error` was found. */
  readonly valid: boolean
  /**
   * True when no structural `error` was found. Standards-level errors are
   * reported but do not block saving a work-in-progress draft, because the
   * registry stores profile enumerations as extensible values (D-5).
   */
  readonly saveable: boolean
  /** Profile the standards checks ran against; `null` when they did not run. */
  readonly profile: SupportedProfile | null
  readonly diagnostics: readonly DraftDiagnostic[]
  /** Explicit boundaries of this validation run; never a pass claim. */
  readonly limitations: readonly string[]
}

/** One parsed schema reference of a draft document. */
interface ParsedSchemaReference {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity: string | null
}

/** One parsed attestation type of a draft document. */
interface ParsedAttestation {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
  readonly schemaReferences: readonly ParsedSchemaReference[]
}

interface ParsedDraft {
  readonly name: string
  readonly description: string
  readonly sourceUrl: string | null
  readonly applicableSpec: string
  readonly attestations: readonly ParsedAttestation[]
  readonly schemaReferences: readonly ParsedSchemaReference[]
}

interface ParseResult {
  readonly draft?: ParsedDraft
  readonly diagnostics: readonly DraftDiagnostic[]
}

/** Placeholders used only to project an attestation into a SchemaMeta document. */
const PLACEHOLDER_RULEBOOK_ID = '00000000-0000-4000-8000-000000000000'
const PLACEHOLDER_RULEBOOK_URI = 'https://attestbook.invalid/rulebooks/draft'
const VALIDATION_VERSION = '1.0.0'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function error(code: string, message: string, path?: string): DraftDiagnostic {
  return path === undefined
    ? { severity: 'error', code, message }
    : { severity: 'error', code, message, path }
}

function warning(code: string, message: string, path?: string): DraftDiagnostic {
  return path === undefined
    ? { severity: 'warning', code, message }
    : { severity: 'warning', code, message, path }
}

/**
 * Runs one registry input helper and turns its typed failure into a diagnostic.
 * This keeps the live report's structural rules identical to the save path.
 */
function attempt<T>(path: string, action: () => T, diagnostics: DraftDiagnostic[]): T | undefined {
  try {
    return action()
  } catch (caught) {
    if (isRegistryError(caught)) {
      diagnostics.push(error('invalid_member_value', caught.message, path))
      return undefined
    }
    throw caught
  }
}

function readRequiredText(
  value: unknown,
  path: string,
  maxLength: number,
  diagnostics: DraftDiagnostic[],
): string | undefined {
  return attempt(path, () => requireText(value, path, maxLength), diagnostics)
}

function readUrl(value: unknown, path: string, diagnostics: DraftDiagnostic[]): string | undefined {
  return attempt(path, () => requireAbsoluteHttpUrl(value, path), diagnostics)
}

function readSchemaReference(
  value: unknown,
  path: string,
  diagnostics: DraftDiagnostic[],
): ParsedSchemaReference | undefined {
  if (!isRecord(value)) {
    diagnostics.push(error('invalid_member_value', 'expected a schema reference object', path))
    return undefined
  }
  const formatIdentifier = readRequiredText(
    value.formatIdentifier,
    `${path}.formatIdentifier`,
    MAX_NAME_LENGTH,
    diagnostics,
  )
  const uri = readUrl(value.uri, `${path}.uri`, diagnostics)
  let integrity: string | null = null
  if (value.integrity !== undefined && value.integrity !== null) {
    integrity =
      attempt(
        `${path}.integrity`,
        () => requireIntegrity(value.integrity, `${path}.integrity`),
        diagnostics,
      ) ?? null
  }
  if (formatIdentifier === undefined || uri === undefined) {
    return undefined
  }
  return { formatIdentifier, uri, integrity }
}

function readSchemaReferences(
  value: unknown,
  path: string,
  diagnostics: DraftDiagnostic[],
): ParsedSchemaReference[] | undefined {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    diagnostics.push(error('invalid_member_value', 'expected an array', path))
    return undefined
  }
  if (value.length > MAX_SCHEMA_REFERENCES_PER_ATTESTATION) {
    diagnostics.push(
      error(
        'invalid_member_value',
        `must contain at most ${MAX_SCHEMA_REFERENCES_PER_ATTESTATION} items`,
        path,
      ),
    )
    return undefined
  }
  const references: ParsedSchemaReference[] = []
  const formats = new Set<string>()
  let valid = true
  value.forEach((entry, index) => {
    const reference = readSchemaReference(entry, `${path}.${index}`, diagnostics)
    if (reference === undefined) {
      valid = false
      return
    }
    if (formats.has(reference.formatIdentifier)) {
      diagnostics.push(
        error(
          'duplicate_format_identifier',
          `duplicate formatIdentifier "${reference.formatIdentifier}"`,
          `${path}.${index}.formatIdentifier`,
        ),
      )
      valid = false
      return
    }
    formats.add(reference.formatIdentifier)
    references.push(reference)
  })
  return valid ? references : undefined
}

function readSupportedFormats(
  value: unknown,
  path: string,
  diagnostics: DraftDiagnostic[],
): string[] | undefined {
  if (value === undefined) {
    return []
  }
  const formats = attempt(path, () => requireStringArray(value, path), diagnostics)
  if (formats === undefined) {
    return undefined
  }
  // The shared helper enforces the array bound, item type and uniqueness.
  return [...formats]
}

function readAttestation(
  value: unknown,
  index: number,
  diagnostics: DraftDiagnostic[],
): ParsedAttestation | undefined {
  const path = `attestations.${index}`
  if (!isRecord(value)) {
    diagnostics.push(error('invalid_member_value', 'expected an attestation object', path))
    return undefined
  }
  const name = readRequiredText(value.name, `${path}.name`, MAX_NAME_LENGTH, diagnostics)
  const attestationLoS = readRequiredText(
    value.attestationLoS,
    `${path}.attestationLoS`,
    MAX_NAME_LENGTH,
    diagnostics,
  )
  const bindingType = readRequiredText(
    value.bindingType,
    `${path}.bindingType`,
    MAX_NAME_LENGTH,
    diagnostics,
  )
  const supportedFormats = readSupportedFormats(
    value.supportedFormats,
    `${path}.supportedFormats`,
    diagnostics,
  )
  const schemaReferences = readSchemaReferences(
    value.schemaReferences,
    `${path}.schemaReferences`,
    diagnostics,
  )
  if (
    name === undefined ||
    attestationLoS === undefined ||
    bindingType === undefined ||
    supportedFormats === undefined ||
    schemaReferences === undefined
  ) {
    return undefined
  }
  return { name, attestationLoS, bindingType, supportedFormats, schemaReferences }
}

/** Parses and structurally checks one draft document without writing it. */
function parseDraftDocument(value: unknown): ParseResult {
  const diagnostics: DraftDiagnostic[] = []
  if (!isRecord(value)) {
    return {
      diagnostics: [error('invalid_schema_meta', 'the draft document must be a JSON object', '')],
    }
  }

  const name = readRequiredText(value.name, 'name', MAX_NAME_LENGTH, diagnostics)

  let description = ''
  if (value.description !== undefined && value.description !== null) {
    description =
      attempt(
        'description',
        () => requireDescription(value.description, 'description'),
        diagnostics,
      ) ?? ''
  }

  let sourceUrl: string | null = null
  if (value.sourceUrl !== undefined && value.sourceUrl !== null) {
    const parsed = readUrl(value.sourceUrl, 'sourceUrl', diagnostics)
    if (parsed !== undefined) {
      sourceUrl = parsed
    }
  }

  const applicableSpec = readRequiredText(
    value.applicableSpec,
    'applicableSpec',
    MAX_SPEC_LENGTH,
    diagnostics,
  )

  let attestations: ParsedAttestation[] | undefined = []
  if (value.attestations !== undefined) {
    if (!Array.isArray(value.attestations)) {
      diagnostics.push(error('invalid_member_value', 'expected an array', 'attestations'))
      attestations = undefined
    } else if (value.attestations.length > MAX_ATTESTATIONS_PER_RULEBOOK) {
      diagnostics.push(
        error(
          'invalid_member_value',
          `must contain at most ${MAX_ATTESTATIONS_PER_RULEBOOK} items`,
          'attestations',
        ),
      )
      attestations = undefined
    } else {
      const names = new Set<string>()
      const parsed: ParsedAttestation[] = []
      let valid = true
      value.attestations.forEach((entry, index) => {
        const attestation = readAttestation(entry, index, diagnostics)
        if (attestation === undefined) {
          valid = false
          return
        }
        if (names.has(attestation.name)) {
          diagnostics.push(
            error(
              'duplicate_attestation_name',
              `duplicate attestation type name "${attestation.name}"`,
              `attestations.${index}.name`,
            ),
          )
          valid = false
          return
        }
        names.add(attestation.name)
        parsed.push(attestation)
      })
      attestations = valid ? parsed : undefined
    }
  }

  const schemaReferences = readSchemaReferences(
    value.schemaReferences,
    'schemaReferences',
    diagnostics,
  )

  if (
    name === undefined ||
    applicableSpec === undefined ||
    attestations === undefined ||
    schemaReferences === undefined
  ) {
    return { diagnostics }
  }

  return {
    draft: {
      name,
      description,
      sourceUrl,
      applicableSpec,
      attestations,
      schemaReferences,
    },
    diagnostics,
  }
}

function isIncompleteStandardsFinding(diagnostic: AdapterDiagnostic): boolean {
  if (diagnostic.kind !== 'invalid_input') {
    return false
  }
  if (diagnostic.path === 'supportedFormats') {
    return /at least one supported format/.test(diagnostic.message)
  }
  if (diagnostic.path === 'schemaURIs') {
    return /at least one schema URI/.test(diagnostic.message)
  }
  return (
    diagnostic.code === 'missing_required_member' &&
    (diagnostic.path === 'supportedFormats' || diagnostic.path === 'schemaURIs')
  )
}

function draftPath(base: string, path: string | undefined): string {
  if (path === undefined || path === '') {
    return base
  }
  const mapped =
    path === 'schemaURIs' || path.startsWith('schemaURIs.')
      ? path.replace(/^schemaURIs/, 'schemaReferences')
      : path
  return `${base}.${mapped}`
}

function toDraftDiagnostic(base: string, diagnostic: AdapterDiagnostic): DraftDiagnostic {
  const severity: DraftDiagnosticSeverity =
    diagnostic.kind === 'invalid_input' && !isIncompleteStandardsFinding(diagnostic)
      ? 'error'
      : 'warning'
  return {
    severity,
    code: diagnostic.code,
    message: diagnostic.message,
    path: draftPath(base, diagnostic.path),
  }
}

function buildSchemaUri(reference: ParsedSchemaReference): string {
  return reference.integrity === null
    ? reference.uri
    : `${reference.uri}#integrity=${reference.integrity}`
}

/**
 * Validates one unsaved draft document. The structural rules are the same
 * bounds the registry enforces on save; the standards rules are the pinned
 * TS11 v1.0.1 baseline evaluated by the real adapter.
 */
export function validateDraftContent(value: unknown): DraftValidationReport {
  const { draft, diagnostics } = parseDraftDocument(value)
  if (draft === undefined || diagnostics.some((finding) => finding.severity === 'error')) {
    return { valid: false, saveable: false, profile: null, diagnostics, limitations: [] }
  }

  const findings: DraftDiagnostic[] = [...diagnostics]
  const limitations: string[] = [
    'Live standards validation covers the TS11 v1.0.1 baseline; it is not a claim of TS11 or ETSI conformance.',
    'The rulebook URI is derived from the source URL (or a validation placeholder when no source URL is set), and trust authorities and the draft version label are not edited here.',
  ]

  if (draft.applicableSpec !== TS11_PROFILE) {
    findings.push(
      warning(
        'unsupported_profile',
        `Live standards validation is implemented for "${TS11_PROFILE}"; "${draft.applicableSpec}" was checked structurally only.`,
        'applicableSpec',
      ),
    )
    limitations.push(`No standards-level checks ran for profile "${draft.applicableSpec}".`)
    return {
      valid: !findings.some((finding) => finding.severity === 'error'),
      saveable: true,
      profile: null,
      diagnostics: findings,
      limitations,
    }
  }

  draft.attestations.forEach((attestation, index) => {
    const base = `attestations.${index}`
    const incomplete: DraftDiagnostic[] = []
    if (attestation.supportedFormats.length === 0) {
      incomplete.push(
        warning(
          'incomplete_attestation',
          'this attestation type has no supported formats yet; it was not validated against TS11',
          `${base}.supportedFormats`,
        ),
      )
    }
    if (attestation.schemaReferences.length === 0) {
      incomplete.push(
        warning(
          'incomplete_attestation',
          'this attestation type has no schema references yet; it was not validated against TS11',
          `${base}.schemaReferences`,
        ),
      )
    }
    findings.push(...incomplete)
    if (incomplete.length > 0) {
      return
    }
    const document: Record<string, unknown> = {
      id: PLACEHOLDER_RULEBOOK_ID,
      version: VALIDATION_VERSION,
      rulebookURI: draft.sourceUrl ?? PLACEHOLDER_RULEBOOK_URI,
      attestationLoS: attestation.attestationLoS,
      bindingType: attestation.bindingType,
      supportedFormats: [...attestation.supportedFormats],
      schemaURIs: attestation.schemaReferences.map((reference) => ({
        formatIdentifier: reference.formatIdentifier,
        uri: buildSchemaUri(reference),
      })),
    }
    const result = parseSchemaMetaDocument(document, { profile: TS11_PROFILE })
    for (const diagnostic of result.diagnostics) {
      findings.push(toDraftDiagnostic(base, diagnostic))
    }
  })

  return {
    valid: !findings.some((finding) => finding.severity === 'error'),
    saveable: true,
    profile: TS11_PROFILE,
    diagnostics: findings,
    limitations,
  }
}
