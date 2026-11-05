import { describe, expect, test } from 'bun:test'

import type { AdapterResult, CanonicalSchemaMeta } from './index'
import { parseOwfSchemaMeta, resolveSchemaMetaReferences } from './index'
import { buildOwfWire, SCHEMA_URI, sha256Sri, TEST_SCHEMA_DOCUMENT } from './test/fixtures'

function failureDiagnostics(result: AdapterResult<unknown>) {
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('expected the adapter call to fail')
  }
  return result.diagnostics
}

function successValue<T>(result: AdapterResult<T>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(`expected success, got: ${JSON.stringify(result.diagnostics)}`)
  }
  return result.value
}

const readOwf = (): CanonicalSchemaMeta => successValue(parseOwfSchemaMeta(buildOwfWire()))

const resolveFromContent =
  (content: string) =>
  (uri: string): Promise<{ content: string; contentType: string }> => {
    expect(uri).toBe(SCHEMA_URI)
    return Promise.resolve({ content, contentType: 'application/schema+json' })
  }

describe('OWF-backed schema reference resolution', () => {
  test('resolves and verifies a sha256 SRI reference through OWF', async () => {
    const resolved = successValue(
      await resolveSchemaMetaReferences({
        schemaMeta: readOwf(),
        resolve: resolveFromContent(TEST_SCHEMA_DOCUMENT),
      }),
    )

    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.integrity).toBe(sha256Sri(TEST_SCHEMA_DOCUMENT))
    expect(resolved[0]?.parsedSchema).toEqual(
      JSON.parse(TEST_SCHEMA_DOCUMENT) as Record<string, unknown>,
    )
  })

  test('rejects content whose SRI does not match', async () => {
    const diagnostics = failureDiagnostics(
      await resolveSchemaMetaReferences({
        schemaMeta: readOwf(),
        resolve: resolveFromContent('{"type":"string"}'),
      }),
    )

    expect(diagnostics.map((entry) => entry.code)).toContain('integrity_mismatch')
  })

  test('reports sha384 SRI as an unsupported operation', async () => {
    const canonical: CanonicalSchemaMeta = {
      ...readOwf(),
      schemaURIs: [
        {
          formatIdentifier: 'dc+sd-jwt',
          uri: SCHEMA_URI,
          integrity: `sha384-${sha256Sri('x').slice('sha256-'.length)}`,
          meta: { vct: 'eu.example.gym.1' },
        },
      ],
    }

    const diagnostics = failureDiagnostics(
      await resolveSchemaMetaReferences({
        schemaMeta: canonical,
        resolve: resolveFromContent(TEST_SCHEMA_DOCUMENT),
      }),
    )

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'unsupported_operation',
        code: 'unsupported_sri_algorithm',
        path: 'schemaURIs.0.integrity',
      }),
    ])
  })

  test('reports a format OWF cannot resolve as an unsupported operation', async () => {
    const diagnostics = failureDiagnostics(
      await resolveSchemaMetaReferences({
        schemaMeta: readOwf(),
        selectedFormats: ['jwt_vc_json'],
        resolve: resolveFromContent(TEST_SCHEMA_DOCUMENT),
      }),
    )

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'unsupported_operation',
        code: 'unsupported_format',
        path: 'selectedFormats.0',
      }),
    ])
  })

  test('wraps resolver failures as invalid input', async () => {
    const diagnostics = failureDiagnostics(
      await resolveSchemaMetaReferences({
        schemaMeta: readOwf(),
        resolve: () => Promise.reject(new Error('network blocked')),
      }),
    )

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'invalid_input',
        code: 'invalid_reference',
      }),
    ])
  })

  test('reports an OWF-unrepresentable canonical document', async () => {
    const canonical = readOwf()
    const { id, ...withoutId } = canonical
    expect(id).toBeDefined()

    const diagnostics = failureDiagnostics(
      await resolveSchemaMetaReferences({
        schemaMeta: withoutId,
        resolve: resolveFromContent(TEST_SCHEMA_DOCUMENT),
      }),
    )

    expect(diagnostics).toEqual([
      expect.objectContaining({
        kind: 'unsupported_operation',
        code: 'unsupported_schema_meta_member',
        path: 'id',
      }),
    ])
  })
})
