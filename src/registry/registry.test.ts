import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Registry } from './registry'
import { provisionProvider } from './bootstrap'
import { AUTH_TOKEN_HASH_LENGTH, hashBearerToken } from './tokens'
import { isRegistryError, RegistryError, type RegistryErrorCode } from './errors'
import { openMigratedDatabase, createRegistryFixture, type RegistryFixture } from './test-support'
import { MAX_DESCRIPTION_LENGTH } from './validation'
import type {
  CreateAttestationInput,
  CreateRulebookInput,
  JsonObject,
  UpdateProviderInput,
  UpdateRulebookInput,
} from './types'

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

describe('provider provisioning and authentication', () => {
  test('creates a provider and stores only an SHA-256 token hash', () => {
    const { registry, database } = setup()
    const { provider, token } = provisionProvider(database, {
      name: '  Example Provider  ',
      publicationAuthority: ' account:example ',
      metadata: { internal: true },
      tokenLabel: 'initial',
    })

    expect(provider.name).toBe('Example Provider')
    expect(provider.publicationAuthority).toBe('account:example')
    expect(provider.metadata).toEqual({ internal: true })
    expect(provider.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )

    expect(token.secret.startsWith('att_')).toBe(true)
    expect(token.secret).toHaveLength(4 + 43)
    expect(token.providerId).toBe(provider.id)
    expect(token.label).toBe('initial')
    expect(token.revokedAt).toBeNull()

    const rows = database
      .query<{ token_hash: string }, []>('SELECT token_hash FROM auth_tokens')
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.token_hash).toBe(hashBearerToken(token.secret))
    expect(rows[0]?.token_hash).toHaveLength(AUTH_TOKEN_HASH_LENGTH)
    expect(rows[0]?.token_hash).not.toContain(token.secret)

    expect(registry.authenticateBearer(token.secret)).toEqual({
      providerId: provider.id,
      authMethod: 'bearer',
      tokenId: token.id,
    })
    expect(registry.getProvider(provider.id)).toEqual(provider)
    expect(registry.listProviders()).toEqual([provider])
  })

  test('rejects a duplicate publication authority with a typed conflict', () => {
    const { database } = setup()
    provisionProvider(database, {
      name: 'First Account',
      publicationAuthority: 'account-shared',
    })

    expectRegistryError(
      () =>
        provisionProvider(database, {
          name: 'Second Account',
          publicationAuthority: 'ACCOUNT-SHARED',
        }),
      'conflict',
    )
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM providers').get()?.count,
    ).toBe(1)
  })

  test('issues additional tokens and revokes them idempotently', () => {
    const { registry } = setup()
    const { actor, token } = provision('a')
    const second = registry.issueToken(actor, 'ci')

    expect(registry.authenticateBearer(second.secret).providerId).toBe(token.providerId)
    expect(
      registry
        .listTokens(actor)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([token.id, second.id].sort())

    registry.revokeToken(actor, second.id)
    expect(() => registry.authenticateBearer(second.secret)).toThrow('valid bearer token')
    registry.revokeToken(actor, second.id)

    const revoked = registry.listTokens(actor).find((entry) => entry.id === second.id)
    expect(revoked?.revokedAt).not.toBeNull()
  })

  test('rejects unknown, malformed and revoked tokens as unauthorized', () => {
    const { registry } = setup()
    const { actor, token } = provision('a')

    for (const candidate of ['', 'not-a-token', `${token.secret}x`, 'att_']) {
      expectRegistryError(() => registry.authenticateBearer(candidate), 'unauthorized')
    }

    const second = registry.issueToken(actor)
    registry.revokeToken(actor, second.id)
    expectRegistryError(() => registry.authenticateBearer(second.secret), 'unauthorized')
  })

  test('updates and deletes only the authenticated provider account', () => {
    const { registry } = setup()
    const first = provision('a')
    const second = provision('b')

    const updated = registry.updateProvider(first.actor, {
      name: 'Renamed Provider',
      metadata: { owner: 'team-a' },
    })
    expect(updated.name).toBe('Renamed Provider')
    expect(registry.getProvider(second.provider.id)?.name).toBe('Provider b')

    // Publication authority is operator-assigned; even an extra runtime field
    // cannot change it through the update path.
    const attempted = registry.updateProvider(first.actor, {
      name: 'Renamed Provider',
      publicationAuthority: 'account-b',
    } as unknown as UpdateProviderInput)
    expect(attempted.publicationAuthority).toBe(first.provider.publicationAuthority)

    const rulebook = registry.createRulebook(first.actor, {
      name: 'Owned Rulebook',
      applicableSpec: 'ts11@1.0.1',
    })
    expectRegistryError(() => registry.deleteProvider(first.actor), 'conflict')

    registry.deleteRulebook(first.actor, rulebook.id)
    registry.deleteProvider(first.actor)
    expect(registry.getProvider(first.provider.id)).toBeNull()
    expect(registry.getProvider(second.provider.id)).not.toBeNull()
    expect(() => registry.authenticateBearer(first.token.secret)).toThrow('valid bearer token')
  })
})

