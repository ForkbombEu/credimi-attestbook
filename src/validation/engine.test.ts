import { afterEach, describe, expect, test } from 'bun:test'

import { isRegistryError, type RegistryErrorCode } from '../registry/errors'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'

import { CredentialValidator } from './engine'
import {
  defaultCredentialClaims,
  issueTestCredential,
  PID_JSON_SCHEMA_TEXT,
  seedPublishedRulebook,
  type SeedRulebookOptions,
  type SeededRulebook,
} from './test-support'
import type { CredentialValidationService } from './service'
import type {
  CredentialValidationResult,
  ValidationDimensionId,
  ValidateCredentialInput,
} from './types'

const FIXED_NOW = '2026-01-01T00:00:00.000Z'
const JSON_SCHEMA_URI = 'https://example.org/schemas/pid.json'

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
    now: () => FIXED_NOW,
    generateId: () => 'validation-test-id',
  })
  return { seeded, validator }
}

function request(
  seeded: SeededRulebook,
  credential: ValidateCredentialInput['credential'],
  schemaDocuments?: ValidateCredentialInput['schemaDocuments'],
): ValidateCredentialInput {
  return {
    rulebookId: seeded.rulebookId,
    rulebookVersion: seeded.version,
    attestationType: seeded.attestationName,
    credential,
    schemaDocuments: schemaDocuments ?? [{ uri: seeded.schemaUri, content: seeded.schemaContent }],
  }
}

function dimension(result: CredentialValidationResult, id: ValidationDimensionId) {
  const found = result.dimensions.find((entry) => entry.id === id)
  if (found === undefined) {
    throw new Error(`missing validation dimension ${id}`)
  }
  return found
}

async function expectRegistryError(
  action: () => Promise<unknown>,
  code: RegistryErrorCode,
): Promise<void> {
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  expect(isRegistryError(caught)).toBe(true)
  expect(isRegistryError(caught) ? caught.code : undefined).toBe(code)
}

