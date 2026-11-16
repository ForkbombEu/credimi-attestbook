import { describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SANDBOX_CHILD_ENVIRONMENT_KEYS,
  runSandboxChild,
  runSchemaSandbox,
  sandboxBaseRefusal,
  validateSchemaDocuments,
} from './schema-sandbox'
import { parseSdJwtVc, type ParsedSdJwtVc } from './sd-jwt'
import { defaultCredentialClaims, issueTestCredential, sha256Sri, TEST_VCT } from './test-support'

const JSON_SCHEMA_URI = 'https://example.org/schemas/sandbox.json'
const TYPE_METADATA_URI = TEST_VCT

function fixture(name: string): string {
  return fileURLToPath(new URL(`./test-fixtures/${name}`, import.meta.url))
}

async function parseOrThrow(credential: string): Promise<ParsedSdJwtVc> {
  const outcome = await parseSdJwtVc(credential)
  if (!outcome.ok) {
    throw new Error(`fixture credential did not parse: ${outcome.findings[0]?.code ?? 'unknown'}`)
  }
  return outcome.value
}

function jsonSchemaReference(content: string) {
  return {
    formatIdentifier: 'dc+sd-jwt',
    uri: JSON_SCHEMA_URI,
    integrity: sha256Sri(content),
  }
}

function typeMetadataReference(content: string) {
  return {
    formatIdentifier: 'dc+sd-jwt',
    uri: TYPE_METADATA_URI,
    integrity: sha256Sri(content),
  }
}

function hostileJsonSchema(): string {
  return JSON.stringify({
    type: 'object',
    properties: {
      given_name: {
        anyOf: Array.from({ length: 950 }, () => ({ minLength: 600_000 })),
      },
    },
  })
}

function hostileTypeMetadata(): string {
  return JSON.stringify({ vct: TEST_VCT, claims: [] })
}

function deepChain(depth: number): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let node = root
  for (let index = 0; index < depth; index += 1) {
    const child: Record<string, unknown> = {}
    node.child = child
    node = child
  }
  return root
}

