import { afterEach, describe, expect, test } from 'bun:test'

import { provisionProvider } from './bootstrap'
import { isRegistryError, RegistryError, type RegistryErrorCode } from './errors'
import { createRegistryFixture, type RegistryFixture } from './test-support'
import { MAX_SCHEMA_REFERENCES_PER_ATTESTATION } from './validation'
import type { CreateRulebookInput } from './types'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function setup() {
  fixture = createRegistryFixture()
  const { actor, provider, token } = provisionProvider(fixture.database, {
    name: 'Reference Provider',
    publicationAuthority: 'account-references',
  })
  return { actor, fixture, provider, token }
}

function expectRegistryError(action: () => unknown, code: RegistryErrorCode): void {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(RegistryError)
  expect(isRegistryError(caught) ? caught.code : undefined).toBe(code)
}

function input(overrides: Partial<CreateRulebookInput> = {}): CreateRulebookInput {
  return {
    name: 'Gym Membership',
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: 'Gym Membership Card',
        attestationLoS: 'iso_18045_basic',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt'],
        schemaReferences: [
          {
            formatIdentifier: 'dc+sd-jwt',
            uri: 'https://example.org/schemas/gym.json',
            integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
          },
        ],
      },
    ],
    ...overrides,
  }
}

describe('createRulebook with attestation schema references', () => {
  test('creates the attestation and its references in one call', () => {
    const { actor, fixture } = setup()

    const rulebook = fixture.registry.createRulebook(actor, input())
    const attestations = fixture.registry.listAttestations(rulebook.id)
    const references = fixture.registry.listSchemaReferences(rulebook.id)

    expect(attestations).toHaveLength(1)
    expect(references).toHaveLength(1)
    expect(references[0]).toMatchObject({
      rulebookId: rulebook.id,
      attestationId: attestations[0]?.id,
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://example.org/schemas/gym.json',
      integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    })

    const auditActions = fixture.database
      .query<{ action: string }, []>('SELECT action FROM audit_log ORDER BY id')
      .all()
      .map((row) => row.action)
    expect(auditActions).toContain('schema_ref.create')
  })

  test('creates several rulebooks in one transaction', () => {
    const { actor, fixture } = setup()

    const rulebooks = fixture.registry.createRulebooks(actor, [
      input({ name: 'First Rulebook' }),
      input({ name: 'Second Rulebook' }),
    ])

    expect(rulebooks).toHaveLength(2)
    expect(fixture.registry.listRulebooks()).toHaveLength(2)
    expect(rulebooks.map((rulebook) => rulebook.name)).toEqual([
      'First Rulebook',
      'Second Rulebook',
    ])
  })

  test('refuses the whole batch when a later entry is invalid', () => {
    const { actor, fixture } = setup()

    expectRegistryError(
      () =>
        fixture.registry.createRulebooks(actor, [
          input({ name: 'First Rulebook' }),
          input({
            name: 'Second Rulebook',
            attestations: [
              {
                name: 'Gym Membership Card',
                attestationLoS: 'iso_18045_basic',
                bindingType: 'key',
                schemaReferences: [
                  { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.org/a.json' },
                  { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.org/b.json' },
                ],
              },
            ],
          }),
        ]),
      'invalid_input',
    )

    expect(fixture.registry.listRulebooks()).toHaveLength(0)
  })

  test('refuses duplicate format identifiers and leaves no rulebook', () => {
    const { actor, fixture } = setup()

    expectRegistryError(
      () =>
        fixture.registry.createRulebook(
          actor,
          input({
            attestations: [
              {
                name: 'Gym Membership Card',
                attestationLoS: 'iso_18045_basic',
                bindingType: 'key',
                schemaReferences: [
                  { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.org/a.json' },
                  { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.org/b.json' },
                ],
              },
            ],
          }),
        ),
      'invalid_input',
    )

    expect(fixture.registry.listRulebooks()).toHaveLength(0)
  })

  test('enforces the per-attestation reference limit', () => {
    const { actor, fixture } = setup()
    const references = Array.from(
      { length: MAX_SCHEMA_REFERENCES_PER_ATTESTATION + 1 },
      (_, index) => ({
        formatIdentifier: `format-${index}`,
        uri: `https://example.org/schemas/${index}.json`,
      }),
    )

    expectRegistryError(
      () =>
        fixture.registry.createRulebook(
          actor,
          input({
            attestations: [
              {
                name: 'Gym Membership Card',
                attestationLoS: 'iso_18045_basic',
                bindingType: 'key',
                schemaReferences: references,
              },
            ],
          }),
        ),
      'invalid_input',
    )
    expect(fixture.registry.listRulebooks()).toHaveLength(0)
  })

  test('rejects an invalid reference before writing the rulebook', () => {
    const { actor, fixture } = setup()

    expectRegistryError(
      () =>
        fixture.registry.createRulebook(
          actor,
          input({
            attestations: [
              {
                name: 'Gym Membership Card',
                attestationLoS: 'iso_18045_basic',
                bindingType: 'key',
                schemaReferences: [{ formatIdentifier: 'dc+sd-jwt', uri: 'not-a-url' }],
              },
            ],
          }),
        ),
      'invalid_input',
    )
    expect(fixture.registry.listRulebooks()).toHaveLength(0)
  })
})
