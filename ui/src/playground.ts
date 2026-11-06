// Credential validation playground logic (issue #38, UI-005).
//
// Everything here is pure data logic so the form rules, status labels, request
// shape and export document can be unit-tested without a DOM. The page only
// ever sends the credential to `POST /api/v1/credentials/validate`; the result
// contains non-sensitive facts, so the exported report never carries the
// pasted or uploaded credential text or any claim value.

import type {
  CredentialFormatHint,
  CredentialValidationResult,
  ValidationDimensionId,
  ValidationStatus,
  ValidateCredentialRequest,
} from './types'
import { EVALUATION_SUPPORT } from './compatibility'

/** The API's credential bound (`src/validation/request.ts`). */
export const MAX_CREDENTIAL_LENGTH = 512 * 1024

/** Formats the API recognises from an explicit hint; empty means auto-detect. */
export const CREDENTIAL_FORMAT_OPTIONS: readonly {
  readonly value: '' | CredentialFormatHint
  readonly label: string
}[] = [
  { value: '', label: 'Detect automatically' },
  { value: 'dc+sd-jwt', label: 'dc+sd-jwt' },
  { value: 'mso_mdoc', label: 'mso_mdoc' },
  { value: 'jwt_vc_json', label: 'jwt_vc_json' },
  { value: 'jwt_vc_json-ld', label: 'jwt_vc_json-ld' },
  { value: 'ldp_vc', label: 'ldp_vc' },
]

export const VALIDATION_STATUS_LABELS: Readonly<Record<ValidationStatus, string>> = {
  PASS: 'Passed',
  FAIL: 'Failed',
  NOT_TESTED: 'Not tested',
  NOT_APPLICABLE: 'Not applicable',
  INCONCLUSIVE: 'Inconclusive',
}

export const VALIDATION_SEVERITY_LABELS = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
} as const

/**
 * Display title of an FR-010 dimension. The catalogue is shared with the
 * rulebook-detail compatibility disclosure, whose test compares it with the
 * engine's normative dimension definitions, so a result can never show a
 * dimension the engine does not have.
 */
export function dimensionTitle(id: ValidationDimensionId): string {
  return EVALUATION_SUPPORT.find((dimension) => dimension.id === id)?.title ?? id
}

export interface PlaygroundFormValues {
  readonly rulebookId: string
  readonly rulebookVersion: string
  readonly attestationType: string
  readonly format: '' | CredentialFormatHint
  readonly credential: string
}

export const EMPTY_PLAYGROUND_FORM: PlaygroundFormValues = {
  rulebookId: '',
  rulebookVersion: '',
  attestationType: '',
  format: '',
  credential: '',
}

export type PlaygroundFormField = 'rulebook' | 'version' | 'attestation' | 'credential'

export type PlaygroundFormErrors = Readonly<Partial<Record<PlaygroundFormField, string>>>

/**
 * Client-side checks that mirror the API's required fields and credential
 * bound. A failure here means no request is sent; the API still validates the
 * same shape on its side.
 */
export function validatePlaygroundForm(values: PlaygroundFormValues): PlaygroundFormErrors {
  const errors: Partial<Record<PlaygroundFormField, string>> = {}
  if (values.rulebookId === '') {
    errors.rulebook = 'Select a rulebook.'
  }
  if (values.rulebookVersion === '') {
    errors.version = 'Select a rulebook version.'
  }
  if (values.attestationType === '') {
    errors.attestation = 'Select an attestation type.'
  }
  const credential = values.credential.trim()
  if (credential === '') {
    errors.credential = 'Paste or upload a credential.'
  } else if (credential.length > MAX_CREDENTIAL_LENGTH) {
    errors.credential = 'The credential must be at most 512 KiB of text.'
  }
  return errors
}

export function hasFormErrors(errors: PlaygroundFormErrors): boolean {
  return Object.keys(errors).length > 0
}

/**
 * Builds the typed API request. Leading and trailing whitespace (a common
 * artefact of a pasted or uploaded file) is removed; the rest of the artifact
 * text is sent unchanged so a format parser sees the exact value.
 */
export function buildValidationRequest(values: PlaygroundFormValues): ValidateCredentialRequest {
  const credential = values.credential.trim()
  return {
    rulebookId: values.rulebookId,
    rulebookVersion: values.rulebookVersion,
    attestationType: values.attestationType,
    credential: values.format === '' ? credential : { format: values.format, value: credential },
  }
}

export interface ValidationSummary {
  readonly total: number
  readonly applicable: number
  readonly executed: number
  readonly notExecuted: number
  readonly notApplicable: number
  readonly failed: number
  readonly inconclusive: number
}

/** Counts of what actually ran, for the explicit untested-dimensions notice. */
export function validationSummary(result: CredentialValidationResult): ValidationSummary {
  const dimensions = result.dimensions
  return {
    total: dimensions.length,
    applicable: dimensions.filter((dimension) => dimension.applicable).length,
    executed: dimensions.filter((dimension) => dimension.executed).length,
    notExecuted: dimensions.filter((dimension) => dimension.applicable && !dimension.executed)
      .length,
    notApplicable: dimensions.filter((dimension) => !dimension.applicable).length,
    failed: dimensions.filter((dimension) => dimension.status === 'FAIL').length,
    inconclusive: dimensions.filter((dimension) => dimension.status === 'INCONCLUSIVE').length,
  }
}

const dateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/** Formats the server's `validatedAt` timestamp; a malformed value is shown raw. */
export function formatValidatedAt(isoTimestamp: string): string {
  const milliseconds = Date.parse(isoTimestamp)
  if (Number.isNaN(milliseconds)) {
    return isoTimestamp
  }
  return dateTimeFormatter.format(new Date(milliseconds))
}

/**
 * Export filename derived from the run identity. The identifier is treated as
 * untrusted text, so only filename-safe characters survive.
 */
export function validationResultFilename(result: CredentialValidationResult): string {
  const safeId = result.validationId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 96)
  return `attestbook-validation-${safeId === '' ? 'result' : safeId}.json`
}

/** The exported JSON document: the typed result only, never the credential. */
export function validationResultDocument(result: CredentialValidationResult): string {
  return `${JSON.stringify(result, null, 2)}\n`
}
