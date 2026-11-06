// Draft working-copy replacement tests (issue #40).
//
// The editor replaces the whole draft document in one authorized transaction.
// These tests cover persistence and normalization, provider ownership, the
// draft-only rule, the "previous working copy survives an invalid write"
// guarantee and the requirement that published version artifacts never change.

import { afterEach, describe, expect, test } from 'bun:test'

import { provisionProvider } from './bootstrap'
import { isRegistryError, RegistryError, type RegistryErrorCode } from './errors'
import type { Registry } from './registry'
import { createRegistryFixture, type RegistryFixture } from './test-support'
import type { DraftAttestationInput, Rulebook } from './types'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function setup(): RegistryFixture {
  fixture = createRegistryFixture()
  return fixture
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

function provision(suffix: string) {
  if (fixture === undefined) {
    throw new Error('test fixture is not initialized')
  }
  return provisionProvider(fixture.database, {
    name: `Provider ${suffix}`,
    publicationAuthority: `account-${suffix}`,
  })
}

function seedDraft(registry: Registry, token: string): Rulebook {
  return registry.createRulebook(token, {
    name: 'Original draft',
    description: 'Original description',
    sourceUrl: 'https://issuer.example.org/rulebooks/original',
    applicableSpec: 'ts11@1.0.1',
    provenance: { importedFrom: 'fixture' },
    attestations: [
      {
        name: 'Original Attestation',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt'],
      },
    ],
  })
}

function replacementAttestations(): readonly DraftAttestationInput[] {
  return [
    {
      name: 'Person Identification Data',
      attestationLoS: 'iso_18045_high',
      bindingType: 'cryptographic',
      supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
      schemaReferences: [
        {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://issuer.example.org/schemas/pid',
          integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
        },
      ],
    },
    {
      name: 'Proof of Age',
      attestationLoS: 'iso_18045_moderate',
      bindingType: 'claim',
      supportedFormats: ['dc+sd-jwt'],
    },
  ]
}

const REPLACEMENT = {
  name: 'Edited draft',
  description: 'Edited description',
  sourceUrl: 'https://issuer.example.org/rulebooks/edited',
  applicableSpec: 'ts11@1.0.1',
  attestations: replacementAttestations(),
  schemaReferences: [
    {
      formatIdentifier: 'vc+sd-jwt',
      uri: 'https://issuer.example.org/schemas/rulebook',
    },
  ],
} as const

describe('draft working-copy replacement', () => {
  test('persists metadata, attestation types and schema references', () => {
    const { registry } = setup()
    const provider = provision('one')
    const rulebook = seedDraft(registry, provider.token.secret)

    const content = registry.replaceDraftContent(provider.token.secret, rulebook.id, REPLACEMENT)

    expect(content.rulebook.name).toBe('Edited draft')
    expect(content.rulebook.description).toBe('Edited description')
    expect(content.rulebook.sourceUrl).toBe('https://issuer.example.org/rulebooks/edited')
    expect(content.rulebook.publicationStatus).toBe('draft')
    expect(content.rulebook.providerId).toBe(provider.provider.id)
    expect(content.attestations.map((attestation) => attestation.name)).toEqual([
      'Person Identification Data',
      'Proof of Age',
    ])
    expect(content.attestations[0]?.supportedFormats).toEqual(['dc+sd-jwt', 'mso_mdoc'])
    expect(content.schemaReferences).toHaveLength(2)
    expect(
      content.schemaReferences.filter((reference) => reference.attestationId !== null),
    ).toHaveLength(1)
    expect(
      content.schemaReferences.find((reference) => reference.attestationId === null),
    ).toMatchObject({
      formatIdentifier: 'vc+sd-jwt',
      uri: 'https://issuer.example.org/schemas/rulebook',
    })

    const reread = registry.getDraftContent(rulebook.id)
    expect(reread.rulebook).toEqual(content.rulebook)
    expect(reread.attestations).toEqual(content.attestations)
    expect(reread.schemaReferences).toEqual(content.schemaReferences)
    expect(registry.listAttestations(rulebook.id)).toHaveLength(2)
  })

  test('normalizes omitted description and source URL for a full replacement', () => {
    const { registry } = setup()
    const provider = provision('one')
    const rulebook = seedDraft(registry, provider.token.secret)

    const content = registry.replaceDraftContent(provider.token.secret, rulebook.id, {
      name: 'Minimal draft',
      applicableSpec: 'ts11@1.0.1',
    })

    expect(content.rulebook.description).toBe('')
    expect(content.rulebook.sourceUrl).toBeNull()
    expect(content.attestations).toEqual([])
    expect(content.schemaReferences).toEqual([])
  })

  test('requires a valid bearer token and provider ownership', () => {
    const { registry } = setup()
    const owner = provision('owner')
    const other = provision('other')
    const rulebook = seedDraft(registry, owner.token.secret)

    expectRegistryError(
      () => registry.replaceDraftContent('att_unknown', rulebook.id, REPLACEMENT),
      'unauthorized',
    )
    expectRegistryError(
      () => registry.replaceDraftContent(other.token.secret, rulebook.id, REPLACEMENT),
      'forbidden',
    )
    expectRegistryError(
      () => registry.replaceDraftContent(owner.token.secret, 'missing-rulebook', REPLACEMENT),
      'not_found',
    )
    expect(registry.getDraftContent(rulebook.id).rulebook.name).toBe('Original draft')
  })

  test('refuses published and historical rulebooks without changing them', () => {
    const { registry } = setup()
    const provider = provision('one')
    const rulebook = seedDraft(registry, provider.token.secret)
    registry.createRulebookVersion(provider.token.secret, rulebook.id, { version: '1.0' })
    registry.publishRulebookVersion(provider.token.secret, rulebook.id, '1.0')

    expectRegistryError(
      () => registry.replaceDraftContent(provider.token.secret, rulebook.id, REPLACEMENT),
      'immutable',
    )
    expect(registry.getRulebook(rulebook.id)?.publicationStatus).toBe('published')
    expect(registry.getDraftContent(rulebook.id).rulebook.name).toBe('Original draft')

    registry.createRulebookVersion(provider.token.secret, rulebook.id, { version: '1.1' })
    expect(registry.getRulebook(rulebook.id)?.publicationStatus).toBe('draft')
    const replaced = registry.replaceDraftContent(provider.token.secret, rulebook.id, REPLACEMENT)
    expect(replaced.rulebook.name).toBe('Edited draft')
    expect(registry.getRulebookVersion(rulebook.id, '1.0')?.status).toBe('published')
  })

  test('never mutates a published version artifact or digest', () => {
    const { registry } = setup()
    const provider = provision('one')
    const rulebook = seedDraft(registry, provider.token.secret)
    const created = registry.createRulebookVersion(provider.token.secret, rulebook.id, {
      version: '1.0',
    })
    const published = registry.publishRulebookVersion(provider.token.secret, rulebook.id, '1.0')
    expect(published.contentDigest).toBe(created.contentDigest)
    const before = registry.getRulebookVersionContent(rulebook.id, '1.0')
    if (before === null) {
      throw new Error('expected the published version content')
    }
    const beforeBytes = Buffer.from(before.bytes).toString('utf8')

    registry.createRulebookVersion(provider.token.secret, rulebook.id, { version: '2.0' })
    registry.replaceDraftContent(provider.token.secret, rulebook.id, REPLACEMENT)

    const after = registry.getRulebookVersionContent(rulebook.id, '1.0')
    expect(after?.version).toEqual(published)
    expect(after?.version.contentDigest).toBe(published.contentDigest)
    expect(Buffer.from(after?.bytes ?? new Uint8Array()).toString('utf8')).toBe(beforeBytes)
    expect(registry.getRulebookVersion(rulebook.id, '2.0')?.status).toBe('draft')
    expect(registry.getRulebook(rulebook.id)?.publicationStatus).toBe('draft')
  })

  test('preserves unchanged internal metadata and row identity across a save', () => {
    const { registry } = setup()
    const provider = provision('one')
    const rulebook = registry.createRulebook(provider.token.secret, {
      name: 'Imported draft',
      applicableSpec: 'ts11@1.0.1',
      attestations: [
        {
          name: 'Imported attestation',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt'],
          metadata: { profile: 'ts11@1.0.1', conformance: 'conformant_subset' },
          schemaReferences: [
            {
              formatIdentifier: 'dc+sd-jwt',
              uri: 'https://issuer.example.org/schemas/pid',
              metadata: { meta: { vct: 'eu.example.pid' }, unknownMembers: { u: 2 } },
            },
          ],
        },
        {
          name: 'Unchanged attestation',
          attestationLoS: 'iso_18045_moderate',
          bindingType: 'key',
          supportedFormats: ['mso_mdoc'],
          metadata: { profile: 'ts11@1.0.1', conformance: 'partial' },
          schemaReferences: [
            {
              formatIdentifier: 'mso_mdoc',
              uri: 'https://issuer.example.org/schemas/mdl',
              metadata: { meta: { doctype_value: 'eu.example.mdl' } },
            },
          ],
        },
      ],
      schemaReferences: [
        {
          formatIdentifier: 'vc+sd-jwt',
          uri: 'https://issuer.example.org/schemas/rulebook',
          metadata: { meta: { r: 1 } },
        },
      ],
    })
    const before = registry.getDraftContent(rulebook.id)
    const attestation = before.attestations[0]
    const rulebookReference = before.schemaReferences.find(
      (reference) => reference.attestationId === null,
    )
    if (attestation === undefined || rulebookReference === undefined) {
      throw new Error('expected the seeded draft content')
    }

    const replacement = {
      name: before.rulebook.name,
      description: before.rulebook.description,
      sourceUrl: before.rulebook.sourceUrl,
      applicableSpec: before.rulebook.applicableSpec,
      attestations: before.attestations.map((candidate) => ({
        name: candidate.name,
        attestationLoS: candidate.attestationLoS,
        bindingType: candidate.bindingType,
        supportedFormats: [...candidate.supportedFormats],
        schemaReferences: before.schemaReferences
          .filter((reference) => reference.attestationId === candidate.id)
          .map((reference) => ({
            formatIdentifier: reference.formatIdentifier,
            uri: reference.uri,
            ...(reference.integrity === null ? {} : { integrity: reference.integrity }),
          })),
      })),
      schemaReferences: before.schemaReferences
        .filter((reference) => reference.attestationId === null)
        .map((reference) => ({
          formatIdentifier: reference.formatIdentifier,
          uri: reference.uri,
          ...(reference.integrity === null ? {} : { integrity: reference.integrity }),
        })),
    }

    const saved = registry.replaceDraftContent(provider.token.secret, rulebook.id, replacement)

    expect(saved.attestations[0]).toMatchObject({
      id: attestation.id,
      metadata: { profile: 'ts11@1.0.1', conformance: 'conformant_subset' },
    })
    expect(
      saved.schemaReferences.find((reference) => reference.attestationId === null),
    ).toMatchObject({
      id: rulebookReference.id,
      metadata: { meta: { r: 1 } },
    })
    expect(
      saved.schemaReferences.find((reference) => reference.attestationId === attestation.id),
    ).toMatchObject({
      metadata: { meta: { vct: 'eu.example.pid' }, unknownMembers: { u: 2 } },
    })

    // Changing an entry clears only that entry's internal metadata.
    const changed = registry.replaceDraftContent(provider.token.secret, rulebook.id, {
      ...replacement,
      attestations: [
        {
          ...replacement.attestations[0]!,
          name: 'Renamed attestation',
        },
        replacement.attestations[1]!,
      ],
      schemaReferences: [
        {
          ...replacement.schemaReferences[0]!,
          uri: 'https://issuer.example.org/schemas/rulebook-v2',
        },
      ],
    })
    expect(changed.attestations[0]).toMatchObject({
      name: 'Renamed attestation',
      metadata: {},
    })
    expect(changed.attestations[0]?.id).not.toBe(attestation.id)
    expect(
      changed.schemaReferences.find((reference) => reference.attestationId === null),
    ).toMatchObject({ metadata: {} })
    const unchangedAttestation = changed.attestations.find(
      (attestation) => attestation.name === 'Unchanged attestation',
    )
    expect(unchangedAttestation).toMatchObject({
      metadata: { profile: 'ts11@1.0.1', conformance: 'partial' },
    })
    expect(
      changed.schemaReferences.find(
        (reference) => reference.attestationId === unchangedAttestation?.id,
      ),
    ).toMatchObject({
      metadata: { meta: { doctype_value: 'eu.example.mdl' } },
    })
  })

  test('leaves the previous working copy intact when validation fails', () => {
    const { registry } = setup()
    const provider = provision('one')
    const rulebook = seedDraft(registry, provider.token.secret)
    const before = registry.getDraftContent(rulebook.id)

    expectRegistryError(
      () =>
        registry.replaceDraftContent(provider.token.secret, rulebook.id, {
          ...REPLACEMENT,
          name: '   ',
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.replaceDraftContent(provider.token.secret, rulebook.id, {
          ...REPLACEMENT,
          attestations: [
            { name: 'Repeated', attestationLoS: 'iso_18045_high', bindingType: 'key' },
            { name: 'Repeated', attestationLoS: 'iso_18045_high', bindingType: 'key' },
          ],
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.replaceDraftContent(provider.token.secret, rulebook.id, {
          ...REPLACEMENT,
          schemaReferences: [{ formatIdentifier: 'dc+sd-jwt', uri: 'not-a-url' }],
        }),
      'invalid_input',
    )

    const after = registry.getDraftContent(rulebook.id)
    expect(after.rulebook).toEqual(before.rulebook)
    expect(after.attestations).toEqual(before.attestations)
    expect(after.schemaReferences).toEqual(before.schemaReferences)
  })

  test('writes audit rows for replaced content', () => {
    const { registry, database } = setup()
    const provider = provision('one')
    const rulebook = seedDraft(registry, provider.token.secret)
    registry.replaceDraftContent(provider.token.secret, rulebook.id, REPLACEMENT)

    const actions = database
      .query<{ action: string }, [string]>(
        'SELECT action FROM audit_log WHERE entity_id IN (SELECT id FROM attestations WHERE rulebook_id = ?1) ORDER BY id',
      )
      .all(rulebook.id)
      .map((row) => row.action)
    expect(actions).toEqual(['attestation.create', 'attestation.create'])

    const rulebookUpdates = database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'rulebook.update' AND entity_id = ?1",
      )
      .get(rulebook.id)
    expect(rulebookUpdates?.count).toBe(1)

    const replacements = database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'attestation.delete' AND detail_json LIKE '%draft.replace%'",
      )
      .get()
    expect(replacements?.count).toBe(1)
  })
})
