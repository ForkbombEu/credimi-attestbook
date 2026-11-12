// Test-only provisioning for the user acceptance tests of issues #88 and #89.
//
// This script is run by the sandbox's `uat:setup` task, never by the production
// server. It creates a disposable SQLite database, provisions the *existing*
// test provider the administrator is bound to and a second, unrelated writer
// provider, generates a fresh Argon2id hash for the fixed test password and
// writes the environment file that `scripts/uat-start.sh` sources. Nothing here
// is a committed secret or a production credential.
//
// `dist/uat/fixtures.json` exposes the same disposable values to a test client:
// the administrator test credentials and provider id (the session is bound to
// provider A) plus provider B's id and bearer token (used to prove that the
// legacy bearer path still works). The file is git-ignored together with the
// rest of `dist/`.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { openDatabase } from '../src/db/database'
import { applyMigrations } from '../src/db/migrations'
import { provisionProvider } from '../src/registry/bootstrap'

const UAT_ADMIN_USERNAME = 'uat-admin'
const UAT_ADMIN_PASSWORD = 'uat-test-password'
const UAT_PROVIDER_NAME = 'UAT Administrator Provider'
const UAT_PUBLICATION_AUTHORITY = 'uat-administrator-provider'
const UAT_WRITER_PROVIDER_NAME = 'UAT Writer Provider'
const UAT_WRITER_PUBLICATION_AUTHORITY = 'uat-writer-provider'

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
          bearerToken: writer.token.secret,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )

  console.log(
    `UAT fixtures provisioned: administrator provider ${administrator.provider.id}, writer provider ${writer.provider.id} (test credentials only; token in dist/uat/fixtures.json)`,
  )
} finally {
  database.close()
}
