import { describe, expect, test } from 'bun:test'

import { validateSchemaDocuments } from './schema-sandbox'
import { parseSdJwtVc, type ParsedSdJwtVc } from './sd-jwt'
import {
  defaultCredentialClaims,
  issueTestCredential,
  PID_JSON_SCHEMA_TEXT,
  PID_TYPE_METADATA,
  PID_TYPE_METADATA_TEXT,
  sha256Sri,
  TEST_VCT,
} from './test-support'

const TYPE_METADATA_URI = TEST_VCT
const JSON_SCHEMA_URI = 'https://example.org/schemas/pid.json'

async function parseOrThrow(credential: string): Promise<ParsedSdJwtVc> {
  const outcome = await parseSdJwtVc(credential)
  if (!outcome.ok) {
    throw new Error(`fixture credential did not parse: ${outcome.findings[0]?.code ?? 'unknown'}`)
  }
  return outcome.value
}

function typeMetadataReference(content: string) {
  return {
    formatIdentifier: 'dc+sd-jwt',
    uri: TYPE_METADATA_URI,
    integrity: sha256Sri(content),
  }
}

function jsonSchemaReference(content: string) {
  return {
    formatIdentifier: 'dc+sd-jwt',
    uri: JSON_SCHEMA_URI,
    integrity: sha256Sri(content),
  }
}

