// Test-only provisioning for the user acceptance tests of issue #88.
//
// This script is run by the sandbox's `uat:setup` task, never by the production
// server. It creates a disposable SQLite database, provisions the *existing*
// test provider the administrator is bound to, generates a fresh Argon2id hash
// for the fixed test password and writes the environment file that
// `scripts/uat-start.sh` sources. Nothing here is a committed secret or a
// production credential.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { openDatabase } from '../src/db/database'
import { applyMigrations } from '../src/db/migrations'
import { provisionProvider } from '../src/registry/bootstrap'

const UAT_ADMIN_USERNAME = 'uat-admin'
const UAT_ADMIN_PASSWORD = 'uat-test-password'
const UAT_PROVIDER_NAME = 'UAT Administrator Provider'
const UAT_PUBLICATION_AUTHORITY = 'uat-administrator-provider'

const outputDirectory = resolve(process.cwd(), 'dist', 'uat')
const databasePath = join(outputDirectory, 'attestbook.sqlite')
const environmentPath = join(outputDirectory, 'admin.env')

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

mkdirSync(outputDirectory, { recursive: true })
for (const suffix of ['', '-shm', '-wal']) {
  rmSync(`${databasePath}${suffix}`, { force: true })
}

const database = openDatabase(databasePath)
try {
  applyMigrations(database)
  const provisioned = provisionProvider(database, {
    name: UAT_PROVIDER_NAME,
    publicationAuthority: UAT_PUBLICATION_AUTHORITY,
  })

  const passwordHash = await Bun.password.hash(UAT_ADMIN_PASSWORD, { algorithm: 'argon2id' })
  const environment: readonly (readonly [string, string])[] = [
    ['DATABASE_PATH', databasePath],
    ['HOST', '127.0.0.1'],
    ['PORT', '3000'],
    ['ADMIN_USERNAME', UAT_ADMIN_USERNAME],
    ['ADMIN_PASSWORD_HASH', passwordHash],
    ['ADMIN_PROVIDER_ID', provisioned.provider.id],
  ]

  writeFileSync(
    environmentPath,
    `${environment.map(([name, value]) => `${name}=${shellQuote(value)}`).join('\n')}\n`,
    { mode: 0o600 },
  )

  console.log(
    `UAT administrator provisioned for existing provider ${provisioned.provider.id} (test credentials only)`,
  )
} finally {
  database.close()
}
