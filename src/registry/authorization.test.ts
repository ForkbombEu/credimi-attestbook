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

    const rulebook = registry.createRulebook(owner.actor, {
      name: 'Owner Rulebook',
      applicableSpec: 'ts11@1.0.1',
      attestations: [{ name: 'PID', attestationLoS: 'iso_18045_high', bindingType: 'key' }],
    })
    const attestation = registry.listAttestations(rulebook.id)[0]
    if (attestation === undefined) {
      throw new Error('expected the created attestation')
    }
    const reference = registry.addSchemaReference(owner.actor, rulebook.id, {
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://example.org/schema.json',
      attestationId: attestation.id,
    })

    const beforeDenials = registry.getRulebook(rulebook.id)
    if (beforeDenials === null) {
      throw new Error('expected the created rulebook')
    }

    // Public catalog reads need no actor.
    expect(registry.getRulebook(rulebook.id)).toEqual(beforeDenials)
    expect(registry.listRulebooks()).toEqual([beforeDenials])
    expect(registry.listRulebooks({ providerId: owner.provider.id })).toEqual([beforeDenials])
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
      () => registry.updateRulebook(stranger.actor, rulebook.id, { name: 'Hijacked' }),
      'forbidden',
    )
    expectRegistryError(() => registry.deleteRulebook(stranger.actor, rulebook.id), 'forbidden')
    expectRegistryError(
      () =>
        registry.addAttestation(stranger.actor, rulebook.id, {
          name: 'Hijacked',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
        }),
      'forbidden',
    )
    expectRegistryError(
      () =>
        registry.updateAttestation(stranger.actor, rulebook.id, attestation?.id ?? '', {
          name: 'Hijacked',
        }),
      'forbidden',
    )
    expectRegistryError(
      () => registry.removeAttestation(stranger.actor, rulebook.id, attestation?.id ?? ''),
      'forbidden',
    )
    expectRegistryError(
      () =>
        registry.addSchemaReference(stranger.actor, rulebook.id, {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://example.org/hijacked.json',
        }),
      'forbidden',
    )
    expectRegistryError(
      () =>
        registry.updateSchemaReference(stranger.actor, rulebook.id, reference.id, {
          uri: 'https://example.org/hijacked.json',
        }),
      'forbidden',
    )
    expectRegistryError(
      () => registry.removeSchemaReference(stranger.actor, rulebook.id, reference.id),
      'forbidden',
    )

    // Nothing changed after the denied attempts.
    expect(registry.getRulebook(rulebook.id)).toEqual(beforeDenials)
    expect(registry.listAttestations(rulebook.id)).toHaveLength(1)
    expect(registry.listSchemaReferences(rulebook.id)).toEqual([reference])
  })

  test('tokens are scoped to their provider and cannot be managed across providers', () => {
    const { registry } = setup()
    const first = provision('first')
    const second = provision('second')

    expect(registry.listTokens(first.actor).map((token) => token.id)).toEqual([first.token.id])
    expect(registry.listTokens(second.actor).map((token) => token.id)).toEqual([second.token.id])

    expectRegistryError(() => registry.revokeToken(second.actor, first.token.id), 'not_found')
    expect(registry.authenticateBearer(first.token.secret).providerId).toBe(first.provider.id)
  })

  test('deleting the acting provider does not remove another provider', () => {
    const { registry } = setup()
    const first = provision('first')
    const second = provision('second')

    registry.deleteProvider(second.actor)

    expect(registry.getProvider(second.provider.id)).toBeNull()
    expect(registry.getProvider(first.provider.id)).toEqual(first.provider)
    expect(registry.authenticateBearer(first.token.secret).providerId).toBe(first.provider.id)
    expect(() => registry.authenticateBearer(second.token.secret)).toThrow('valid bearer token')
  })

  test('unauthenticated writes fail without changing the database', () => {
    const { registry, database } = setup()
    const owner = provision('owner')
    const rulebook = registry.createRulebook(owner.actor, {
      name: 'Stable',
      applicableSpec: 'ts11@1.0.1',
    })
    const before = database
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM audit_log')
      .get()?.count

    // The transport refuses a missing, malformed or tampered bearer before any
    // write method is reached, so the service never sees an unverified actor.
    for (const invalid of ['', 'att_invalid', `${owner.token.secret}tampered`]) {
      expectRegistryError(() => registry.authenticateBearer(invalid), 'unauthorized')
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
