// Negative-implication tests for the FR-010 dimensions (issue #33, spec §16).
//
// The four required negative tests are:
//   * schema validity does not imply cryptographic validity;
//   * cryptographic validity does not imply trust;
//   * rulebook conformance does not imply protocol conformance;
//   * protocol conformance does not imply successful interoperability.
//
// A final table-driven test covers several scenarios and proves the invariant
// that no dimension and no overall result is PASS without execution.

import { afterEach, describe, expect, test } from 'bun:test'

import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'

import { CredentialValidator } from './engine'
import type { CredentialValidationService } from './service'
import {
  defaultCredentialClaims,
  issueTestCredential,
  seedPublishedRulebook,
  type SeedRulebookOptions,
  type SeededRulebook,
} from './test-support'
import type {
  CredentialValidationResult,
  ValidationDimensionId,
  ValidateCredentialInput,
} from './types'

const JSON_SCHEMA_URI = 'https://example.org/schemas/pid.json'
const JSON_SCHEMA_TEXT = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['given_name', 'birthdate'],
  properties: {
    given_name: { type: 'string', minLength: 1 },
    birthdate: { type: 'string', minLength: 10 },
  },
})

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function setup(options: SeedRulebookOptions = {}): {
  seeded: SeededRulebook
  validator: CredentialValidationService
} {
  fixture = createRegistryFixture()
  const seeded = seedPublishedRulebook(fixture.database, fixture.registry, options)
  const validator = new CredentialValidator({
    source: fixture.registry,
    now: () => '2026-01-01T00:00:00.000Z',
    generateId: () => 'non-conflation-test-id',
  })
  return { seeded, validator }
}

function request(
  seeded: SeededRulebook,
  credential: ValidateCredentialInput['credential'],
  schemaDocuments: ValidateCredentialInput['schemaDocuments'] = [
    { uri: seeded.schemaUri, content: seeded.schemaContent },
  ],
): ValidateCredentialInput {
  return {
    rulebookId: seeded.rulebookId,
    rulebookVersion: seeded.version,
    attestationType: seeded.attestationName,
    credential,
    schemaDocuments,
  }
}

function dimension(result: CredentialValidationResult, id: ValidationDimensionId) {
  const found = result.dimensions.find((entry) => entry.id === id)
  if (found === undefined) {
    throw new Error(`missing validation dimension ${id}`)
  }
  return found
}

function tamperSignature(credential: string): string {
  const segments = credential.split('~')
  const jwt = (segments[0] ?? '').split('.')
  const header = jwt[0]
  const payload = jwt[1]
  if (header === undefined || payload === undefined) {
    throw new Error('fixture is not a compact JWT')
  }
  return [[header, payload, 'aW52YWxpZC1zaWduYXR1cmU'].join('.'), ...segments.slice(1)].join('~')
}

describe('spec §16 negative implications', () => {
  test('schema validity does not imply cryptographic validity', async () => {
    const { seeded, validator } = setup()
    const result = await validator.validate(request(seeded, await issueTestCredential()))

    expect(dimension(result, 'schema_validation').status).toBe('PASS')
    expect(dimension(result, 'cryptographic_verification').status).not.toBe('PASS')
    expect(dimension(result, 'cryptographic_verification').executed).toBe(false)
    expect(result.overallStatus).not.toBe('PASS')
    expect(result.limitations.map((entry) => entry.code)).toContain('signature_not_verified')
  })

  test('cryptographic verification is reported independently from issuer trust', async () => {
    const { seeded, validator } = setup()
    const result = await validator.validate(request(seeded, await issueTestCredential()))

    expect(dimension(result, 'cryptographic_verification').status).toBe('NOT_TESTED')
    expect(dimension(result, 'issuer_trust').status).toBe('NOT_TESTED')
    expect(dimension(result, 'issuer_trust').executed).toBe(false)
    expect(dimension(result, 'cryptographic_verification').executed).toBe(false)
    // Both are independent limitations; neither is inferred from the other.
    const limitationCodes = result.limitations.map((entry) => entry.code)
    expect(limitationCodes).toContain('signature_not_verified')
    expect(limitationCodes).toContain('trust_not_evaluated')
  })

  test('rulebook conformance does not imply protocol conformance', async () => {
    const { seeded, validator } = setup()
    const result = await validator.validate(request(seeded, await issueTestCredential()))

    expect(dimension(result, 'attestation_constraints').status).toBe('PASS')
    expect(dimension(result, 'schema_validation').status).toBe('PASS')
    expect(dimension(result, 'protocol_conformance').status).toBe('NOT_APPLICABLE')
    expect(dimension(result, 'protocol_conformance').status).not.toBe('PASS')
    expect(dimension(result, 'protocol_conformance').executed).toBe(false)
    expect(result.limitations.map((entry) => entry.code)).toContain('protocol_not_applicable')
  })

  test('protocol conformance is not inferred from end-to-end interoperability', async () => {
    const { seeded, validator } = setup()
    const result = await validator.validate(request(seeded, await issueTestCredential()))

    expect(dimension(result, 'protocol_conformance').status).not.toBe('PASS')
    expect(dimension(result, 'interoperability').status).not.toBe('PASS')
    expect(dimension(result, 'interoperability').executed).toBe(false)
    expect(dimension(result, 'interoperability').evidence.details).toMatchObject({
      external_wallet_execution: false,
    })
    expect(result.overallStatus).not.toBe('PASS')
    expect(result.limitations.map((entry) => entry.code)).toContain(
      'interoperability_not_applicable',
    )
  })

  test('an invalid signature is never overall validation success', async () => {
    const { seeded, validator } = setup()
    const result = await validator.validate(
      request(seeded, tamperSignature(await issueTestCredential())),
    )

    expect(result.overallStatus).not.toBe('PASS')
    expect(dimension(result, 'cryptographic_verification').status).toBe('NOT_TESTED')
    expect(dimension(result, 'cryptographic_verification').executed).toBe(false)
    expect(result.limitations.map((entry) => entry.code)).toContain('signature_not_verified')
  })
})