describe('schema sandbox', () => {
  test('times out a hostile JSON Schema without blocking the event loop', async () => {
    const schema = hostileJsonSchema()
    const credential = await issueTestCredential({
      claims: defaultCredentialClaims({ given_name: 'a'.repeat(370_000) }),
      selectiveClaims: [],
    })
    const parsed = await parseOrThrow(credential)
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 5)
    const started = Date.now()
    const outcome = await validateSchemaDocuments(
      {
        references: [jsonSchemaReference(schema)],
        documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
        parsed,
      },
      { timeoutMs: 50 },
    )
    clearInterval(timer)
    const elapsed = Date.now() - started

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('schema_evaluation_timeout')
    expect(outcome.schemaReferences[0]?.applied).toBe(false)
    expect(elapsed).toBeLessThan(2_000)
    expect(ticks).toBeGreaterThanOrEqual(5)
  })

  test('times out the quadratic Type Metadata de-duplication path', async () => {
    const metadata = hostileTypeMetadata()
    const nested = Array.from({ length: 64 }, () => deepChain(60))
    const credential = await issueTestCredential({
      claims: defaultCredentialClaims({ nested }),
      selectiveClaims: [],
    })
    const parsed = await parseOrThrow(credential)
    const outcome = await validateSchemaDocuments(
      {
        references: [typeMetadataReference(metadata)],
        documents: [{ uri: TYPE_METADATA_URI, content: metadata }],
        parsed,
      },
      { timeoutMs: 50 },
    )

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('schema_evaluation_timeout')
  })

  test('kills a child that exceeds the memory limit', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const parsed = await parseOrThrow(await issueTestCredential())
    const schema = JSON.stringify({ type: 'object' })
    const started = Date.now()
    const outcome = await validateSchemaDocuments(
      {
        references: [jsonSchemaReference(schema)],
        documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
        parsed,
      },
      {
        entry: fixture('allocating-entry.ts'),
        timeoutMs: 10_000,
        maxRssBytes: 128 * 2 ** 20,
      },
    )

    expect(Date.now() - started).toBeLessThan(5_000)
    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain(
      'schema_evaluation_memory_exceeded',
    )
  })

  test('kills a child that exceeds the output cap', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const schema = JSON.stringify({ type: 'object' })
    const outcome = await validateSchemaDocuments(
      {
        references: [jsonSchemaReference(schema)],
        documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
        parsed,
      },
      {
        entry: fixture('large-output-entry.ts'),
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
      },
    )

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain(
      'schema_evaluation_output_exceeded',
    )
  })

  test.each(['malformed-output-entry.ts', 'failing-entry.ts'])(
    'reports a broken sandbox child as failed (%s)',
    async (entry) => {
      const parsed = await parseOrThrow(await issueTestCredential())
      const schema = JSON.stringify({ type: 'object' })
      const outcome = await validateSchemaDocuments(
        {
          references: [jsonSchemaReference(schema)],
          documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
          parsed,
        },
        { entry: fixture(entry), timeoutMs: 2_000 },
      )

      expect(outcome.status).toBe('NOT_TESTED')
      expect(outcome.findings.map((found) => found.code)).toContain('schema_evaluation_failed')
    },
  )

  test('rejects a concurrent run when the sandbox is busy', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const schema = JSON.stringify({ type: 'object' })
    const options = {
      refs: [jsonSchemaReference(schema)],
      docs: [{ uri: JSON_SCHEMA_URI, content: schema }],
      parsed,
    }
    const limits = { entry: fixture('slow-entry.ts'), timeoutMs: 700, maxConcurrent: 1 }

    const first = validateSchemaDocuments(
      { references: options.refs, documents: options.docs, parsed: options.parsed },
      limits,
    )
    const second = validateSchemaDocuments(
      { references: options.refs, documents: options.docs, parsed: options.parsed },
      limits,
    )
    const [firstOutcome, secondOutcome] = await Promise.all([first, second])

    expect(firstOutcome.findings.map((entry) => entry.code)).toContain('schema_evaluation_timeout')
    expect(secondOutcome.findings.map((entry) => entry.code)).toContain('schema_sandbox_busy')
  })

  test('fails closed on a platform without an RSS watchdog', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const schema = JSON.stringify({ type: 'object' })
    const outcome = await validateSchemaDocuments(
      {
        references: [jsonSchemaReference(schema)],
        documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
        parsed,
      },
      { platform: 'darwin' },
    )

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('schema_sandbox_unavailable')
  })

  test('keeps an integrity failure while another reference times out', async () => {
    const hostile = hostileJsonSchema()
    const mismatch = JSON.stringify({ type: 'object' })
    const hostileReference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: JSON_SCHEMA_URI,
      integrity: sha256Sri(hostile),
    }
    const mismatchReference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: 'https://example.org/schemas/mismatch.json',
      integrity: sha256Sri(`${mismatch} `),
    }
    const parsed = await parseOrThrow(
      await issueTestCredential({
        claims: defaultCredentialClaims({ given_name: 'a'.repeat(370_000) }),
        selectiveClaims: [],
      }),
    )
    const outcome = await validateSchemaDocuments(
      {
        references: [mismatchReference, hostileReference],
        documents: [
          { uri: mismatchReference.uri, content: mismatch },
          { uri: JSON_SCHEMA_URI, content: hostile },
        ],
        parsed,
      },
      { timeoutMs: 50 },
    )

    expect(outcome.status).toBe('FAIL')
    const codes = outcome.findings.map((entry) => entry.code)
    expect(codes).toContain('integrity_mismatch')
    expect(codes).toContain('schema_evaluation_timeout')
  })
})

async function captureErrors<T>(
  run: () => Promise<T>,
): Promise<{ result: T; logs: readonly (readonly unknown[])[] }> {
  const logs: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    logs.push(args)
  }
  try {
    return { result: await run(), logs }
  } finally {
    console.error = original
  }
}

