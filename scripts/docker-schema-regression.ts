#!/usr/bin/env bun
// CI-only regression for issue #114: schema registration in the production
// image.
//
// This script builds nothing itself. It expects the runtime image (default
// `attestbook:ci`, built from the repository Dockerfile) to exist and then:
//
//  1. provisions a disposable SQLite database on the CI host with one provider
//     and its bearer token, and mounts it as the container's `/data` volume;
//  2. starts the image as the non-root `bun` user with a read-only root
//     filesystem, so only the documented data volume is writable;
//  3. registers a minimal JSON Schema 2020-12 document through the real HTTP
//     endpoint, replays the exact bytes, retrieves them from the hosted URL and
//     checks that an invalid schema is a structured client error;
//  4. checks that the shared sandbox launcher provisioned its private
//     `.attestbook-sandbox` directory under `/data` with mode 0700.
//
// It never prints or stores the bearer token; the database is a throwaway file
// under the host temporary directory.

import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from '../src/db/database'
import { applyMigrations } from '../src/db/migrations'
import { provisionProvider } from '../src/registry/bootstrap'

const IMAGE = process.env.ATTESTBOOK_CI_IMAGE ?? 'attestbook:ci'
const CONTAINER = 'attestbook-schema-regression'
const PORT = Number(process.env.ATTESTBOOK_CI_PORT ?? '3399')
const BASE_URL = `http://127.0.0.1:${PORT}`

/** The minimal valid JSON Schema 2020-12 document from the acceptance criteria. */
const VALID_SCHEMA = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { given_name: { type: 'string' } },
})

/** Syntactically valid JSON Schema with the unsupported `pattern` keyword. */
const INVALID_SCHEMA = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { family_name: { type: 'string', pattern: '^[A-Z][a-z]+$' } },
})

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function docker(args: readonly string[], allowFailure = false): CommandResult {
  const result = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const command: CommandResult = {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
  if (command.exitCode !== 0 && !allowFailure) {
    throw new Error(
      `docker ${args.join(' ')} exited with ${command.exitCode}: ${command.stderr.trim()}`,
    )
  }
  return command
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function waitUntilReady(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  let lastError = 'no response'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health`)
      if (response.ok) {
        return
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(250)
  }
  throw new Error(`the container did not become ready: ${lastError}`)
}

async function register(token: string, body: string): Promise<Response> {
  return fetch(`${BASE_URL}/api/v1/schema-documents?kind=json_schema_2020_12`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body,
  })
}

interface DocumentMetadata {
  readonly data: {
    readonly id: string
    readonly url: string
    readonly integrity: string
    readonly contentDigest: string
    readonly mediaType: string
  }
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string }
}

async function run(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'attestbook-docker-schema-'))
  // The container's `bun` user (uid 1000) is not the CI runner account, so the
  // mounted data directory must be writable by it.
  chmodSync(directory, 0o777)
  const databasePath = join(directory, 'attestbook.sqlite')
  let token: string | undefined
  let failed = true

  try {
    const database = openDatabase(databasePath)
    try {
      applyMigrations(database)
      const provisioned = provisionProvider(database, {
        name: 'Docker Schema Regression Provider',
        publicationAuthority: 'docker-schema-regression',
        tokenLabel: 'docker-schema-regression',
      })
      token = provisioned.token.secret
    } finally {
      database.close()
    }
    chmodSync(databasePath, 0o666)
    for (const suffix of ['-wal', '-shm']) {
      const path = `${databasePath}${suffix}`
      if (existsSync(path)) {
        chmodSync(path, 0o666)
      }
    }

    docker(['rm', '--force', CONTAINER], true)
    docker([
      'run',
      '--detach',
      '--name',
      CONTAINER,
      // The hardened deployment this regression covers keeps the image root
      // filesystem read-only; only the documented data volume is writable.
      '--read-only',
      '--user',
      'bun',
      '--publish',
      `127.0.0.1:${PORT}:3000`,
      '--volume',
      `${directory}:/data`,
      '--env',
      'DATABASE_PATH=/data/attestbook.sqlite',
      '--env',
      'PORT=3000',
      '--env',
      'HOST=0.0.0.0',
      '--env',
      `PUBLIC_BASE_URL=${BASE_URL}`,
      IMAGE,
    ])

    await waitUntilReady(60_000)

    assert(token !== undefined, 'the provisioned bearer token is missing')
    const user = docker(['exec', CONTAINER, 'id', '-un']).stdout.trim()
    assert(user === 'bun', `the application must run as the non-root bun user, got "${user}"`)

    const created = await register(token, VALID_SCHEMA)
    assert(created.status === 201, `expected 201 for a valid schema, got ${created.status}`)
    const location = created.headers.get('location')
    const createdBody = (await created.json()) as DocumentMetadata
    assert(createdBody.data.url === location, 'the Location header must be the hosted URL')
    assert(
      createdBody.data.url.startsWith(`${BASE_URL}/api/v1/schema-documents/`),
      `unexpected hosted URL: ${createdBody.data.url}`,
    )
    assert(
      createdBody.data.integrity.startsWith('sha256-'),
      `unexpected integrity pin: ${createdBody.data.integrity}`,
    )

    const content = await fetch(createdBody.data.url)
    assert(content.status === 200, `expected 200 from the hosted URL, got ${content.status}`)
    assert(
      (await content.text()) === VALID_SCHEMA,
      'the hosted document bytes differ from the registered bytes',
    )

    const replayed = await register(token, VALID_SCHEMA)
    assert(replayed.status === 200, `expected 200 for a replay, got ${replayed.status}`)
    const replayedBody = (await replayed.json()) as DocumentMetadata
    assert(replayedBody.data.id === createdBody.data.id, 'the replay must return the same document')

    const rejected = await register(token, INVALID_SCHEMA)
    const rejectedBody = (await rejected.json()) as ErrorBody
    assert(
      rejected.status >= 400 && rejected.status < 500,
      `expected a 4xx for the unsupported keyword, got ${rejected.status}`,
    )
    assert(
      rejectedBody.error.code !== 'internal_error',
      'the unsupported keyword must not be reported as an internal error',
    )

    // The launcher creates the private base directory on the first sandbox run
    // and cleans up the per-child directory afterwards.
    const sandboxDirectory = join(directory, '.attestbook-sandbox')
    assert(existsSync(sandboxDirectory), 'the sandbox temporary directory was not provisioned')
    const mode = statSync(sandboxDirectory).mode & 0o777
    assert(mode === 0o700, `the sandbox temporary directory mode is ${mode.toString(8)}, not 700`)

    const logsResult = docker(['logs', CONTAINER])
    const logs = `${logsResult.stdout}\n${logsResult.stderr}`
    assert(
      !logs.includes('unhandled request error'),
      'the server logged an unhandled request error during schema registration',
    )

    failed = false
  } finally {
    if (failed) {
      const logsResult = docker(['logs', CONTAINER], true)
      console.error(logsResult.stdout)
      console.error(logsResult.stderr)
    }
    docker(['rm', '--force', CONTAINER], true)
    rmSync(directory, { recursive: true, force: true })
  }
}

await run()
console.log(`schema registration regression passed in ${IMAGE}`)