describe('no unexecuted dimension or overall result is PASS', () => {
  test('holds across valid, invalid, unsupported and unrecognized inputs', async () => {
    const jsonSchema = setup({
      schemaFormatIdentifier: 'dc+sd-jwt',
      schemaUri: JSON_SCHEMA_URI,
      schemaContent: JSON_SCHEMA_TEXT,
    })
    const mdoc = setup({
      supportedFormats: ['mso_mdoc'],
      schemaFormatIdentifier: 'mso_mdoc',
      schemaUri: 'https://example.org/doctype/pid',
      schemaContent: JSON.stringify({ doctype_value: 'eu.europa.ec.eudi.pid.1' }),
    })

    const missingClaimClaims = defaultCredentialClaims()
    delete missingClaimClaims.birthdate

    const scenarios: readonly { name: string; result: CredentialValidationResult }[] = [
      {
        name: 'structurally valid credential',
        result: await jsonSchema.validator.validate(
          request(jsonSchema.seeded, await issueTestCredential()),
        ),
      },
      {
        name: 'invalid signature',
        result: await jsonSchema.validator.validate(
          request(jsonSchema.seeded, tamperSignature(await issueTestCredential())),
        ),
      },
      {
        name: 'missing mandatory claim',
        result: await jsonSchema.validator.validate(
          request(jsonSchema.seeded, await issueTestCredential({ claims: missingClaimClaims })),
        ),
      },
      {
        name: 'unsupported mdoc format',
        result: await mdoc.validator.validate(
          request(mdoc.seeded, { format: 'mso_mdoc', value: 'o2dnb2N0eXBl' }, []),
        ),
      },
      {
        name: 'unrecognized artifact',
        result: await jsonSchema.validator.validate(
          request(jsonSchema.seeded, 'not-a-credential', []),
        ),
      },
    ]

    for (const scenario of scenarios) {
      expect(scenario.result.dimensions).toHaveLength(8)
      expect(scenario.result.overallStatus).not.toBe('PASS')
      for (const entry of scenario.result.dimensions) {
        if (entry.status === 'PASS') {
          expect(entry.applicable).toBe(true)
          expect(entry.executed).toBe(true)
        }
        if (!entry.executed) {
          expect(entry.status).not.toBe('PASS')
        }
      }
      // Cryptography and trust always remain applicable and unexecuted.
      for (const id of ['cryptographic_verification', 'issuer_trust'] as const) {
        expect(dimension(scenario.result, id).status).toBe('NOT_TESTED')
        expect(dimension(scenario.result, id).executed).toBe(false)
      }
      // Protocol and interoperability are request-scoped and never inferred.
      for (const id of ['protocol_conformance', 'interoperability'] as const) {
        expect(dimension(scenario.result, id).status).toBe('NOT_APPLICABLE')
        expect(dimension(scenario.result, id).executed).toBe(false)
      }
      expect(scenario.result.limitations.length).toBeGreaterThan(0)
    }
  })
})
