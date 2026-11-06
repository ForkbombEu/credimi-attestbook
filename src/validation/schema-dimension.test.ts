// Schema-dimension execution evidence (issue #33 review fix).
//
// A schema reference whose integrity pin cannot be verified is not applied. If
// no reference was applied, no schema check ran and the dimension must be
// NOT_TESTED with `executed: false`, never `executed: true`.

import { afterEach, describe, expect, test } from 'bun:test'

import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'

import { limitationsFromDimensions } from './dimensions'
import { CredentialValidator, schemaDimensionFromOutcome } from './engine'
import { validateSchemaDocuments } from './schema-sandbox'
import { parseSdJwtVc, type ParsedSdJwtVc } from './sd-jwt'
import {
  issueTestCredential,
  PID_JSON_SCHEMA_TEXT,
  PID_TYPE_METADATA_TEXT,
  seedPublishedRulebook,
  sha256Sri,
  TEST_VCT,
  type SeededRulebook,
} from './test-support'
import type { ValidateCredentialInput } from './types'

const JSON_SCHEMA_URI = 'https://example.org/schemas/pid.json'

async function parseOrThrow(credential: string): Promise<ParsedSdJwtVc> {
  const outcome = await parseSdJwtVc(credential)
  if (!outcome.ok) {
    throw new Error(`fixture credential did not parse: ${outcome.findings[0]?.code ?? 'unknown'}`)
  }
  return outcome.value
}

describe('schemaDimensionFromOutcome', () => {
  test('an unverifiable integrity pin with nothing applied is NOT_TESTED, not executed', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = await validateSchemaDocuments({
      references: [
        {
          formatIdentifier: 'dc+sd-jwt',
          uri: TEST_VCT,
          integrity: 'sha384-abc123',
        },
      ],
      documents: [{ uri: TEST_VCT, content: PID_TYPE_METADATA_TEXT }],
      parsed,
    })
    const dimension = schemaDimensionFromOutcome(outcome, 1, 1)

    expect(outcome.status).toBe('INCONCLUSIVE')
    expect(dimension.status).toBe('NOT_TESTED')
    expect(dimension.executed).toBe(false)
    expect(dimension.applicable).toBe(true)
    expect(dimension.evidence.details).toMatchObject({
      executed: false,
      applied_documents: 0,
    })
    const limitations = limitationsFromDimensions([dimension])
    expect(limitations.map((entry) => entry.code)).toContain('unsupported_integrity_algorithm')
    expect(limitations.every((entry) => entry.status === 'NOT_TESTED')).toBe(true)
  })

  test('partial application remains executed and INCONCLUSIVE', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = await validateSchemaDocuments({
      references: [
        {
          formatIdentifier: 'dc+sd-jwt',
          uri: JSON_SCHEMA_URI,
          integrity: sha256Sri(PID_JSON_SCHEMA_TEXT),
        },
        {
          formatIdentifier: 'dc+sd-jwt',
          uri: TEST_VCT,
          integrity: sha256Sri(PID_TYPE_METADATA_TEXT),
        },
      ],
      // Only the JSON Schema document is supplied; the Type Metadata reference
      // is not tested.
      documents: [{ uri: JSON_SCHEMA_URI, content: PID_JSON_SCHEMA_TEXT }],
      parsed,
    })
    const dimension = schemaDimensionFromOutcome(outcome, 2, 1)

    expect(outcome.status).toBe('INCONCLUSIVE')
    expect(dimension.status).toBe('INCONCLUSIVE')
    expect(dimension.executed).toBe(true)
    expect(dimension.applicable).toBe(true)
    expect(dimension.evidence.details).toMatchObject({
      executed: true,
      references: 2,
      documents_supplied: 1,
      applied_documents: 1,
    })
  })

  test('a FAIL with nothing applied is still an executed conclusion', async () => {
    const parsed = await parseOrThrow(await issueTestCredential())
    const outcome = await validateSchemaDocuments({
      references: [
        {
          formatIdentifier: 'dc+sd-jwt',
          uri: TEST_VCT,
          integrity: sha256Sri('{"different":"document"}'),
        },
      ],
      documents: [{ uri: TEST_VCT, content: PID_TYPE_METADATA_TEXT }],
      parsed,
    })
    const dimension = schemaDimensionFromOutcome(outcome, 1, 1)

    expect(outcome.status).toBe('FAIL')
    expect(dimension.status).toBe('FAIL')
    expect(dimension.executed).toBe(true)
    expect(dimension.applicable).toBe(true)
    expect(dimension.evidence.details).toMatchObject({
      executed: true,
      applied_documents: 0,
    })
  })
})

describe('schema dimension through the engine', () => {
  let fixture: RegistryFixture | undefined

  afterEach(() => {
    fixture?.cleanup()
    fixture = undefined
  })

  test('an unverifiable rulebook integrity pin cannot produce an overall PASS', async () => {
    fixture = createRegistryFixture()
    const seeded: SeededRulebook = seedPublishedRulebook(fixture.database, fixture.registry, {
      schemaIntegrity: 'sha384-abc123',
    })
    const validator = new CredentialValidator({
      source: fixture.registry,
      now: () => '2026-01-01T00:00:00.000Z',
      generateId: () => 'schema-dimension-test-id',
    })
    const input: ValidateCredentialInput = {
      rulebookId: seeded.rulebookId,
      rulebookVersion: seeded.version,
      attestationType: seeded.attestationName,
      credential: await issueTestCredential(),
      schemaDocuments: [{ uri: seeded.schemaUri, content: seeded.schemaContent }],
    }

    const result = await validator.validate(input)
    const schema = result.dimensions.find((entry) => entry.id === 'schema_validation')
    expect(schema?.status).toBe('NOT_TESTED')
    expect(schema?.executed).toBe(false)
    expect(schema?.evidence.details).toMatchObject({ applied_documents: 0, executed: false })
    expect(result.overallStatus).not.toBe('PASS')
    expect(result.limitations.map((entry) => entry.code)).toContain(
      'unsupported_integrity_algorithm',
    )
  })
})
