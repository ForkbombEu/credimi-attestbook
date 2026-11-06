import { afterEach, describe, expect, test } from 'bun:test'

import { provisionProvider } from './bootstrap'
import { RegistryError } from './errors'
import { createRegistryFixture, type RegistryFixture } from './test-support'

const IMPORT_KEY = 'a'.repeat(64)
const OTHER_IMPORT_KEY = 'b'.repeat(64)

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function setup() {
  fixture = createRegistryFixture()
  const first = provisionProvider(fixture.database, {
    name: 'First Provider',
    publicationAuthority: 'account-first',
  })
  const second = provisionProvider(fixture.database, {
    name: 'Second Provider',
    publicationAuthority: 'account-second',
  })
  return { fixture, first, second }
}

function catchRegistryError(action: () => unknown): RegistryError {
  try {
    action()
  } catch (error) {
    if (error instanceof RegistryError) {
      return error
    }
    throw error
  }
  throw new Error('expected a RegistryError')
}

describe('import identities on rulebooks', () => {
  test('persists an import key and leaves locally authored rulebooks without one', () => {
    const { fixture, first } = setup()

    const imported = fixture.registry.createRulebook(first.token.secret, {
      name: 'Imported',
      applicableSpec: 'ts11@1.0.1',
      importKey: IMPORT_KEY,
    })
    const local = fixture.registry.createRulebook(first.token.secret, {
      name: 'Authored locally',
      applicableSpec: 'ts11@1.0.1',
    })

    expect(imported.importKey).toBe(IMPORT_KEY)
    expect(fixture.registry.getRulebook(imported.id)?.importKey).toBe(IMPORT_KEY)
    expect(local.importKey).toBeNull()
  })

  test('rejects a duplicate import key for the same provider at the service boundary', () => {
    const { fixture, first } = setup()
    fixture.registry.createRulebook(first.token.secret, {
      name: 'Imported',
      applicableSpec: 'ts11@1.0.1',
      importKey: IMPORT_KEY,
    })

    const error = catchRegistryError(() =>
      fixture.registry.createRulebook(first.token.secret, {
        name: 'Duplicate',
        applicableSpec: 'ts11@1.0.1',
        importKey: IMPORT_KEY,
      }),
    )

    expect(error.code).toBe('conflict')
    expect(fixture.registry.listRulebooks()).toHaveLength(1)
  })

  test('rejects a duplicate import key at the database boundary', () => {
    const { fixture, first } = setup()
    fixture.registry.createRulebook(first.token.secret, {
      name: 'Imported',
      applicableSpec: 'ts11@1.0.1',
      importKey: IMPORT_KEY,
    })

    expect(() =>
      fixture.database
        .query(
          `INSERT INTO rulebooks (
            id, provider_id, name, applicable_spec, import_key, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('direct-id', first.provider.id, 'Direct', 'ts11@1.0.1', IMPORT_KEY, 'now', 'now'),
    ).toThrow()
  })

  test('allows different providers to import the same external entry', () => {
    const { fixture, first, second } = setup()

    const one = fixture.registry.createRulebook(first.token.secret, {
      name: 'Imported',
      applicableSpec: 'ts11@1.0.1',
      importKey: IMPORT_KEY,
    })
    const two = fixture.registry.createRulebook(second.token.secret, {
      name: 'Imported',
      applicableSpec: 'ts11@1.0.1',
      importKey: IMPORT_KEY,
    })

    expect(one.id).not.toBe(two.id)
    expect(fixture.registry.listRulebooks()).toHaveLength(2)
  })

  test('looks up an import identity only for the authenticated provider', () => {
    const { fixture, first, second } = setup()
    const imported = fixture.registry.createRulebook(first.token.secret, {
      name: 'Imported',
      applicableSpec: 'ts11@1.0.1',
      importKey: IMPORT_KEY,
    })

    expect(fixture.registry.findImportedRulebook(first.token.secret, IMPORT_KEY)?.id).toBe(
      imported.id,
    )
    expect(fixture.registry.findImportedRulebook(second.token.secret, IMPORT_KEY)).toBeNull()
    expect(fixture.registry.findImportedRulebook(first.token.secret, OTHER_IMPORT_KEY)).toBeNull()
  })

  test('rejects a malformed import key and an invalid token', () => {
    const { fixture, first } = setup()

    expect(() =>
      fixture.registry.createRulebook(first.token.secret, {
        name: 'Imported',
        applicableSpec: 'ts11@1.0.1',
        importKey: 'not-a-digest',
      }),
    ).toThrow(/importKey/)

    expect(() => fixture.registry.findImportedRulebook('not-a-token', IMPORT_KEY)).toThrow()
    expect(() => fixture.registry.findImportedRulebook(first.token.secret, 'not-a-digest')).toThrow(
      /importKey/,
    )
  })

  test('normalizes a create input exactly like a write, without writing', () => {
    const { fixture, first } = setup()

    const prepared = fixture.registry.normalizeRulebookInput(first.token.secret, {
      name: '  Trimmed name  ',
      applicableSpec: ' ts11@1.0.1 ',
    })

    expect(prepared.rulebook.name).toBe('Trimmed name')
    expect(prepared.rulebook.applicableSpec).toBe('ts11@1.0.1')
    expect(fixture.registry.listRulebooks()).toHaveLength(0)
  })

  test('keeps the import key on update and out of the version snapshot', () => {
    const { fixture, first } = setup()
    const imported = fixture.registry.createRulebook(first.token.secret, {
      name: 'Imported',
      applicableSpec: 'ts11@1.0.1',
      importKey: IMPORT_KEY,
      provenance: { contentFingerprint: OTHER_IMPORT_KEY },
    })

    const updated = fixture.registry.updateRulebook(first.token.secret, imported.id, {
      name: 'Renamed',
    })
    expect(updated.importKey).toBe(IMPORT_KEY)

    fixture.registry.createRulebookVersion(first.token.secret, imported.id, { version: '1.0.0' })
    const content = fixture.registry.getRulebookVersionContent(imported.id, '1.0.0')
    const text = new TextDecoder().decode(content?.bytes)
    expect(text).not.toContain(IMPORT_KEY)
    expect(text).not.toContain('contentFingerprint')
    expect(text).not.toContain('importKey')
  })
})