describe('rulebook persistence', () => {
  test('creates, reads and lists rulebooks with nested attestation types', () => {
    const { registry } = setup()
    const { actor, provider } = provision('a')

    const rulebook = registry.createRulebook(actor, {
      name: 'PID Rulebook',
      description: 'Person Identification Data',
      sourceUrl: 'https://example.org/catalog/pid',
      applicableSpec: 'ts11@1.0.1',
      provenance: { importedFrom: 'fixture' },
      metadata: { internalNote: 'not a standards field' },
      attestations: [
        {
          name: 'PID',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt'],
          metadata: { order: 1 },
        },
        {
          name: 'Pseudonym',
          attestationLoS: 'iso_18045_moderate',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
        },
      ],
    })

    expect(rulebook.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rulebook.providerId).toBe(provider.id)
    expect(rulebook.publicationStatus).toBe('draft')
    expect(rulebook.createdAt).toBe(rulebook.updatedAt)
    expect(registry.getRulebook(rulebook.id)).toEqual(rulebook)
    expect(registry.listRulebooks()).toEqual([rulebook])
    expect(registry.listRulebooks({ providerId: provider.id })).toEqual([rulebook])
    expect(registry.listRulebooks({ providerId: 'missing' })).toEqual([])

    const attestations = registry.listAttestations(rulebook.id)
    expect(attestations.map((entry) => entry.name)).toEqual(['PID', 'Pseudonym'])
    expect(attestations[0]?.supportedFormats).toEqual(['dc+sd-jwt'])
    expect(attestations[1]?.supportedFormats).toEqual(['dc+sd-jwt', 'mso_mdoc'])
  })

  test('normalizes absolute http(s) URLs before storing them', () => {
    const { registry } = setup()
    const { actor } = provision('a')
    const rulebook = registry.createRulebook(actor, {
      name: 'URLs',
      applicableSpec: 'ts11@1.0.1',
      sourceUrl: 'HTTPS://Example.ORG/Catalog',
    })
    expect(rulebook.sourceUrl).toBe('https://example.org/Catalog')

    const reference = registry.addSchemaReference(actor, rulebook.id, {
      formatIdentifier: 'dc+sd-jwt',
      uri: 'HTTPS://Example.ORG/schema.json',
    })
    expect(reference.uri).toBe('https://example.org/schema.json')
  })

  test('stores a detached JSON copy of internal metadata', () => {
    const { registry } = setup()
    const { actor } = provision('a')
    const metadata = { nested: { value: 1 } }
    const rulebook = registry.createRulebook(actor, {
      name: 'Detached metadata',
      applicableSpec: 'ts11@1.0.1',
      metadata,
    })

    metadata.nested.value = 2
    expect(rulebook.metadata).toEqual({ nested: { value: 1 } })
    expect(registry.getRulebook(rulebook.id)?.metadata).toEqual({ nested: { value: 1 } })
  })

  test('updates drafts, clears optional fields and leaves unchanged rows untouched', () => {
    const { registry } = setup()
    const { actor } = provision('a')
    const rulebook = registry.createRulebook(actor, {
      name: 'Draft',
      description: 'Before',
      sourceUrl: 'https://example.org/before',
      applicableSpec: 'ts11@1.0.1',
    })

    const updated = registry.updateRulebook(actor, rulebook.id, {
      name: 'Renamed Draft',
      description: 'After',
      metadata: { note: 'updated' },
    })
    expect(updated.name).toBe('Renamed Draft')
    expect(updated.description).toBe('After')
    expect(updated.metadata).toEqual({ note: 'updated' })
    expect(updated.sourceUrl).toBe('https://example.org/before')
    expect(updated.updatedAt).not.toBe(rulebook.updatedAt)

    const unchanged = registry.updateRulebook(actor, updated.id, {
      name: 'Renamed Draft',
      metadata: { note: 'updated' },
    })
    expect(unchanged.updatedAt).toBe(updated.updatedAt)

    const cleared = registry.updateRulebook(actor, updated.id, { sourceUrl: null })
    expect(cleared.sourceUrl).toBeNull()
  })

  test('persists rulebooks and tokens across a database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'attestbook-registry-reopen-'))
    const databasePath = join(directory, 'attestbook.sqlite')
    let database = openMigratedDatabase(databasePath)

    try {
      const first = new Registry({ database })
      const { actor, token } = provisionProvider(database, {
        name: 'Persistent Provider',
        publicationAuthority: 'account-persistent',
      })
      const rulebook = first.createRulebook(actor, {
        name: 'Persistent Rulebook',
        applicableSpec: 'ts11@1.0.1',
      })
      database.close()

      database = openMigratedDatabase(databasePath)
      const second = new Registry({ database })
      expect(second.getRulebook(rulebook.id)).toEqual(rulebook)
      expect(second.authenticateBearer(token.secret).providerId).toBe(token.providerId)
      expect(second.listAttestations(rulebook.id)).toEqual([])
    } finally {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('deletes draft rulebooks and cascades attestations and schema references', () => {
    const { registry, database } = setup()
    const { actor } = provision('a')
    const rulebook = registry.createRulebook(actor, {
      name: 'To delete',
      applicableSpec: 'ts11@1.0.1',
      attestations: [{ name: 'PID', attestationLoS: 'iso_18045_high', bindingType: 'key' }],
    })
    const attestation = registry.listAttestations(rulebook.id)[0]
    if (attestation === undefined) {
      throw new Error('expected the created attestation')
    }
    registry.addSchemaReference(actor, rulebook.id, {
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://example.org/schema.json',
      attestationId: attestation.id,
    })

    registry.deleteRulebook(actor, rulebook.id)

    expect(registry.getRulebook(rulebook.id)).toBeNull()
    expect(registry.listRulebooks()).toEqual([])
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM attestations').get()
        ?.count,
    ).toBe(0)
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM schema_refs').get()
        ?.count,
    ).toBe(0)
    const audit = database
      .query<{ action: string; detail_json: string | null }, []>(
        `SELECT action, detail_json FROM audit_log
         WHERE action IN ('attestation.delete', 'schema_ref.delete')`,
      )
      .all()
    expect(
      audit.some(
        (entry) =>
          entry.action === 'attestation.delete' &&
          (JSON.parse(entry.detail_json ?? '{}') as { reason?: string }).reason ===
            'rulebook.delete',
      ),
    ).toBe(true)
    expect(
      audit.some(
        (entry) =>
          entry.action === 'schema_ref.delete' &&
          (JSON.parse(entry.detail_json ?? '{}') as { reason?: string }).reason ===
            'rulebook.delete',
      ),
    ).toBe(true)
  })

  test('records an audit entry for every mutation, with the acting provider', () => {
    const { registry, database } = setup()
    const { actor, provider } = provision('a')
    const rulebook = registry.createRulebook(actor, {
      name: 'Audited',
      applicableSpec: 'ts11@1.0.1',
      attestations: [{ name: 'PID', attestationLoS: 'iso_18045_high', bindingType: 'key' }],
    })
    registry.updateRulebook(actor, rulebook.id, { description: 'changed' })

    const entries = database
      .query<{ action: string; actor_provider_id: string | null }, []>(
        'SELECT action, actor_provider_id FROM audit_log ORDER BY id',
      )
      .all()
    expect(entries.map((entry) => entry.action)).toEqual([
      'provider.provision',
      'token.issue',
      'rulebook.create',
      'attestation.create',
      'rulebook.update',
    ])
    expect(entries[0]?.actor_provider_id).toBeNull()
    expect(entries.slice(2).every((entry) => entry.actor_provider_id === provider.id)).toBe(true)
  })
})

