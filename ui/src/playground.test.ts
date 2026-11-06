import { describe, expect, test } from 'vitest'

import { TS11_FORMAT_VALUES } from '../../src/standards/profiles'
import { EVALUATION_SUPPORT } from './compatibility'
import {
  CREDENTIAL_FORMAT_OPTIONS,
  EMPTY_PLAYGROUND_FORM,
  MAX_CREDENTIAL_LENGTH,
  VALIDATION_STATUS_LABELS,
  buildValidationRequest,
  dimensionTitle,
  hasFormErrors,
  validatePlaygroundForm,
  validationResultDocument,
  validationResultFilename,
  validationSummary,
} from './playground'
import { makeValidationResult } from './test/fixtures'

describe('credential format hints', () => {
  test('cover exactly the pinned TS11 format vocabulary plus auto-detection', () => {
    expect(CREDENTIAL_FORMAT_OPTIONS[0]?.value).toBe('')
    expect(CREDENTIAL_FORMAT_OPTIONS.slice(1).map((option) => option.value)).toEqual(
      TS11_FORMAT_VALUES,
    )
  })
})

describe('form validation', () => {
  test('requires a rulebook, version, attestation type and credential', () => {
    const errors = validatePlaygroundForm(EMPTY_PLAYGROUND_FORM)
    expect(errors).toEqual({
      rulebook: 'Select a rulebook.',
      version: 'Select a rulebook version.',
      attestation: 'Select an attestation type.',
      credential: 'Paste or upload a credential.',
    })
    expect(hasFormErrors(errors)).toBe(true)
  })

  test('treats whitespace-only text as a missing credential', () => {
    const errors = validatePlaygroundForm({
      ...EMPTY_PLAYGROUND_FORM,
      rulebookId: 'rulebook-pid',
      rulebookVersion: '1.0',
      attestationType: 'Person Identification Data',
      credential: '   \n\t ',
    })
    expect(errors).toEqual({ credential: 'Paste or upload a credential.' })
  })

  test('rejects a credential above the 512 KiB API bound', () => {
    const errors = validatePlaygroundForm({
      ...EMPTY_PLAYGROUND_FORM,
      rulebookId: 'rulebook-pid',
      rulebookVersion: '1.0',
      attestationType: 'Person Identification Data',
      credential: 'a'.repeat(MAX_CREDENTIAL_LENGTH + 1),
    })
    expect(errors.credential).toBe('The credential must be at most 512 KiB of text.')
  })

  test('accepts a complete request', () => {
    const errors = validatePlaygroundForm({
      rulebookId: 'rulebook-pid',
      rulebookVersion: '1.0',
      attestationType: 'Person Identification Data',
      format: 'dc+sd-jwt',
      credential: 'header.payload.signature~disclosure',
    })
    expect(errors).toEqual({})
    expect(hasFormErrors(errors)).toBe(false)
  })
})

describe('request construction', () => {
  const values = {
    rulebookId: 'rulebook-pid',
    rulebookVersion: '1.0',
    attestationType: 'Person Identification Data',
    format: '' as const,
    credential: '  header.payload.signature~disclosure\n',
  }

  test('trims the artifact and sends a bare string when the format is auto-detected', () => {
    expect(buildValidationRequest(values)).toEqual({
      rulebookId: 'rulebook-pid',
      rulebookVersion: '1.0',
      attestationType: 'Person Identification Data',
      credential: 'header.payload.signature~disclosure',
    })
  })

  test('sends the explicit format hint with the trimmed artifact', () => {
    expect(buildValidationRequest({ ...values, format: 'mso_mdoc' })).toEqual({
      rulebookId: 'rulebook-pid',
      rulebookVersion: '1.0',
      attestationType: 'Person Identification Data',
      credential: { format: 'mso_mdoc', value: 'header.payload.signature~disclosure' },
    })
  })
})

describe('result display helpers', () => {
  test('counts executed, untested and not-applicable dimensions separately', () => {
    expect(validationSummary(makeValidationResult())).toEqual({
      total: 8,
      applicable: 6,
      executed: 3,
      notExecuted: 3,
      notApplicable: 2,
      failed: 0,
      inconclusive: 0,
    })
  })

  test('labels every status without presenting an untested dimension as a pass', () => {
    expect(VALIDATION_STATUS_LABELS).toEqual({
      PASS: 'Passed',
      FAIL: 'Failed',
      NOT_TESTED: 'Not tested',
      NOT_APPLICABLE: 'Not applicable',
      INCONCLUSIVE: 'Inconclusive',
    })
    expect(VALIDATION_STATUS_LABELS.NOT_TESTED).not.toBe(VALIDATION_STATUS_LABELS.PASS)
    expect(VALIDATION_STATUS_LABELS.NOT_APPLICABLE).not.toBe(VALIDATION_STATUS_LABELS.PASS)
  })

  test('resolves every FR-010 dimension title from the shared catalogue', () => {
    for (const display of EVALUATION_SUPPORT) {
      expect(dimensionTitle(display.id)).toBe(display.title)
    }
    expect(dimensionTitle('credential_parsing')).toBe('Credential parsing')
  })

  test('builds a filename-safe export name from the run identity', () => {
    const result = makeValidationResult({ validationId: '../../etc/passwd' })
    expect(validationResultFilename(result)).toBe('attestbook-validation-..-..-etc-passwd.json')
    expect(validationResultFilename(makeValidationResult({ validationId: '   ' }))).toBe(
      'attestbook-validation----.json',
    )
  })

  test('exports the typed result only, without a credential artifact field', () => {
    const result = makeValidationResult()
    const document = validationResultDocument(result)
    expect(document.endsWith('\n')).toBe(true)
    expect(JSON.parse(document)).toEqual(result)
    expect(document).not.toContain('header.payload.signature')
    expect(document).not.toContain('"credentialArtifact"')
  })
})
