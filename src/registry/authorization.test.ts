import { afterEach, describe, expect, test } from 'bun:test'

import { isRegistryError, RegistryError, type RegistryErrorCode } from './errors'
import { provisionProvider } from './bootstrap'
import { createRegistryFixture, type RegistryFixture } from './test-support'

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

describe('provider ownership and cross-provider isolation', () => {
  test('public reads work without a token but mutations require ownership', () => {
    const { registry } = setup()
    const owner = provision('owner')
    const stranger = provision('stranger')

    const rulebook = registry.createRulebook(owner.token.secret, {
      name: 'Owner Rulebook',
      applicableSpec: 'ts11@1.0.1',
      attestations: [{ name: 'PID', attestationLoS: 'iso_18045_high', bindingType: 'key' }],
    })
    const attestation = registry.listAttestations(rulebook.id)[0]
    if (attestation === undefined) {
      throw new Error('expected the created attestation')
    }
    const reference = registry.addSchemaReference(owner.token.secret, rulebook.id, {
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://example.org/schema.json',
      attestationId: attestation.id,
    })

    // Public catalog reads need no actor.
    expect(registry.getRulebook(rulebook.id)).toEqual(rulebook)
    expect(registry.listRulebooks()).toEqual([rulebook])
    expect(registry.listRulebooks({ providerId: owner.provider.id })).toEqual([rulebook])
    expect(registry.listAttestations(rulebook.id)).toHaveLength(1)
    expect(registry.listSchemaReferences(rulebook.id)).toEqual([reference])
    expect(registry.getProvider(owner.provider.id)).toEqual(owner.provider)
    expect(
      registry
        .listProviders()
        .map((provider) => provider.id)
        .sort(),
    ).toEqual([owner.provider.id, stranger.provider.id].sort())

    // A different provider can read but never mutate the rulebook.
    expectRegistryError(
      () => registry.updateRulebook(stranger.token.secret, rulebook.id, { name: 'Hijacked' }),
      'forbidden',
    )
    expectRegistryError(
      () => registry.deleteRulebook(stranger.token.secret, rulebook.id),
      'forbidden',
    )
    expectRegistryError(
      () =>
        registry.addAttestation(stranger.token.secret, rulebook.id, {
          name: 'Hijacked',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
        }),
      'forbidden',
    )
    expectRegistryError(
      () =>
        registry.updateAttestation(stranger.token.secret, rulebook.id, attestation?.id ?? '', {
          name: 'Hijacked',
        }),
      'forbidden',
    )
    expectRegistryError(
      () => registry.removeAttestation(stranger.token.secret, rulebook.id, attestation?.id ?? ''),
      'forbidden',
    )
    expectRegistryError(
      () =>
        registry.addSchemaReference(stranger.token.secret, rulebook.id, {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://example.org/hijacked.json',
        }),
      'forbidden',
    )
    expectRegistryError(
      () =>
        registry.updateSchemaReference(stranger.token.secret, rulebook.id, reference.id, {
          uri: 'https://example.org/hijacked.json',
        }),
      'forbidden',
    )
    expectRegistryError(
      () => registry.removeSchemaReference(stranger.token.secret, rulebook.id, reference.id),
      'forbidden',
    )

    // Nothing changed after the denied attempts.
    expect(registry.getRulebook(rulebook.id)).toEqual(rulebook)
    expect(registry.listAttestations(rulebook.id)).toHaveLength(1)
    expect(registry.listSchemaReferences(rulebook.id)).toEqual([reference])
  })

  test('tokens are scoped to their provider and cannot be managed across providers', () => {
    const { registry } = setup()
    const first = provision('first')
    const second = provision('second')

    expect(registry.listTokens(first.token.secret).map((token) => token.id)).toEqual([
      first.token.id,
    ])
    expect(registry.listTokens(second.token.secret).map((token) => token.id)).toEqual([
      second.token.id,
    ])

    expectRegistryError(
      () => registry.revokeToken(second.token.secret, first.token.id),
      'not_found',
    )
    expect(registry.authenticate(first.token.secret).providerId).toBe(first.provider.id)
  })

  test('deleting the acting provider does not remove another provider', () => {
    const { registry } = setup()
    const first = provision('first')
    const second = provision('second')

    registry.deleteProvider(second.token.secret)

    expect(registry.getProvider(second.provider.id)).toBeNull()
    expect(registry.getProvider(first.provider.id)).toEqual(first.provider)
    expect(registry.authenticate(first.token.secret).providerId).toBe(first.provider.id)
    expect(() => registry.authenticate(second.token.secret)).toThrow('valid bearer token')
  })

  test('unauthenticated writes fail without changing the database', () => {
    const { registry, database } = setup()
    const owner = provision('owner')
    const rulebook = registry.createRulebook(owner.token.secret, {
      name: 'Stable',
      applicableSpec: 'ts11@1.0.1',
    })
    const before = database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM audit_log')
      .get()?.count

    for (const invalid of ['', 'att_invalid', `${owner.token.secret}tampered`]) {
      expectRegistryError(
        () => registry.updateRulebook(invalid, rulebook.id, { name: 'Hijacked' }),
        'unauthorized',
      )
      expectRegistryError(() => registry.deleteRulebook(invalid, rulebook.id), 'unauthorized')
      expectRegistryError(
        () =>
          registry.createRulebook(invalid, {
            name: 'Hijacked',
            applicableSpec: 'ts11@1.0.1',
          }),
        'unauthorized',
      )
    }

    expect(registry.getRulebook(rulebook.id)).toEqual(rulebook)
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM rulebooks').get()?.count,
    ).toBe(1)
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM audit_log').get()?.count,
    ).toBe(before)
  })
})