describe('CredentialValidator with a pinned rulebook version', () => {
  test('returns structural PASS evidence, digest and the untested dimensions', async () => {
    const { seeded, validator } = setup()
    const credential = await issueTestCredential()
    const result = await validator.validate(request(seeded, credential))

    expect(result.validationId).toBe('validation-test-id')
    expect(result.validatedAt).toBe(FIXED_NOW)
    expect(result.rulebook).toEqual({
      id: seeded.rulebookId,
      name: seeded.rulebookName,
      version: '1.0',
      digest: seeded.digest,
      digestVerified: true,
      specVersion: 'ts11@1.0.1',
      status: 'published',
    })
    expect(result.attestation.name).toBe('PID')
    expect(result.credential).toEqual({
      format: 'dc+sd-jwt',
      vct: 'https://example.org/vct/pid',
      disclosureCount: 3,
      keyBindingPresent: false,
    })
    expect(result.schemaReferences[0]).toMatchObject({
      uri: seeded.schemaUri,
      integrity: seeded.integrity,
      kind: 'type_metadata',
      applied: true,
    })

    expect(result.dimensions.map((entry) => entry.id)).toEqual([
      'credential_parsing',
      'format_recognition',
      'cryptographic_verification',
      'schema_validation',
      'attestation_constraints',
      'issuer_trust',
      'protocol_conformance',
      'interoperability',
    ])
    expect(dimension(result, 'credential_parsing').status).toBe('PASS')
    expect(dimension(result, 'format_recognition').status).toBe('PASS')
    expect(dimension(result, 'schema_validation').status).toBe('PASS')
    expect(dimension(result, 'attestation_constraints').status).toBe('PASS')
    expect(dimension(result, 'cryptographic_verification').status).toBe('NOT_TESTED')
    expect(dimension(result, 'issuer_trust').status).toBe('NOT_TESTED')
    expect(dimension(result, 'protocol_conformance').status).toBe('NOT_APPLICABLE')
    expect(dimension(result, 'interoperability').status).toBe('NOT_APPLICABLE')

    // A dimension may be PASS only when it was applicable and actually ran.
    for (const entry of result.dimensions) {
      expect(entry.evidence.scope.length).toBeGreaterThan(0)
      expect(entry.evidence.reason.length).toBeGreaterThan(0)
      if (entry.status === 'PASS') {
        expect(entry.applicable).toBe(true)
        expect(entry.executed).toBe(true)
      }
    }
    expect(dimension(result, 'cryptographic_verification').executed).toBe(false)
    expect(dimension(result, 'cryptographic_verification').applicable).toBe(true)
    expect(dimension(result, 'issuer_trust').executed).toBe(false)
    expect(dimension(result, 'protocol_conformance').applicable).toBe(false)
    expect(dimension(result, 'interoperability').executed).toBe(false)
    expect(dimension(result, 'cryptographic_verification').evidence.details).toMatchObject({
      issuer_jws_signature_verified: false,
      key_binding_proof_verified: false,
      status_list_token_verified: false,
    })

    expect(result.overallStatus).toBe('NOT_TESTED')
    const codes = result.violations.map((entry) => entry.code)
    expect(codes).toContain('signature_not_verified')
    expect(codes).toContain('trust_not_evaluated')
    expect(result.violations.every((entry) => entry.severity !== 'error')).toBe(true)
    const limitationCodes = result.limitations.map((entry) => entry.code)
    expect(limitationCodes).toContain('signature_not_verified')
    expect(limitationCodes).toContain('key_binding_proof_not_verified')
    expect(limitationCodes).toContain('status_list_not_checked')
    expect(limitationCodes).toContain('trust_not_evaluated')
    expect(limitationCodes).toContain('protocol_not_applicable')
    expect(limitationCodes).toContain('interoperability_not_applicable')
  })

  test('does not treat an invalid signature as overall validation success', async () => {
    const { seeded, validator } = setup()
    const credential = await issueTestCredential()
    const segments = credential.split('~')
    const jwt = (segments[0] ?? '').split('.')
    const header = jwt[0]
    const payload = jwt[1]
    if (header === undefined || payload === undefined) {
      throw new Error('fixture is not a compact JWT')
    }
    const tampered = [
      [header, payload, 'aW52YWxpZC1zaWduYXR1cmU'].join('.'),
      ...segments.slice(1),
    ].join('~')
    const result = await validator.validate(request(seeded, tampered))

    expect(result.overallStatus).not.toBe('PASS')
    expect(result.overallStatus).toBe('NOT_TESTED')
    expect(dimension(result, 'cryptographic_verification').status).toBe('NOT_TESTED')
    expect(dimension(result, 'cryptographic_verification').executed).toBe(false)
    expect(dimension(result, 'cryptographic_verification').applicable).toBe(true)
    expect(result.limitations.map((entry) => entry.code)).toContain('signature_not_verified')
    // Structural checks may pass, but no structural result may claim the
    // signature or issuer trust was verified.
    expect(dimension(result, 'schema_validation').status).toBe('PASS')
    expect(dimension(result, 'issuer_trust').status).toBe('NOT_TESTED')
  })

  test('ignores caller-supplied dimension results and cannot be told a check passed', async () => {
    const { seeded, validator } = setup()
    const credential = await issueTestCredential()
    const result = await validator.validate({
      ...request(seeded, credential),
      dimensions: [
        {
          id: 'issuer_trust',
          status: 'PASS',
          applicable: true,
          executed: true,
          findings: [],
          evidence: { scope: 'caller', reason: 'caller', details: {} },
        },
      ],
      limitations: [],
      overallStatus: 'PASS',
    })

    // The request parser accepts only the documented fields; asserted evidence
    // never becomes a result, so a caller cannot claim an untested dimension.
    expect(result.overallStatus).toBe('NOT_TESTED')
    expect(dimension(result, 'issuer_trust').status).toBe('NOT_TESTED')
    expect(dimension(result, 'cryptographic_verification').status).toBe('NOT_TESTED')
    expect(result.limitations.map((entry) => entry.code)).toContain('trust_not_evaluated')
  })

  test('does not return raw claim values or the credential artifact', async () => {
    const { seeded, validator } = setup()
    const credential = await issueTestCredential()
    const result = await validator.validate(request(seeded, credential))
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain(credential)
    expect(serialized).not.toContain('Ada')
    expect(serialized).not.toContain('Lovelace')
    expect(serialized).not.toContain('1815-12-10')
  })

  test('fails a credential that is missing a mandatory attribute', async () => {
    const { seeded, validator } = setup()
    const claims = defaultCredentialClaims()
    delete claims.birthdate
    const credential = await issueTestCredential({ claims })
    const result = await validator.validate(request(seeded, credential))

    expect(result.overallStatus).toBe('FAIL')
    expect(dimension(result, 'schema_validation').status).toBe('FAIL')
    const violation = result.violations.find((entry) => entry.code === 'missing_mandatory_claim')
    expect(violation?.path).toBe('/birthdate')
    expect(violation?.severity).toBe('error')
  })

  test('fails a wrong attribute type against a JSON Schema rulebook reference', async () => {
    const { seeded, validator } = setup({
      schemaFormatIdentifier: 'dc+sd-jwt',
      schemaUri: JSON_SCHEMA_URI,
      schemaContent: PID_JSON_SCHEMA_TEXT,
    })
    const credential = await issueTestCredential({
      claims: defaultCredentialClaims({ age: 'thirty' }),
    })
    const result = await validator.validate(request(seeded, credential))

    expect(result.overallStatus).toBe('FAIL')
    expect(dimension(result, 'schema_validation').status).toBe('FAIL')
    expect(result.schemaReferences[0]?.kind).toBe('json_schema')
    const violation = result.violations.find((entry) => entry.code === 'schema_violation')
    expect(violation?.path).toBe('/age')
    expect(violation?.expected).toBe('type')
  })

  test('fails a key-bound credential without a cnf claim', async () => {
    const { seeded, validator } = setup({ bindingType: 'key' })
    const claims = defaultCredentialClaims()
    delete claims.cnf
    const credential = await issueTestCredential({ claims })
    const result = await validator.validate(request(seeded, credential))

    expect(result.overallStatus).toBe('FAIL')
    expect(dimension(result, 'attestation_constraints').status).toBe('FAIL')
    const violation = result.violations.find((entry) => entry.code === 'missing_key_binding')
    expect(violation?.path).toBe('/cnf')
  })

  test('fails a credential whose format the selected attestation type does not support', async () => {
    const { seeded, validator } = setup({
      supportedFormats: ['mso_mdoc'],
      schemaFormatIdentifier: 'mso_mdoc',
      schemaUri: 'https://example.org/doctype/pid',
      schemaContent: JSON.stringify({ doctype_value: 'eu.europa.ec.eudi.pid.1' }),
    })
    const credential = await issueTestCredential()
    const result = await validator.validate(request(seeded, credential, []))

    expect(result.overallStatus).toBe('FAIL')
    expect(dimension(result, 'attestation_constraints').status).toBe('FAIL')
    expect(result.violations.map((entry) => entry.code)).toContain(
      'format_not_supported_by_rulebook',
    )
  })

  test('reports an unsupported format explicitly instead of mocking a parser', async () => {
    const { seeded, validator } = setup({
      supportedFormats: ['mso_mdoc'],
      schemaFormatIdentifier: 'mso_mdoc',
      schemaUri: 'https://example.org/doctype/pid',
      schemaContent: JSON.stringify({ doctype_value: 'eu.europa.ec.eudi.pid.1' }),
    })
    const result = await validator.validate(
      request(seeded, { format: 'mso_mdoc', value: 'o2dnb2N0eXBl' }, []),
    )

    expect(result.overallStatus).toBe('INCONCLUSIVE')
    expect(dimension(result, 'format_recognition').status).toBe('INCONCLUSIVE')
    expect(dimension(result, 'credential_parsing').status).toBe('NOT_TESTED')
    expect(dimension(result, 'schema_validation').status).toBe('NOT_TESTED')
    // Rulebook-level checks ran, but the credential-dependent key-binding check
    // did not, so the dimension is executed and inconclusive, not PASS.
    expect(dimension(result, 'attestation_constraints').status).toBe('INCONCLUSIVE')
    expect(dimension(result, 'attestation_constraints').executed).toBe(true)
    expect(dimension(result, 'cryptographic_verification').status).toBe('NOT_TESTED')
    expect(result.violations.map((entry) => entry.code)).toContain('format_parser_unavailable')
    expect(result.limitations.map((entry) => entry.code)).toContain(
      'credential_dependent_checks_not_run',
    )
  })

  test('does not pass schema validation when no schema document is supplied', async () => {
    const { seeded, validator } = setup()
    const credential = await issueTestCredential()
    const result = await validator.validate(request(seeded, credential, []))

    expect(result.overallStatus).toBe('NOT_TESTED')
    expect(dimension(result, 'schema_validation').status).toBe('NOT_TESTED')
    expect(result.schemaReferences[0]?.applied).toBe(false)
    expect(result.violations.map((entry) => entry.code)).toContain('schema_document_not_supplied')
  })

  test('fails a credential whose supplied schema document does not match the pinned integrity', async () => {
    const { seeded, validator } = setup()
    const credential = await issueTestCredential()
    const result = await validator.validate(
      request(seeded, credential, [{ uri: seeded.schemaUri, content: `${seeded.schemaContent} ` }]),
    )

    expect(result.overallStatus).toBe('FAIL')
    expect(result.violations.map((entry) => entry.code)).toContain('integrity_mismatch')
  })

  test('rejects a schema document that the selected attestation does not reference', async () => {
    const { seeded, validator } = setup()
    const credential = await issueTestCredential()
    await expectRegistryError(
      () =>
        validator.validate(
          request(seeded, credential, [
            { uri: 'https://example.org/schemas/unrelated.json', content: '{}' },
          ]),
        ),
      'invalid_input',
    )
  })

  test('rejects an unknown rulebook, version or attestation type', async () => {
    const { seeded, validator } = setup()
    const credential = await issueTestCredential()
    const base = request(seeded, credential)

    await expectRegistryError(
      () => validator.validate({ ...base, rulebookId: 'missing-rulebook' }),
      'not_found',
    )
    await expectRegistryError(
      () => validator.validate({ ...base, rulebookVersion: '9.9' }),
      'not_found',
    )
    await expectRegistryError(
      () => validator.validate({ ...base, attestationType: 'Unknown' }),
      'not_found',
    )
  })

  test('rejects a malformed request before touching the registry', async () => {
    const { validator } = setup()
    await expectRegistryError(() => validator.validate({ rulebookId: 'x' }), 'invalid_input')
  })

  test('aborts when the stored snapshot bytes do not match the recorded digest', async () => {
    const { seeded } = setup()
    const credential = await issueTestCredential()
    if (fixture === undefined) {
      throw new Error('fixture is not initialized')
    }
    const original = fixture.registry
    const corruptSource = {
      getRulebook: (id: string) => original.getRulebook(id),
      getRulebookVersion: (id: string, version: string) => original.getRulebookVersion(id, version),
      getRulebookVersionContent: (id: string, version: string) => {
        const content = original.getRulebookVersionContent(id, version)
        if (content === null) {
          return null
        }
        return { ...content, bytes: new Uint8Array([0x7b, 0x7d]) }
      },
    }
    const corruptValidator = new CredentialValidator({ source: corruptSource })

    let caught: unknown
    try {
      await corruptValidator.validate(request(seeded, credential))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('does not match its recorded digest')
  })

  test('keeps validating the exact published version after a newer version is drafted', async () => {
    const { seeded, validator } = setup()
    const credential = await issueTestCredential()
    if (fixture === undefined) {
      throw new Error('fixture is not initialized')
    }
    const next = fixture.registry.createRulebookVersion(seeded.actor, seeded.rulebookId, {
      version: '1.1',
    })

    const result = await validator.validate(request(seeded, credential))
    expect(result.rulebook.version).toBe('1.0')
    expect(result.rulebook.digest).toBe(seeded.digest)
    expect(result.rulebook.digest).not.toBe(next.contentDigest)
  })

  test('returns a FAIL report for an unrecognized credential with schema documents', async () => {
    const { seeded, validator } = setup()
    const result = await validator.validate(request(seeded, 'not-a-credential'))

    expect(result.overallStatus).toBe('FAIL')
    expect(dimension(result, 'format_recognition').status).toBe('FAIL')
    expect(dimension(result, 'schema_validation').status).toBe('NOT_TESTED')
  })

  test('reports an unrecognized credential artifact as a format failure', async () => {
    const { seeded, validator } = setup()
    const result = await validator.validate(request(seeded, 'not-a-credential', []))

    expect(result.overallStatus).toBe('FAIL')
    expect(dimension(result, 'format_recognition').status).toBe('FAIL')
    expect(dimension(result, 'credential_parsing').status).toBe('NOT_TESTED')
    expect(result.violations.map((entry) => entry.code)).toContain('unrecognized_credential_format')
  })
})