describe('validateSchemaDocuments with SD-JWT VC Type Metadata', () => {
  test('passes a credential that satisfies every declared claim', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = await validateSchemaDocuments({
      references: [typeMetadataReference(PID_TYPE_METADATA_TEXT)],
      documents: [{ uri: TYPE_METADATA_URI, content: PID_TYPE_METADATA_TEXT }],
      parsed,
    })

    expect(outcome.status).toBe('PASS')
    expect(outcome.findings).toEqual([])
    expect(outcome.schemaReferences).toEqual([
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: TYPE_METADATA_URI,
        integrity: sha256Sri(PID_TYPE_METADATA_TEXT),
        kind: 'type_metadata',
        applied: true,
      },
    ])
  })

  test('fails a credential that is missing a mandatory claim', async () => {
    const claims = defaultCredentialClaims()
    delete claims.birthdate
    const parsed = await parseOrThrow(await issueTestCredential({ claims }))
    const outcome = await validateSchemaDocuments({
      references: [typeMetadataReference(PID_TYPE_METADATA_TEXT)],
      documents: [{ uri: TYPE_METADATA_URI, content: PID_TYPE_METADATA_TEXT }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    const finding = outcome.findings.find((entry) => entry.code === 'missing_mandatory_claim')
    expect(finding?.path).toBe('/birthdate')
    expect(finding?.severity).toBe('error')
  })

  test('fails a claim the type metadata forbids disclosing', async () => {
    const parsed = await parseOrThrow(
      await issueTestCredential({
        selectiveClaims: ['given_name', 'family_name', 'birthdate', 'age'],
      }),
    )
    const outcome = await validateSchemaDocuments({
      references: [typeMetadataReference(PID_TYPE_METADATA_TEXT)],
      documents: [{ uri: TYPE_METADATA_URI, content: PID_TYPE_METADATA_TEXT }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    const finding = outcome.findings.find(
      (entry) => entry.code === 'claim_must_not_be_selectively_disclosable',
    )
    expect(finding?.path).toBe('/age')
  })

  test('warns about a claim the type metadata does not declare', async () => {
    const metadata = JSON.stringify({
      ...PID_TYPE_METADATA,
      claims: PID_TYPE_METADATA.claims.filter((claim) => claim.path[0] !== 'age'),
    })
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = await validateSchemaDocuments({
      references: [typeMetadataReference(metadata)],
      documents: [{ uri: TYPE_METADATA_URI, content: metadata }],
      parsed,
    })

    expect(outcome.status).toBe('INCONCLUSIVE')
    const finding = outcome.findings.find((entry) => entry.code === 'undeclared_claim')
    expect(finding?.path).toBe('/age')
    expect(finding?.severity).toBe('warning')
  })

  test('fails when the type metadata vct does not match the credential vct', async () => {
    const metadata = JSON.stringify({ ...PID_TYPE_METADATA, vct: 'https://example.org/vct/other' })
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = await validateSchemaDocuments({
      references: [typeMetadataReference(metadata)],
      documents: [{ uri: TYPE_METADATA_URI, content: metadata }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.findings.map((entry) => entry.code)).toContain('vct_mismatch')
  })

  test('fails an invalid Type Metadata document', async () => {
    const metadata = JSON.stringify({ vct: TEST_VCT, claims: 'not-an-array' })
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = await validateSchemaDocuments({
      references: [typeMetadataReference(metadata)],
      documents: [{ uri: TYPE_METADATA_URI, content: metadata }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.findings.map((entry) => entry.code)).toContain('invalid_type_metadata')
  })
})

describe('validateSchemaDocuments with JSON Schema 2020-12', () => {
  test('passes a credential that satisfies the schema', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = await validateSchemaDocuments({
      references: [jsonSchemaReference(PID_JSON_SCHEMA_TEXT)],
      documents: [{ uri: JSON_SCHEMA_URI, content: PID_JSON_SCHEMA_TEXT }],
      parsed,
    })

    expect(outcome.status).toBe('PASS')
    expect(outcome.findings).toEqual([])
    expect(outcome.schemaReferences[0]?.kind).toBe('json_schema')
  })

  test('fails a missing required attribute with its path', async () => {
    const claims = defaultCredentialClaims()
    delete claims.birthdate
    const parsed = await parseOrThrow(await issueTestCredential({ claims }))
    const outcome = await validateSchemaDocuments({
      references: [jsonSchemaReference(PID_JSON_SCHEMA_TEXT)],
      documents: [{ uri: JSON_SCHEMA_URI, content: PID_JSON_SCHEMA_TEXT }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    const finding = outcome.findings.find((entry) => entry.code === 'schema_violation')
    expect(finding?.severity).toBe('error')
    expect(finding?.expected).toBe('required')
  })

  test('fails a wrong attribute type with its path', async () => {
    const parsed = await parseOrThrow(
      await issueTestCredential({ claims: defaultCredentialClaims({ age: 'thirty' }) }),
    )
    const outcome = await validateSchemaDocuments({
      references: [jsonSchemaReference(PID_JSON_SCHEMA_TEXT)],
      documents: [{ uri: JSON_SCHEMA_URI, content: PID_JSON_SCHEMA_TEXT }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    const finding = outcome.findings.find((entry) => entry.code === 'schema_violation')
    expect(finding?.path).toBe('/age')
    expect(finding?.expected).toBe('type')
  })

  test('does not leak compiled $id state between requests', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const first = JSON.stringify({
      $id: 'https://example.org/schema/reused',
      type: 'object',
    })
    const second = JSON.stringify({
      $id: 'https://example.org/schema/reused',
      type: 'object',
      required: ['attribute_that_is_absent'],
    })
    const compile = async (content: string) => {
      const reference = {
        formatIdentifier: 'dc+sd-jwt',
        uri: JSON_SCHEMA_URI,
        integrity: sha256Sri(content),
      }
      return validateSchemaDocuments({
        references: [reference],
        documents: [{ uri: JSON_SCHEMA_URI, content }],
        parsed,
      })
    }

    expect((await compile(first)).status).toBe('PASS')
    const secondOutcome = await compile(second)
    expect(secondOutcome.findings.map((entry) => entry.code)).not.toContain('invalid_json_schema')
    expect(secondOutcome.status).toBe('FAIL')
  })

  test('reports a schema that exceeds the sandbox time limit as not tested', async () => {
    const anyOf = Array.from({ length: 7_000 }, (_, index) => ({ const: index }))
    const schema = JSON.stringify({
      type: 'object',
      properties: { values: { type: 'array', items: { anyOf } } },
    })
    const claims = defaultCredentialClaims({
      values: Array.from({ length: 1_000 }, (_, index) => index),
    })
    const parsed = await parseOrThrow(await issueTestCredential({ claims, selectiveClaims: [] }))
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: JSON_SCHEMA_URI,
      integrity: sha256Sri(schema),
    }
    const outcome = await validateSchemaDocuments(
      {
        references: [reference],
        documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
        parsed,
      },
      { timeoutMs: 100 },
    )

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('schema_evaluation_timeout')
    expect(outcome.schemaReferences[0]?.applied).toBe(false)
  })

  test('kills a worker that exceeds its memory limit', async () => {
    if (process.platform !== 'linux') {
      return
    }
    const anyOf = Array.from({ length: 7_000 }, (_, index) => ({ const: index }))
    const schema = JSON.stringify({
      type: 'object',
      properties: { values: { type: 'array', items: { anyOf } } },
    })
    const claims = defaultCredentialClaims({
      values: Array.from({ length: 1_000 }, (_, index) => index),
    })
    const parsed = await parseOrThrow(await issueTestCredential({ claims, selectiveClaims: [] }))
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: JSON_SCHEMA_URI,
      integrity: sha256Sri(schema),
    }
    const outcome = await validateSchemaDocuments(
      {
        references: [reference],
        documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
        parsed,
      },
      { timeoutMs: 5_000, maxRssBytes: 1 * 2 ** 20 },
    )

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain(
      'schema_evaluation_memory_exceeded',
    )
  })

  test('fails an invalid JSON Schema document', async () => {
    const schema = JSON.stringify({ type: 'nonsense' })
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = await validateSchemaDocuments({
      references: [jsonSchemaReference(schema)],
      documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.findings.map((entry) => entry.code)).toContain('invalid_json_schema')
    expect(outcome.schemaReferences[0]?.applied).toBe(false)
  })
})

describe('validateSchemaDocuments integrity and coverage', () => {
  test('does not pass a reference whose document was not supplied', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = await validateSchemaDocuments({
      references: [typeMetadataReference(PID_TYPE_METADATA_TEXT)],
      documents: [],
      parsed,
    })

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('schema_document_not_supplied')
    expect(outcome.schemaReferences[0]?.applied).toBe(false)
  })

  test('fails a document that does not match the pinned integrity value', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: TYPE_METADATA_URI,
      integrity: sha256Sri(`${PID_TYPE_METADATA_TEXT} `),
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: TYPE_METADATA_URI, content: PID_TYPE_METADATA_TEXT }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.findings.map((entry) => entry.code)).toEqual(['integrity_mismatch'])
    expect(outcome.schemaReferences[0]?.applied).toBe(false)
  })

  test('does not compile or apply a schema when the pinned integrity mismatches', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const schema = JSON.stringify({
      type: 'object',
      properties: { given_name: { type: 'number' } },
    })
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: JSON_SCHEMA_URI,
      integrity: sha256Sri(`${schema} `),
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.findings.map((entry) => entry.code)).toEqual(['integrity_mismatch'])
    expect(outcome.findings.some((entry) => entry.code === 'schema_violation')).toBe(false)
  })

  test('does not evaluate a regex keyword that could backtrack catastrophically', async () => {
    const schema = JSON.stringify({
      type: 'object',
      properties: {
        given_name: { type: 'string', pattern: '^(a+)+$' },
      },
    })
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: JSON_SCHEMA_URI,
      integrity: sha256Sri(schema),
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
      parsed: await parseOrThrow(await issueTestCredential()),
    })

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('unsupported_schema_keyword')
    expect(outcome.findings.some((entry) => entry.code === 'schema_violation')).toBe(false)
    expect(outcome.schemaReferences[0]?.applied).toBe(false)
  })

  test('does not silently ignore a format keyword', async () => {
    const schema = JSON.stringify({
      type: 'object',
      properties: { birthdate: { type: 'string', format: 'date' } },
    })
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: JSON_SCHEMA_URI,
      integrity: sha256Sri(schema),
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
      parsed: await parseOrThrow(await issueTestCredential()),
    })

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('unsupported_schema_keyword')
  })

  test('does not silently ignore uniqueItems', async () => {
    const schema = JSON.stringify({
      type: 'object',
      properties: { nicknames: { type: 'array', uniqueItems: true } },
    })
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: JSON_SCHEMA_URI,
      integrity: sha256Sri(schema),
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
      parsed: await parseOrThrow(await issueTestCredential()),
    })

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('unsupported_schema_keyword')
  })

  test('does not execute an unpinned reference', async () => {
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: TYPE_METADATA_URI,
      integrity: null,
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: TYPE_METADATA_URI, content: PID_TYPE_METADATA_TEXT }],
      parsed: await parseOrThrow(await issueTestCredential()),
    })

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('schema_document_unpinned')
    expect(outcome.schemaReferences[0]?.applied).toBe(false)
  })

  test('rejects every $ref route that could hide a regex keyword', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const schemas = [
      {
        'x-hidden': { pattern: '^(a+)+$' },
        properties: { given_name: { $ref: '#/x-hidden' } },
      },
      {
        enum: [{ pattern: '^(a+)+$' }],
        properties: { given_name: { $ref: '#/enum/0' } },
      },
      {
        $defs: { hidden: { $anchor: 'hidden', pattern: '^(a+)+$' } },
        properties: { given_name: { $ref: '#hidden' } },
      },
    ]

    for (const schema of schemas) {
      const content = JSON.stringify(schema)
      const reference = {
        formatIdentifier: 'dc+sd-jwt',
        uri: JSON_SCHEMA_URI,
        integrity: sha256Sri(content),
      }
      const outcome = await validateSchemaDocuments({
        references: [reference],
        documents: [{ uri: JSON_SCHEMA_URI, content }],
        parsed,
      })

      expect(outcome.status).toBe('NOT_TESTED')
      expect(outcome.findings.map((entry) => entry.code)).toContain('unsupported_schema_keyword')
      expect(outcome.findings.some((entry) => entry.code === 'schema_violation')).toBe(false)
    }
  })

  test('rejects cyclic and self-referential schema documents without resolving them', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const schemas = [
      // A root self-reference and a cycle through $defs/definitions are the
      // shapes an eager resolver would recurse on.
      { $ref: '#' },
      {
        $defs: { node: { $ref: '#/$defs/node' } },
        properties: { given_name: { $ref: '#/$defs/node' } },
      },
      {
        definitions: {
          a: { $ref: '#/definitions/b' },
          b: { $ref: '#/definitions/a' },
        },
        properties: { given_name: { $ref: '#/definitions/a' } },
      },
      // Dynamic and recursive reference keywords are unsupported for the same
      // reason: the evaluator cannot prove where they terminate.
      { $dynamicRef: '#node', $dynamicAnchor: 'node' },
      { $recursiveRef: '#' },
    ]

    for (const schema of schemas) {
      const content = JSON.stringify(schema)
      const reference = {
        formatIdentifier: 'dc+sd-jwt',
        uri: JSON_SCHEMA_URI,
        integrity: sha256Sri(content),
      }
      const outcome = await validateSchemaDocuments({
        references: [reference],
        documents: [{ uri: JSON_SCHEMA_URI, content }],
        parsed,
      })

      expect(outcome.status).toBe('NOT_TESTED')
      expect(outcome.findings.map((entry) => entry.code)).toContain('unsupported_schema_keyword')
      expect(outcome.findings.some((entry) => entry.code === 'schema_violation')).toBe(false)
    }
  })

  test('rejects legacy dependencies schemas that could hide a regex', async () => {
    const schema = JSON.stringify({
      type: 'object',
      dependencies: {
        given_name: {
          properties: { given_name: { pattern: '^(a+)+$' } },
        },
      },
    })
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: JSON_SCHEMA_URI,
      integrity: sha256Sri(schema),
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
      parsed: await parseOrThrow(await issueTestCredential()),
    })

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('unsupported_schema_keyword')
    expect(outcome.findings.some((entry) => entry.code === 'schema_violation')).toBe(false)
  })

  test('reports a document that mixes vct with JSON Schema keywords as ambiguous', async () => {
    const schema = JSON.stringify({
      vct: TEST_VCT,
      type: 'object',
      properties: { given_name: { type: 'number' } },
    })
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: TYPE_METADATA_URI,
      integrity: sha256Sri(schema),
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: TYPE_METADATA_URI, content: schema }],
      parsed: await parseOrThrow(await issueTestCredential()),
    })

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('ambiguous_schema_document')
    expect(outcome.schemaReferences[0]?.applied).toBe(false)
  })

  test('reports a vct document with a $ref as ambiguous', async () => {
    const schema = JSON.stringify({
      vct: TEST_VCT,
      $ref: '#/x-hidden',
      'x-hidden': { pattern: '^(a+)+$' },
    })
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: TYPE_METADATA_URI,
      integrity: sha256Sri(schema),
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: TYPE_METADATA_URI, content: schema }],
      parsed: await parseOrThrow(await issueTestCredential()),
    })

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('ambiguous_schema_document')
  })

  test('reports a non-2020-12 schema dialect as not tested', async () => {
    const schema = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      type: 'object',
    })
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: JSON_SCHEMA_URI,
      integrity: sha256Sri(schema),
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
      parsed: await parseOrThrow(await issueTestCredential()),
    })

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('unsupported_schema_dialect')
    expect(outcome.schemaReferences[0]?.applied).toBe(false)
  })

  test('reports unknown schema keywords as not tested instead of ignoring them', async () => {
    const schema = JSON.stringify({
      type: 'object',
      propertyRequires: { given_name: 'x' },
    })
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: JSON_SCHEMA_URI,
      integrity: sha256Sri(schema),
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
      parsed: await parseOrThrow(await issueTestCredential()),
    })

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('unsupported_schema_keyword')
    expect(outcome.schemaReferences[0]?.applied).toBe(false)
  })

  test('does not execute schema checks over an oversized credential claim set', async () => {
    const parsed = await parseOrThrow(
      await issueTestCredential({
        claims: defaultCredentialClaims({
          values: Array.from({ length: 5_000 }, (_, index) => index),
        }),
        selectiveClaims: [],
      }),
    )
    const outcome = await validateSchemaDocuments({
      references: [typeMetadataReference(PID_TYPE_METADATA_TEXT)],
      documents: [{ uri: TYPE_METADATA_URI, content: PID_TYPE_METADATA_TEXT }],
      parsed,
    })

    expect(outcome.status).toBe('NOT_TESTED')
    expect(outcome.findings.map((entry) => entry.code)).toContain('credential_claims_too_many')
    expect(outcome.schemaReferences[0]?.applied).toBe(false)
  })

  test('reports an unresolved type metadata extends chain as inconclusive', async () => {
    const metadata = JSON.stringify({
      ...PID_TYPE_METADATA,
      extends: 'https://example.org/vct/parent',
    })
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: TYPE_METADATA_URI,
      integrity: sha256Sri(metadata),
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: TYPE_METADATA_URI, content: metadata }],
      parsed: await parseOrThrow(await issueTestCredential()),
    })

    expect(outcome.status).toBe('INCONCLUSIVE')
    expect(outcome.findings.map((entry) => entry.code)).toContain(
      'type_metadata_extends_unsupported',
    )
  })

  test('reports an unsupported integrity algorithm as inconclusive, not PASS', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: TYPE_METADATA_URI,
      integrity: 'sha384-abc123',
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: TYPE_METADATA_URI, content: PID_TYPE_METADATA_TEXT }],
      parsed,
    })

    expect(outcome.status).toBe('INCONCLUSIVE')
    expect(outcome.findings.map((entry) => entry.code)).toContain('unsupported_integrity_algorithm')
  })

  test('fails a schema document nested beyond the defensive depth bound', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    let nested: Record<string, unknown> = { type: 'object', properties: {} }
    for (let depth = 0; depth < 80; depth += 1) {
      nested = { type: 'object', properties: { child: nested } }
    }
    const content = JSON.stringify(nested)
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: TYPE_METADATA_URI,
      integrity: sha256Sri(content),
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: TYPE_METADATA_URI, content }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.findings.map((entry) => entry.code)).toContain('schema_document_too_deep')
  })

  test('fails a supplied document that is not JSON when its pin matches', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const content = '{not json'
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: TYPE_METADATA_URI,
      integrity: sha256Sri(content),
    }
    const outcome = await validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: TYPE_METADATA_URI, content }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.findings.map((entry) => entry.code)).toContain('invalid_schema_document')
  })

  test('reports an integrity mismatch before parsing invalid JSON', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = await validateSchemaDocuments({
      references: [typeMetadataReference(PID_TYPE_METADATA_TEXT)],
      documents: [{ uri: TYPE_METADATA_URI, content: '{not json' }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.findings.map((entry) => entry.code)).toEqual(['integrity_mismatch'])
  })
})
