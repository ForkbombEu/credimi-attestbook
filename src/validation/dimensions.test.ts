// FR-010 dimension catalogue and status-semantics invariants (issue #33).
//
// These tests are table-driven: they prove that a dimension outcome cannot be
// reported unless status, applicability and execution agree, and that an
// unexecuted dimension can never be PASS.

import { describe, expect, test } from 'bun:test'

import {
  assertDimensionCatalogue,
  assertDimensionConsistency,
  createDimension,
  DIMENSION_DEFINITIONS,
  DimensionConsistencyError,
  limitationsFromDimensions,
  type DimensionInput,
} from './dimensions'
import {
  VALIDATION_DIMENSIONS,
  type ValidationDimensionId,
  type ValidationFinding,
  type ValidationStatus,
} from './types'

const EVIDENCE = {
  scope: 'what the dimension evaluates',
  reason: 'why it did or did not execute',
  details: { executed: false },
} as const

function finding(
  severity: ValidationFinding['severity'],
  dimension: ValidationDimensionId = 'credential_parsing',
): ValidationFinding {
  return {
    code: `${severity}_finding`,
    message: `a ${severity} finding`,
    severity,
    dimension,
  }
}

function input(overrides: Partial<DimensionInput> = {}): DimensionInput {
  return {
    id: 'credential_parsing',
    status: 'PASS',
    applicable: true,
    executed: true,
    findings: [],
    evidence: EVIDENCE,
    ...overrides,
  }
}

describe('FR-010 dimension catalogue', () => {
  test('defines exactly the eight normative dimensions in order', () => {
    expect(DIMENSION_DEFINITIONS.map((definition) => definition.id)).toEqual([
      ...VALIDATION_DIMENSIONS,
    ])
    expect(DIMENSION_DEFINITIONS).toHaveLength(8)
    DIMENSION_DEFINITIONS.forEach((definition, index) => {
      expect(definition.position).toBe(index + 1)
      expect(definition.title.length).toBeGreaterThan(0)
      expect(definition.scope.length).toBeGreaterThan(0)
    })
    expect(() => assertDimensionCatalogue()).not.toThrow()
  })

  test('reports the external and internally executed dimensions distinctly', () => {
    const byId = new Map(DIMENSION_DEFINITIONS.map((definition) => [definition.id, definition]))
    expect(byId.get('credential_parsing')?.owner).toBe('attestbook')
    expect(byId.get('schema_validation')?.implemented).toBe(true)
    expect(byId.get('cryptographic_verification')?.owner).toBe('external')
    expect(byId.get('cryptographic_verification')?.implemented).toBe(false)
    expect(byId.get('cryptographic_verification')?.applicability).toBe('required')
    expect(byId.get('issuer_trust')?.implemented).toBe(false)
    expect(byId.get('issuer_trust')?.applicability).toBe('required')
    expect(byId.get('protocol_conformance')?.applicability).toBe('not_applicable')
    expect(byId.get('interoperability')?.applicability).toBe('not_applicable')
  })

  test('fails closed on an out-of-order or incomplete catalogue', () => {
    expect(() => assertDimensionCatalogue([...DIMENSION_DEFINITIONS].reverse())).toThrow(
      /out of order/,
    )
    expect(() => assertDimensionCatalogue(DIMENSION_DEFINITIONS.slice(0, 7))).toThrow(
      /definitions for/,
    )
  })
})