describe('sandbox child environment', () => {
  test('passes only one private writable directory to the child', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'attestbook-sandbox-env-'))
    const secretName = 'ATTESTBOOK_SANDBOX_TEST_SECRET'
    const previous = process.env[secretName]
    process.env[secretName] = 'must-not-reach-the-child'
    try {
      const base = join(root, 'base')
      const outcome = await runSandboxChild(
        fixture('env-entry.ts'),
        {},
        {
          tempDir: base,
          timeoutMs: 5_000,
        },
      )

      expect(outcome.kind).toBe('ok')
      if (outcome.kind !== 'ok') {
        return
      }
      const { env, tmpMode } = JSON.parse(outcome.raw) as {
        env: Record<string, string>
        tmpMode: number | null
      }
      expect(Object.keys(env).sort()).toEqual([...SANDBOX_CHILD_ENVIRONMENT_KEYS].sort())
      const values = Object.values(env)
      expect(new Set(values).size).toBe(1)
      expect(values[0]?.startsWith(`${base}/`)).toBe(true)
      expect(env[secretName]).toBeUndefined()
      // The per-child directory is private, and it is removed afterwards. The
      // freshly created base gets the same private mode.
      expect(tmpMode).toBe(0o700)
      expect(statSync(base).mode & 0o777).toBe(0o700)
      expect(readdirSync(base)).toEqual([])
    } finally {
      if (previous === undefined) {
        delete process.env[secretName]
      } else {
        process.env[secretName] = previous
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('leaves an existing base directory mode untouched', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'attestbook-sandbox-mode-'))
    try {
      const base = join(root, 'base')
      mkdirSync(base)
      chmodSync(base, 0o755)
      const outcome = await runSandboxChild(
        fixture('env-entry.ts'),
        {},
        { tempDir: base, timeoutMs: 5_000 },
      )

      expect(outcome.kind).toBe('ok')
      if (outcome.kind !== 'ok') {
        return
      }
      const { tmpMode } = JSON.parse(outcome.raw) as { tmpMode: number | null }
      expect(tmpMode).toBe(0o700)
      expect(statSync(base).mode & 0o777).toBe(0o755)
      expect(readdirSync(base)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('leaves an owned sticky base directory mode untouched', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'attestbook-sandbox-sticky-'))
    try {
      const base = join(root, 'base')
      mkdirSync(base)
      chmodSync(base, 0o1777)
      const outcome = await runSandboxChild(
        fixture('env-entry.ts'),
        {},
        { tempDir: base, timeoutMs: 5_000 },
      )

      expect(outcome.kind).toBe('ok')
      expect(statSync(base).mode & 0o7777).toBe(0o1777)
      expect(readdirSync(base)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('accepts the real root-owned sticky temporary directory', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const info = lstatSync('/tmp')
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o1000) === 0) {
      return
    }
    const before = info.mode & 0o7777
    const outcome = await runSandboxChild(
      fixture('env-entry.ts'),
      {},
      { tempDir: '/tmp', timeoutMs: 5_000 },
    )

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') {
      return
    }
    const { tmpMode } = JSON.parse(outcome.raw) as { tmpMode: number | null }
    expect(tmpMode).toBe(0o700)
    expect(statSync('/tmp').mode & 0o7777).toBe(before)
  })

  test('refuses a base that is a symlink without writing through it', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'attestbook-sandbox-link-'))
    try {
      const realDirectory = join(root, 'real')
      const link = join(root, 'link')
      mkdirSync(realDirectory)
      symlinkSync(realDirectory, link, 'dir')
      const { result, logs } = await captureErrors(() =>
        runSandboxChild(fixture('env-entry.ts'), {}, { tempDir: link, timeoutMs: 5_000 }),
      )

      expect(result).toMatchObject({ kind: 'failed', reason: 'temp_dir_unavailable' })
      const serialized = JSON.stringify(logs)
      expect(serialized).toContain('temp_dir_unavailable')
      expect(serialized).not.toContain(link)
      expect(readdirSync(realDirectory)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('fails closed when the temporary directory cannot be created', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'attestbook-sandbox-blocked-'))
    const blocked = join(root, 'blocked')
    writeFileSync(blocked, 'not a directory')
    try {
      const { result, logs } = await captureErrors(() =>
        runSandboxChild(
          fixture('env-entry.ts'),
          {},
          {
            tempDir: join(blocked, 'sandbox'),
            timeoutMs: 5_000,
          },
        ),
      )

      expect(result).toMatchObject({ kind: 'failed', reason: 'temp_dir_unavailable' })
      const serialized = JSON.stringify(logs)
      expect(serialized).toContain('temp_dir_unavailable')
      expect(serialized).not.toContain('not a directory')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('classifies a write-denied child startup without logging its stderr', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'attestbook-sandbox-denied-'))
    try {
      const base = join(root, 'base')
      const { result, logs } = await captureErrors(() =>
        runSandboxChild(
          fixture('write-denied-entry.ts'),
          {},
          {
            tempDir: base,
            timeoutMs: 5_000,
          },
        ),
      )

      expect(result).toMatchObject({
        kind: 'failed',
        reason: 'child_exit',
        exitCode: 1,
        stderrClass: 'write_denied',
      })
      const serialized = JSON.stringify(logs)
      expect(serialized).toContain('write_denied')
      expect(serialized).not.toContain('AccessDenied')
      expect(readdirSync(base)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('sandbox base policy', () => {
  const ownedDirectory = {
    isDirectory: true,
    isSymbolicLink: false,
    uid: 1000,
    mode: 0o40755,
  }

  test('accepts a directory owned by the runtime user', () => {
    expect(sandboxBaseRefusal(ownedDirectory, 1000)).toBeNull()
  })

  test('accepts a root-owned sticky directory like /tmp', () => {
    expect(sandboxBaseRefusal({ ...ownedDirectory, uid: 0, mode: 0o41777 }, 1000)).toBeNull()
  })

  test('refuses a sticky directory owned by another account', () => {
    expect(sandboxBaseRefusal({ ...ownedDirectory, uid: 1001, mode: 0o41777 }, 1000)).not.toBeNull()
  })

  test('refuses a world-writable directory owned by another account', () => {
    expect(sandboxBaseRefusal({ ...ownedDirectory, uid: 1001, mode: 0o40777 }, 1000)).not.toBeNull()
  })

  test('refuses a root-owned world-writable directory that is not sticky', () => {
    expect(sandboxBaseRefusal({ ...ownedDirectory, uid: 0, mode: 0o40777 }, 1000)).not.toBeNull()
  })

  test('refuses a symlink', () => {
    expect(
      sandboxBaseRefusal(
        { isDirectory: false, isSymbolicLink: true, uid: 1000, mode: 0o120777 },
        1000,
      ),
    ).not.toBeNull()
  })

  test('refuses a regular file', () => {
    expect(
      sandboxBaseRefusal(
        { isDirectory: false, isSymbolicLink: false, uid: 1000, mode: 0o100644 },
        1000,
      ),
    ).not.toBeNull()
  })

  test('refuses when the runtime user is unknown', () => {
    expect(sandboxBaseRefusal(ownedDirectory, undefined)).not.toBeNull()
  })
})

describe('built sandbox worker', () => {
  test('starts with the private environment and compiles a minimal JSON Schema', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'attestbook-sandbox-built-'))
    try {
      const entrySource = fileURLToPath(new URL('./schema-sandbox-entry.ts', import.meta.url))
      const outdir = join(root, 'dist')
      const built = await Bun.build({ entrypoints: [entrySource], outdir, target: 'bun' })
      expect(built.success).toBe(true)
      const entry = join(outdir, 'schema-sandbox-entry.js')
      expect(existsSync(entry)).toBe(true)

      const document = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { given_name: { type: 'string' } },
      }
      const outcome = await runSchemaSandbox(
        {
          items: [
            {
              index: 0,
              reference: {
                formatIdentifier: 'dc+sd-jwt',
                uri: 'urn:attestbook:test',
                integrity: null,
              },
              kind: 'json_schema',
              document,
              integrityFindings: [],
            },
          ],
          input: { claims: { given_name: 'Ada' }, packedPayload: {}, disclosureMap: {}, vct: '' },
        },
        { entry, tempDir: join(root, 'sandbox'), timeoutMs: 10_000 },
      )

      expect(outcome.kind).toBe('ok')
      if (outcome.kind !== 'ok') {
        return
      }
      expect(outcome.results[0]?.application.applied).toBe(true)
      expect(outcome.results[0]?.application.status).toBe('PASS')
      expect(readdirSync(join(root, 'sandbox'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
