import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

import { validateSchemaDocuments } from './schema-sandbox'
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
