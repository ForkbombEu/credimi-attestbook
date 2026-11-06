// Deterministic version comparison tests (issue #41).
//
// The same two snapshots must always produce the same changes in the same
// order, and the comparison must ignore snapshot identity fields so two labels
// with equal authored content compare as identical.

import { describe, expect, test } from 'bun:test'

import type { RulebookVersionDocument } from '../registry/versioning'

import { compareVersionDocuments } from './version-diff'

function document(overrides: Partial<RulebookVersionDocument> = {}): RulebookVersionDocument {
  return {
    format: 'attestbook.rulebook-version@1',
    rulebookId: 'rulebook-1',
    version: '1.0',
    specVersion: 'ts11@1.0.1',
    name: 'PID Rulebook',
    description: 'Person identification data.',
    sourceUrl: 'https://issuer.example.org/rulebooks/pid',
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
            integrity: null,
          },
        ],
      },
    ],
    schemaReferences: [],
    ...overrides,
  }
}

describe('deterministic version comparison', () => {
  test('identical authored content compares equal even across different labels', () => {
    const diff = compareVersionDocuments(document({ version: '1.0' }), document({ version: '1.1' }))

    expect(diff.identical).toBe(true)
    expect(diff.changes).toEqual([])
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 0 })
  })

  test('reports a changed scalar with its path and both values', () => {
    const diff = compareVersionDocuments(
      document(),
      document({ description: 'Updated description.', version: '1.1' }),
    )

    expect(diff.identical).toBe(false)
    expect(diff.changes).toEqual([
      {
        path: '/description',
        kind: 'changed',
        before: 'Person identification data.',
        after: 'Updated description.',
      },
    ])
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 1 })
  })

  test('keeps paths sorted and reports additions, removals and changes', () => {
    const from = document({
      name: 'Before',
      attestations: [
        {
          name: 'Person Identification Data',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt'],
          schemaReferences: [],
        },
      ],
    })
    const to = document({
      name: 'After',
      specVersion: 'ts11@1.0.1',
      attestations: [
        {
          name: 'Person Identification Data',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
          schemaReferences: [],
        },
        {
          name: 'Payment Account',
          attestationLoS: 'iso_18045_moderate',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt'],
          schemaReferences: [],
        },
      ],
    })

    const diff = compareVersionDocuments(from, to)
    const paths = diff.changes.map((change) => change.path)

    expect(paths).toEqual([...paths].sort())
    expect(paths).toContain('/name')
    expect(paths).toContain('/attestations/0/supportedFormats/1')
    expect(paths).toContain('/attestations/1')
    expect(diff.summary).toEqual({ added: 2, removed: 0, changed: 1 })
  })

  test('reports a removed array element as removed', () => {
    const diff = compareVersionDocuments(
      document(),
      document({
        attestations: [
          {
            name: 'Person Identification Data',
            attestationLoS: 'iso_18045_high',
            bindingType: 'key',
            supportedFormats: ['dc+sd-jwt'],
            schemaReferences: [],
          },
        ],
      }),
    )

    expect(diff.changes).toEqual([
      {
        path: '/attestations/0/schemaReferences/0',
        kind: 'removed',
        before: {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://issuer.example.org/schemas/pid',
          integrity: null,
        },
      },
    ])
  })

  test('is stable when the comparison runs twice', () => {
    const from = document()
    const to = document({ name: 'Changed', description: 'Changed too.', version: '1.1' })

    expect(compareVersionDocuments(from, to)).toEqual(compareVersionDocuments(from, to))
  })
})
