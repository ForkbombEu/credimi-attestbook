// Live draft validation tests (issue #40).
//
// The editor needs immediate, honest feedback: structural findings decide
// whether a save can succeed, the real TS11/OWF adapter reports standards
// errors with the draft path, and incomplete WIP values stay warnings.

import { describe, expect, test } from 'bun:test'

import { validateDraftContent } from './draft'

function validDraft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'PID Rulebook',
    description: 'Person identification data.',
    sourceUrl: 'https://issuer.example.org/rulebooks/pid',
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: 'Person Identification Data',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt'],
        schemaReferences: [
          {
            formatIdentifier: 'dc+sd-jwt',
            uri: 'https://issuer.example.org/schemas/pid',
            integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
          },
        ],
      },
    ],
    schemaReferences: [],
    ...overrides,
  }
}

function paths(report: ReturnType<typeof validateDraftContent>): readonly (string | undefined)[] {
  return report.diagnostics.map((diagnostic) => diagnostic.path)
}

describe('live draft validation', () => {
  test('accepts a complete TS11 draft and reports the baseline and limits', () => {
    const report = validateDraftContent(validDraft())

    expect(report.valid).toBe(true)
    expect(report.saveable).toBe(true)
    expect(report.profile).toBe('ts11@1.0.1')
    expect(report.diagnostics).toEqual([])
    expect(report.limitations.length).toBeGreaterThan(0)
    expect(report.limitations.join(' ')).toContain('TS11 v1.0.1')
  })

  test('rejects a document that is not a JSON object', () => {
    for (const value of [null, 'text', 42, []]) {
      const report = validateDraftContent(value)
      expect(report.valid).toBe(false)
      expect(report.profile).toBeNull()
      expect(report.diagnostics[0]?.code).toBe('invalid_schema_meta')
    }
  })

  test('reports every structural metadata error with its draft path', () => {
    const report = validateDraftContent(
      validDraft({
        name: '   ',
        description: 42,
        sourceUrl: 'ftp://issuer.example.org/rulebooks/pid',
        applicableSpec: '',
      }),
    )

    expect(report.valid).toBe(false)
    expect(paths(report)).toEqual(['name', 'description', 'sourceUrl', 'applicableSpec'])
    for (const diagnostic of report.diagnostics) {
      expect(diagnostic.severity).toBe('error')
    }
  })

  test('reports invalid attestation and schema-reference values structurally', () => {
    const report = validateDraftContent(
      validDraft({
        attestations: [
          {
            name: 'PID',
            attestationLoS: 'iso_18045_high',
            bindingType: 'key',
            supportedFormats: ['dc+sd-jwt', 'dc+sd-jwt'],
            schemaReferences: [
              {
                formatIdentifier: 'dc+sd-jwt',
                uri: 'https://issuer.example.org/schemas/pid',
                integrity: 'plainstring',
              },
              { formatIdentifier: 'mso_mdoc', uri: 'not-a-url' },
            ],
          },
        ],
      }),
    )

    expect(report.valid).toBe(false)
    expect(paths(report)).toContain('attestations.0.supportedFormats.1')
    expect(paths(report)).toContain('attestations.0.schemaReferences.0.integrity')
    expect(paths(report)).toContain('attestations.0.schemaReferences.1.uri')
  })

  test('reports duplicate attestation names and formats', () => {
    const attestation = {
      name: 'PID',
      attestationLoS: 'iso_18045_high',
      bindingType: 'key',
      supportedFormats: ['dc+sd-jwt'],
      schemaReferences: [
        { formatIdentifier: 'dc+sd-jwt', uri: 'https://issuer.example.org/schemas/pid' },
      ],
    }
    const report = validateDraftContent(
      validDraft({
        attestations: [attestation, attestation],
        schemaReferences: [
          { formatIdentifier: 'vc+sd-jwt', uri: 'https://issuer.example.org/schemas/a' },
          { formatIdentifier: 'vc+sd-jwt', uri: 'https://issuer.example.org/schemas/b' },
        ],
      }),
    )

    expect(report.valid).toBe(false)
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'duplicate_attestation_name',
    )
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'duplicate_format_identifier',
    )
  })

  test('uses the real adapter to report TS11 baseline values and format mismatches', () => {
    const report = validateDraftContent(
      validDraft({
        attestations: [
          {
            name: 'PID',
            attestationLoS: 'iso_18045_ultra',
            bindingType: 'magic',
            supportedFormats: ['dc+sd-jwt'],
            schemaReferences: [
              { formatIdentifier: 'mso_mdoc', uri: 'https://issuer.example.org/schemas/pid' },
            ],
          },
        ],
      }),
    )

    expect(report.valid).toBe(false)
    const messages = report.diagnostics.map((diagnostic) => diagnostic.message)
    expect(messages.join(' ')).toContain('iso_18045_ultra')
    expect(messages.join(' ')).toContain('magic')
    expect(messages.join(' ')).toContain('not listed in supportedFormats')
    expect(paths(report)).toContain('attestations.0.attestationLoS')
    expect(paths(report)).toContain('attestations.0.bindingType')
    expect(paths(report)).toContain('attestations.0.schemaReferences.0.formatIdentifier')
    // D-5: values outside the baseline are preserved warnings, not errors.
    expect(
      report.diagnostics.find((diagnostic) => diagnostic.path === 'attestations.0.attestationLoS')
        ?.severity,
    ).toBe('warning')
    // A format listed in supportedFormats without a schema reference is a real error.
    expect(
      report.diagnostics.find((diagnostic) => diagnostic.path === 'attestations.0.supportedFormats')
        ?.severity,
    ).toBe('error')
  })

  test('keeps incomplete attestation types as save-able warnings', () => {
    const report = validateDraftContent(
      validDraft({
        attestations: [
          {
            name: 'Draft attestation',
            attestationLoS: 'iso_18045_high',
            bindingType: 'key',
          },
        ],
      }),
    )

    expect(report.valid).toBe(true)
    expect(report.profile).toBe('ts11@1.0.1')
    expect(report.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual([
      'warning',
      'warning',
    ])
    expect(paths(report)).toEqual([
      'attestations.0.supportedFormats',
      'attestations.0.schemaReferences',
    ])
  })

  test('does not validate an unsupported profile against the TS11 baseline', () => {
    const report = validateDraftContent(
      validDraft({
        applicableSpec: 'owf@0.5.4',
        attestations: [
          {
            name: 'OWF attestation',
            attestationLoS: 'not-a-ts11-value',
            bindingType: 'key',
            supportedFormats: ['dc+sd-jwt'],
            schemaReferences: [
              { formatIdentifier: 'dc+sd-jwt', uri: 'https://issuer.example.org/schemas/pid' },
            ],
          },
        ],
      }),
    )

    expect(report.valid).toBe(true)
    expect(report.profile).toBeNull()
    expect(report.diagnostics).toHaveLength(1)
    expect(report.diagnostics[0]?.code).toBe('unsupported_profile')
    expect(report.diagnostics[0]?.severity).toBe('warning')
    expect(report.limitations.join(' ')).toContain('owf@0.5.4')
  })

  test('accepts an empty draft without claiming standards validation', () => {
    const report = validateDraftContent({
      name: 'New rulebook',
      applicableSpec: 'ts11@1.0.1',
    })

    expect(report.valid).toBe(true)
    expect(report.saveable).toBe(true)
    expect(report.profile).toBe('ts11@1.0.1')
    expect(report.diagnostics).toEqual([])
  })

  test('is deterministic for the same document', () => {
    const document = validDraft({
      attestations: [
        {
          name: 'PID',
          attestationLoS: 'iso_18045_ultra',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt'],
          schemaReferences: [
            { formatIdentifier: 'dc+sd-jwt', uri: 'https://issuer.example.org/schemas/pid' },
          ],
        },
      ],
    })

    expect(validateDraftContent(document)).toEqual(validateDraftContent(document))
  })
})