describe('dimension status semantics', () => {
  const valid: readonly { status: ValidationStatus; overrides: Partial<DimensionInput> }[] = [
    { status: 'PASS', overrides: { findings: [] } },
    { status: 'PASS', overrides: { findings: [finding('info')] } },
    { status: 'FAIL', overrides: { findings: [finding('error')] } },
    {
      status: 'NOT_TESTED',
      overrides: { applicable: true, executed: false, findings: [finding('warning')] },
    },
    { status: 'INCONCLUSIVE', overrides: { findings: [finding('warning')] } },
    {
      status: 'NOT_APPLICABLE',
      overrides: { applicable: false, executed: false, findings: [finding('info')] },
    },
  ]

  for (const { status, overrides } of valid) {
    test(`accepts a consistent ${status} outcome`, () => {
      const dimension = createDimension(input({ status, ...overrides }))
      expect(dimension.status).toBe(status)
      expect(dimension.applicable).toBe(overrides.applicable ?? true)
      expect(dimension.executed).toBe(overrides.executed ?? true)
    })
  }

  const invalid: readonly { name: string; overrides: Partial<DimensionInput> }[] = [
    {
      name: 'PASS on an unexecuted dimension',
      overrides: { status: 'PASS', executed: false },
    },
    {
      name: 'PASS on a non-applicable dimension',
      overrides: { status: 'PASS', applicable: false },
    },
    {
      name: 'PASS with a warning finding',
      overrides: { status: 'PASS', findings: [finding('warning')] },
    },
    {
      name: 'FAIL on an unexecuted dimension',
      overrides: { status: 'FAIL', executed: false, findings: [finding('error')] },
    },
    {
      name: 'FAIL without an error finding',
      overrides: { status: 'FAIL', findings: [] },
    },
    {
      name: 'NOT_TESTED that claims to have executed',
      overrides: { status: 'NOT_TESTED', executed: true, findings: [finding('warning')] },
    },
    {
      name: 'NOT_TESTED that is not applicable',
      overrides: {
        status: 'NOT_TESTED',
        applicable: false,
        executed: false,
        findings: [finding('warning')],
      },
    },
    {
      name: 'NOT_TESTED without a finding',
      overrides: { status: 'NOT_TESTED', executed: false, findings: [] },
    },
    {
      name: 'INCONCLUSIVE that did not execute',
      overrides: { status: 'INCONCLUSIVE', executed: false, findings: [finding('warning')] },
    },
    {
      name: 'INCONCLUSIVE with an error finding',
      overrides: { status: 'INCONCLUSIVE', findings: [finding('error')] },
    },
    {
      name: 'NOT_APPLICABLE that is applicable',
      overrides: {
        status: 'NOT_APPLICABLE',
        applicable: true,
        executed: false,
        findings: [finding('info')],
      },
    },
    {
      name: 'NOT_APPLICABLE that executed',
      overrides: {
        status: 'NOT_APPLICABLE',
        applicable: false,
        executed: true,
        findings: [finding('info')],
      },
    },
    {
      name: 'NOT_APPLICABLE with a warning finding',
      overrides: {
        status: 'NOT_APPLICABLE',
        applicable: false,
        executed: false,
        findings: [finding('warning')],
      },
    },
  ]

  for (const { name, overrides } of invalid) {
    test(`rejects ${name}`, () => {
      expect(() => createDimension(input(overrides))).toThrow(DimensionConsistencyError)
      expect(() => createDimension(input(overrides))).toThrow(
        /inconsistent dimension outcome for "credential_parsing"/,
      )
    })
  }

  test('rejects a finding attributed to a different dimension', () => {
    expect(() =>
      createDimension(
        input({
          findings: [
            {
              code: 'x',
              message: 'm',
              severity: 'info',
              dimension: 'issuer_trust',
            },
          ],
        }),
      ),
    ).toThrow(/belongs to a different dimension/)
  })

  test('rejects empty evidence', () => {
    expect(() =>
      createDimension(input({ evidence: { scope: '', reason: '', details: {} } })),
    ).toThrow(/evidence scope and reason/)
  })

  test('assertDimensionConsistency is exported for callers that build dimensions elsewhere', () => {
    expect(() =>
      assertDimensionConsistency({
        id: 'credential_parsing',
        status: 'PASS',
        applicable: true,
        executed: false,
        findings: [],
        evidence: EVIDENCE,
      }),
    ).toThrow(DimensionConsistencyError)
  })
})

describe('limitationsFromDimensions', () => {
  test('names every non-conclusive dimension and ignores PASS/FAIL', () => {
    const dimensions = [
      createDimension(input({ id: 'credential_parsing', status: 'PASS' })),
      createDimension(
        input({
          id: 'format_recognition',
          status: 'FAIL',
          findings: [finding('error', 'format_recognition')],
        }),
      ),
      createDimension(
        input({
          id: 'cryptographic_verification',
          status: 'NOT_TESTED',
          applicable: true,
          executed: false,
          findings: [
            {
              code: 'signature_not_verified',
              message: 'signature not verified',
              severity: 'warning',
              dimension: 'cryptographic_verification',
            },
          ],
        }),
      ),
      createDimension(
        input({
          id: 'protocol_conformance',
          status: 'NOT_APPLICABLE',
          applicable: false,
          executed: false,
          findings: [
            {
              code: 'protocol_not_applicable',
              message: 'no protocol interaction',
              severity: 'info',
              dimension: 'protocol_conformance',
            },
          ],
        }),
      ),
    ]

    expect(limitationsFromDimensions(dimensions)).toEqual([
      {
        code: 'signature_not_verified',
        dimension: 'cryptographic_verification',
        status: 'NOT_TESTED',
        message: 'signature not verified',
      },
      {
        code: 'protocol_not_applicable',
        dimension: 'protocol_conformance',
        status: 'NOT_APPLICABLE',
        message: 'no protocol interaction',
      },
    ])
  })
})
