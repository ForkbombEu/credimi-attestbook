// Test-only provisioning for the user acceptance tests of issues #88 and #89.
//
// This script is run by the sandbox's `uat:setup` task, never by the production
// server. It creates a disposable SQLite database, provisions the *existing*
// test provider the administrator is bound to and a second, unrelated writer
// provider, generates a fresh Argon2id hash for the fixed test password and
// writes the environment file that `scripts/uat-start.sh` sources. Nothing here
// is a committed secret or a production credential.
//
// `dist/uat/fixtures.json` exposes the same disposable values to a local test
// client: the administrator test credentials and provider id (the session is
// bound to provider A) plus provider B's id and bearer token (used to prove that
// the legacy bearer path still works). The file is git-ignored together with
// the rest of `dist/`.
//
// The UAT client runs outside this sandbox's filesystem, so the writer
// provider's bearer token cannot be read from `fixtures.json`. It is therefore
// a fixed, disposable test value (like the fixed test password above), valid
// only in the throwaway database this script creates. It is never written by
// the production server and no production configuration reads it.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

import { openDatabase } from '../src/db/database'
import { applyMigrations } from '../src/db/migrations'
import { provisionProvider } from '../src/registry/bootstrap'
import { RegistryStore } from '../src/registry/store'
import { hashBearerToken } from '../src/registry/tokens'

const UAT_ADMIN_USERNAME = 'uat-admin'
const UAT_ADMIN_PASSWORD = 'uat-test-password'
const UAT_PROVIDER_NAME = 'UAT Administrator Provider'
const UAT_PUBLICATION_AUTHORITY = 'uat-administrator-provider'
const UAT_WRITER_PROVIDER_NAME = 'UAT Writer Provider'
const UAT_WRITER_PUBLICATION_AUTHORITY = 'uat-writer-provider'

/**
 * Fixed bearer token of the disposable writer provider. It is a test fixture,
 * not a production credential: it exists only in the sandbox database created
 * here, is documented as a UAT test value, and is never emitted by the
 * application. A UAT client uses it to exercise the legacy bearer transport
 * without access to the sandbox filesystem.
 */
const UAT_WRITER_BEARER_TOKEN = 'att_uat_writer_disposable_test_token_only'
const UAT_WRITER_TOKEN_LABEL = 'uat-writer-fixed-test-token'

const outputDirectory = resolve(process.cwd(), 'dist', 'uat')
const databasePath = join(outputDirectory, 'attestbook.sqlite')
const environmentPath = join(outputDirectory, 'admin.env')
const fixturesPath = join(outputDirectory, 'fixtures.json')

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

mkdirSync(outputDirectory, { recursive: true })
for (const suffix of ['', '-shm', '-wal']) {
  rmSync(`${databasePath}${suffix}`, { force: true })
}
rmSync(fixturesPath, { force: true })

const database = openDatabase(databasePath)
try {
  applyMigrations(database)
  const administrator = provisionProvider(database, {
    name: UAT_PROVIDER_NAME,
    publicationAuthority: UAT_PUBLICATION_AUTHORITY,
  })
  // A second provider whose bearer token is independent of the administrator
  // session. UAT-3 uses it to prove that explicit bearer writes keep working
  // and are attributed to the token's provider.
  const writer = provisionProvider(database, {
    name: UAT_WRITER_PROVIDER_NAME,
    publicationAuthority: UAT_WRITER_PUBLICATION_AUTHORITY,
    tokenLabel: 'uat-writer',
  })
  // The fixed fixture credential for the writer provider. It is inserted next
  // to the random token provisioning issued, so both are valid in this
  // disposable database.
  new RegistryStore(database).insertToken(
    randomUUID(),
    writer.provider.id,
    hashBearerToken(UAT_WRITER_BEARER_TOKEN),
    UAT_WRITER_TOKEN_LABEL,
    new Date().toISOString(),
  )

  const passwordHash = await Bun.password.hash(UAT_ADMIN_PASSWORD, { algorithm: 'argon2id' })
  const environment: readonly (readonly [string, string])[] = [
    ['DATABASE_PATH', databasePath],
    ['HOST', '127.0.0.1'],
    ['PORT', '3000'],
    ['ADMIN_USERNAME', UAT_ADMIN_USERNAME],
    ['ADMIN_PASSWORD_HASH', passwordHash],
    ['ADMIN_PROVIDER_ID', administrator.provider.id],
  ]

  writeFileSync(
    environmentPath,
    `${environment.map(([name, value]) => `${name}=${shellQuote(value)}`).join('\n')}\n`,
    { mode: 0o600 },
  )
  writeFileSync(
    fixturesPath,
    `${JSON.stringify(
      {
        administrator: {
          username: UAT_ADMIN_USERNAME,
          password: UAT_ADMIN_PASSWORD,
          providerId: administrator.provider.id,
        },
        writer: {
          providerId: writer.provider.id,
          bearerToken: UAT_WRITER_BEARER_TOKEN,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )

  console.log(
    `UAT fixtures provisioned: administrator provider ${administrator.provider.id}, writer provider ${writer.provider.id} (test credentials only; writer token is the fixed UAT fixture value)`,
  )
} finally {
  database.close()
}
