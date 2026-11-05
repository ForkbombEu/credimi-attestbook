import { describe, expect, test } from 'bun:test'

import { validateSchemaDocuments } from './schema'
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
    const outcome = validateSchemaDocuments({
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
    const outcome = validateSchemaDocuments({
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
    const outcome = validateSchemaDocuments({
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
    const outcome = validateSchemaDocuments({
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
    const outcome = validateSchemaDocuments({
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
    const outcome = validateSchemaDocuments({
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
    const outcome = validateSchemaDocuments({
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
    const outcome = validateSchemaDocuments({
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
    const outcome = validateSchemaDocuments({
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
    const compile = (content: string) => {
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

    expect(compile(first).status).toBe('PASS')
    const secondOutcome = compile(second)
    expect(secondOutcome.findings.map((entry) => entry.code)).not.toContain('invalid_json_schema')
    expect(secondOutcome.status).toBe('FAIL')
  })

  test('fails an invalid JSON Schema document', async () => {
    const schema = JSON.stringify({ type: 'nonsense' })
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = validateSchemaDocuments({
      references: [jsonSchemaReference(schema)],
      documents: [{ uri: JSON_SCHEMA_URI, content: schema }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.findings.map((entry) => entry.code)).toContain('invalid_json_schema')
  })
})

describe('validateSchemaDocuments integrity and coverage', () => {
  test('does not pass a reference whose document was not supplied', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = validateSchemaDocuments({
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
    const outcome = validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: TYPE_METADATA_URI, content: PID_TYPE_METADATA_TEXT }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.findings.map((entry) => entry.code)).toContain('integrity_mismatch')
  })

  test('reports an unsupported integrity algorithm as inconclusive, not PASS', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const reference = {
      formatIdentifier: 'dc+sd-jwt',
      uri: TYPE_METADATA_URI,
      integrity: 'sha384-abc123',
    }
    const outcome = validateSchemaDocuments({
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
    const outcome = validateSchemaDocuments({
      references: [reference],
      documents: [{ uri: TYPE_METADATA_URI, content }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.findings.map((entry) => entry.code)).toContain('schema_document_too_deep')
  })

  test('fails a supplied document that is not JSON', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = validateSchemaDocuments({
      references: [typeMetadataReference(PID_TYPE_METADATA_TEXT)],
      documents: [{ uri: TYPE_METADATA_URI, content: '{not json' }],
      parsed,
    })

    expect(outcome.status).toBe('FAIL')
    expect(outcome.findings.map((entry) => entry.code)).toContain('invalid_schema_document')
  })
})