describe('attestation types and schema references', () => {
  test('supports CRUD for attestation types and schema references', () => {
    const { registry } = setup()
    const { actor } = provision('a')
    const rulebook = registry.createRulebook(actor, {
      name: 'CRUD',
      applicableSpec: 'ts11@1.0.1',
    })

    const attestation = registry.addAttestation(actor, rulebook.id, {
      name: 'PID',
      attestationLoS: 'iso_18045_high',
      bindingType: 'key',
      supportedFormats: ['dc+sd-jwt'],
    })
    expect(registry.listAttestations(rulebook.id)).toEqual([attestation])
    const afterAttestation = registry.getRulebook(rulebook.id)
    expect(afterAttestation?.updatedAt).not.toBe(rulebook.updatedAt)

    const reference = registry.addSchemaReference(actor, rulebook.id, {
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://example.org/pid.json',
      integrity: 'sha256-abc123',
      attestationId: attestation.id,
      metadata: { resolved: false },
    })
    expect(registry.listSchemaReferences(rulebook.id)).toEqual([reference])
    expect(reference.attestationId).toBe(attestation.id)

    const updatedAttestation = registry.updateAttestation(actor, rulebook.id, attestation.id, {
      bindingType: 'claim',
      supportedFormats: ['mso_mdoc'],
    })
    expect(updatedAttestation.bindingType).toBe('claim')
    expect(updatedAttestation.supportedFormats).toEqual(['mso_mdoc'])

    const updatedReference = registry.updateSchemaReference(actor, rulebook.id, reference.id, {
      formatIdentifier: 'mso_mdoc',
      integrity: null,
      attestationId: null,
    })
    expect(updatedReference.formatIdentifier).toBe('mso_mdoc')
    expect(updatedReference.integrity).toBeNull()
    expect(updatedReference.attestationId).toBeNull()

    registry.removeSchemaReference(actor, rulebook.id, reference.id)
    registry.removeAttestation(actor, rulebook.id, attestation.id)
    expect(registry.listSchemaReferences(rulebook.id)).toEqual([])
    expect(registry.listAttestations(rulebook.id)).toEqual([])
  })

  test('scopes schema-reference uniqueness to the attestation type', () => {
    const { registry } = setup()
    const { actor } = provision('a')
    const rulebook = registry.createRulebook(actor, {
      name: 'Scoped schemas',
      applicableSpec: 'ts11@1.0.1',
      attestations: [
        { name: 'PID', attestationLoS: 'iso_18045_high', bindingType: 'key' },
        { name: 'mDL', attestationLoS: 'iso_18045_high', bindingType: 'key' },
      ],
    })
    const [pid, mdl] = registry.listAttestations(rulebook.id)
    if (pid === undefined || mdl === undefined) {
      throw new Error('expected both attestation types')
    }

    const pidReference = registry.addSchemaReference(actor, rulebook.id, {
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://example.org/pid.json',
      attestationId: pid.id,
    })
    const mdlReference = registry.addSchemaReference(actor, rulebook.id, {
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://example.org/mdl.json',
      attestationId: mdl.id,
    })
    expect(registry.listSchemaReferences(rulebook.id)).toHaveLength(2)

    // The same format is accepted at rulebook level as its own scope.
    const rulebookReference = registry.addSchemaReference(actor, rulebook.id, {
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://example.org/rulebook.json',
    })
    expect(rulebookReference.attestationId).toBeNull()

    expectRegistryError(
      () =>
        registry.addSchemaReference(actor, rulebook.id, {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://example.org/pid-duplicate.json',
          attestationId: pid.id,
        }),
      'conflict',
    )
    expectRegistryError(
      () =>
        registry.addSchemaReference(actor, rulebook.id, {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://example.org/rulebook-duplicate.json',
        }),
      'conflict',
    )
    expectRegistryError(
      () =>
        registry.updateSchemaReference(actor, rulebook.id, pidReference.id, {
          attestationId: null,
        }),
      'conflict',
    )
    expect(mdlReference.attestationId).toBe(mdl.id)
  })

  test('audits schema references removed together with their attestation', () => {
    const { registry, database } = setup()
    const { actor } = provision('a')
    const rulebook = registry.createRulebook(actor, {
      name: 'Cascade audit',
      applicableSpec: 'ts11@1.0.1',
      attestations: [{ name: 'PID', attestationLoS: 'iso_18045_high', bindingType: 'key' }],
    })
    const attestation = registry.listAttestations(rulebook.id)[0]
    if (attestation === undefined) {
      throw new Error('expected the created attestation')
    }
    registry.addSchemaReference(actor, rulebook.id, {
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://example.org/schema.json',
      attestationId: attestation.id,
    })

    registry.removeAttestation(actor, rulebook.id, attestation.id)

    expect(registry.listSchemaReferences(rulebook.id)).toEqual([])
    const audit = database
      .query<{ action: string; detail_json: string | null }, []>(
        "SELECT action, detail_json FROM audit_log WHERE action = 'schema_ref.delete'",
      )
      .all()
    expect(audit).toHaveLength(1)
    expect(JSON.parse(audit[0]?.detail_json ?? '{}')).toMatchObject({
      reason: 'attestation.delete',
    })
  })

  test('rejects duplicate attestation names and schema format identifiers', () => {
    const { registry } = setup()
    const { actor } = provision('a')
    const rulebook = registry.createRulebook(actor, {
      name: 'Duplicates',
      applicableSpec: 'ts11@1.0.1',
    })
    registry.addAttestation(actor, rulebook.id, {
      name: 'PID',
      attestationLoS: 'iso_18045_high',
      bindingType: 'key',
    })
    registry.addSchemaReference(actor, rulebook.id, {
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://example.org/pid.json',
    })

    expectRegistryError(
      () =>
        registry.addAttestation(actor, rulebook.id, {
          name: 'PID',
          attestationLoS: 'iso_18045_moderate',
          bindingType: 'key',
        }),
      'conflict',
    )
    expectRegistryError(
      () =>
        registry.addSchemaReference(actor, rulebook.id, {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://example.org/other.json',
        }),
      'conflict',
    )
  })
})

describe('registry invalid writes', () => {
  test('rejects malformed rulebook input before it reaches the database', () => {
    const { registry } = setup()
    const { actor } = provision('a')
    const base = { name: 'Rulebook', applicableSpec: 'ts11@1.0.1' }

    expectRegistryError(
      () => registry.createRulebook(actor, { ...base, name: '   ' }),
      'invalid_input',
    )
    expectRegistryError(
      () => registry.createRulebook(actor, { ...base, applicableSpec: '' }),
      'invalid_input',
    )
    expectRegistryError(
      () => registry.createRulebook(actor, { ...base, sourceUrl: 'ftp://example.org/x' }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.createRulebook(actor, {
          ...base,
          sourceUrl: 'https://user:secret@example.org/x',
        }),
      'invalid_input',
    )
    expectRegistryError(
      () => registry.createRulebook(actor, { ...base, sourceUrl: 'not a url' }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.createRulebook(actor, {
          ...base,
          sourceUrl: `https://example.org/${'é'.repeat(1_000)}`,
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.createRulebook(actor, {
          ...base,
          metadata: [] as unknown as JsonObject,
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.createRulebook(actor, {
          ...base,
          description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1),
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.createRulebook(actor, {
          ...base,
          attestations: [
            { name: 'Same', attestationLoS: 'iso_18045_high', bindingType: 'key' },
            { name: 'Same', attestationLoS: 'iso_18045_high', bindingType: 'key' },
          ],
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.createRulebook(actor, {
          ...base,
          attestations: {} as unknown as readonly CreateAttestationInput[],
        }),
      'invalid_input',
    )
    expectRegistryError(
      () => registry.createRulebook(actor, null as unknown as CreateRulebookInput),
      'invalid_input',
    )

    const created = registry.createRulebook(actor, base)
    expectRegistryError(
      () => registry.updateRulebook(actor, created.id, null as unknown as UpdateRulebookInput),
      'invalid_input',
    )

    expect(registry.listRulebooks()).toEqual([created])
  })

  test('rejects malformed attestation and schema-reference input', () => {
    const { registry } = setup()
    const { actor } = provision('a')
    const rulebook = registry.createRulebook(actor, {
      name: 'Invalid',
      applicableSpec: 'ts11@1.0.1',
    })

    expectRegistryError(
      () =>
        registry.addAttestation(actor, rulebook.id, {
          name: 'PID',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
          supportedFormats: ['dc+sd-jwt', 'dc+sd-jwt'],
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.addSchemaReference(actor, rulebook.id, {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'file:///etc/passwd',
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.addSchemaReference(actor, rulebook.id, {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://example.org/schema.json',
          integrity: 'sha256',
        }),
      'invalid_input',
    )
    expectRegistryError(
      () =>
        registry.addSchemaReference(actor, rulebook.id, {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://example.org/schema.json',
          attestationId: 'missing-attestation',
        }),
      'not_found',
    )
    expectRegistryError(
      () =>
        registry.addAttestation(actor, 'missing-rulebook', {
          name: 'PID',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
        }),
      'not_found',
    )
    expectRegistryError(
      () => registry.updateRulebook(actor, 'missing-rulebook', { name: 'x' }),
      'not_found',
    )
    expectRegistryError(
      () =>
        registry.updateAttestation(actor, rulebook.id, 'missing-attestation', {
          name: 'x',
        }),
      'not_found',
    )
    expectRegistryError(
      () =>
        registry.updateSchemaReference(actor, rulebook.id, 'missing-reference', {
          uri: 'https://example.org/other.json',
        }),
      'not_found',
    )
  })

  test('refuses to mutate published or historical rulebooks', () => {
    const { registry, database } = setup()
    const { actor } = provision('a')
    const rulebook = registry.createRulebook(actor, {
      name: 'Published',
      applicableSpec: 'ts11@1.0.1',
      attestations: [{ name: 'PID', attestationLoS: 'iso_18045_high', bindingType: 'key' }],
    })
    const [attestation] = registry.listAttestations(rulebook.id)

    // The publishing lifecycle belongs to #29; simulate the stored state.
    database
      .query('UPDATE rulebooks SET publication_status = ? WHERE id = ?')
      .run('published', rulebook.id)

    expectRegistryError(
      () => registry.updateRulebook(actor, rulebook.id, { name: 'Changed' }),
      'immutable',
    )
    expectRegistryError(() => registry.deleteRulebook(actor, rulebook.id), 'immutable')
    expectRegistryError(
      () =>
        registry.addAttestation(actor, rulebook.id, {
          name: 'New',
          attestationLoS: 'iso_18045_high',
          bindingType: 'key',
        }),
      'immutable',
    )
    expectRegistryError(
      () => registry.removeAttestation(actor, rulebook.id, attestation?.id ?? ''),
      'immutable',
    )
    expect(registry.getRulebook(rulebook.id)?.publicationStatus).toBe('published')

    database
      .query('UPDATE rulebooks SET publication_status = ? WHERE id = ?')
      .run('historical', rulebook.id)
    expectRegistryError(
      () => registry.updateRulebook(actor, rulebook.id, { name: 'Changed' }),
      'immutable',
    )
  })

  test('rejects invalid identifiers on reads', () => {
    const { registry } = setup()
    expectRegistryError(() => registry.getRulebook(''), 'invalid_input')
    expectRegistryError(() => registry.getRulebook('   '), 'invalid_input')
    expectRegistryError(() => registry.listRulebooks({ providerId: '' }), 'invalid_input')
    expect(registry.getRulebook('does-not-exist')).toBeNull()
  })
})
