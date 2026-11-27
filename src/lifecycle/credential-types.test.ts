// Credential-type assessment tests for publication readiness.
//
// Every branch of the contract is covered: no applicable format, a hosted JSON
// Schema or Type Metadata that declares the type, a hosted document that does
// not, a missing declaration, and an external reference that can only warn.

import { describe, expect, test } from 'bun:test'

import type {
  RulebookVersionAttestation,
  RulebookVersionDocument,
  RulebookVersionSchemaReference,
} from '../registry/versioning'

import {
  assessCredentialTypes,
  type CredentialSchemaResolution,
  type CredentialSchemaResolver,
} from './credential-types'

const JSON_SCHEMA_URL = 'https://schemas.example/api/v1/schema-documents/doc-1/content'
const OTHER_URL = 'https://schemas.example/api/v1/schema-documents/doc-2/content'
const EXTERNAL_URL = 'https://issuer.example.org/schemas/pid.json'

function reference(
  formatIdentifier: string,
  uri = JSON_SCHEMA_URL,
): RulebookVersionSchemaReference {
  return { formatIdentifier, uri, integrity: null }
}

function attestation(
  overrides: Partial<RulebookVersionAttestation> = {},
): RulebookVersionAttestation {
  return {
    name: 'Person Identification Data',
    attestationLoS: 'iso_18045_high',
    bindingType: 'key',
    supportedFormats: ['dc+sd-jwt'],
    schemaReferences: [reference('dc+sd-jwt')],
    ...overrides,
  }
}

function snapshot(attestations: readonly RulebookVersionAttestation[]): RulebookVersionDocument {
  return {
    format: 'attestbook.rulebook-version@1',
    rulebookId: 'rulebook-1',
    version: '1.0',
    specVersion: 'ts11@1.0.1',
    name: 'PID Rulebook',
    description: 'Person identification data.',
    sourceUrl: null,
    attestations,
    schemaReferences: [],
  }
}

function resolver(
  documents: Readonly<Record<string, CredentialSchemaResolution>>,
): CredentialSchemaResolver {
  return (uri) => documents[uri] ?? null
}

function jsonSchema(document: unknown): CredentialSchemaResolution {
  return { kind: 'json_schema_2020_12', document }
}

function typeMetadata(document: unknown): CredentialSchemaResolution {
  return { kind: 'sd_jwt_vc_type_metadata', document }
}

describe('credential type assessment', () => {
  test('is not applicable without a dc+sd-jwt or mso_mdoc format', () => {
    const result = assessCredentialTypes(snapshot([]), () => {
      throw new Error('the resolver must not be called')
    })
    expect(result.status).toBe('not_applicable')
    expect(result.issues).toEqual([])

    const other = assessCredentialTypes(
      snapshot([attestation({ supportedFormats: ['other-format'], schemaReferences: [] })]),
      () => {
        throw new Error('the resolver must not be called')
      },
    )
    expect(other.status).toBe('not_applicable')
  })

  test('passes a hosted JSON Schema declaring properties.vct.const', () => {
    const result = assessCredentialTypes(
      snapshot([attestation()]),
      resolver({
        [JSON_SCHEMA_URL]: jsonSchema({
          type: 'object',
          required: ['vct'],
          properties: { vct: { const: 'https://example.org/vct/pid' } },
        }),
      }),
    )

    expect(result.status).toBe('pass')
    expect(result.issues).toEqual([])
    expect(result.message).toContain('Every declared credential format')
  })

  test('passes a hosted Type Metadata whose root vct is declared', () => {
    const format = 'dc+sd-jwt'
    const result = assessCredentialTypes(
      snapshot([
        attestation({
          supportedFormats: [format],
          schemaReferences: [reference(format, OTHER_URL)],
        }),
      ]),
      resolver({
        [OTHER_URL]: typeMetadata({ vct: 'https://example.org/vct/pid' }),
      }),
    )

    expect(result.status).toBe('pass')
  })

  test('fails when a hosted JSON Schema does not declare properties.vct.const', () => {
    for (const document of [
      { type: 'object', properties: { family_name: { type: 'string' } } },
      { type: 'object', properties: { vct: { const: '' } } },
      { type: 'object', properties: { vct: { type: 'string' } } },
      { type: 'object' },
      false,
    ]) {
      const result = assessCredentialTypes(
        snapshot([attestation()]),
        resolver({ [JSON_SCHEMA_URL]: jsonSchema(document) }),
      )

      expect(result.status).toBe('fail')
      expect(result.message).toContain('Person Identification Data')
      expect(result.message).toContain('dc+sd-jwt')
      expect(result.issues[0]?.reason).toContain('properties.vct.const')
    }
  })

  test('fails when a Type Metadata document has no root vct', () => {
    const result = assessCredentialTypes(
      snapshot([attestation()]),
      resolver({ [JSON_SCHEMA_URL]: typeMetadata({ name: 'PID' }) }),
    )

    expect(result.status).toBe('fail')
    expect(result.issues[0]?.reason).toContain('root vct')
  })

  test('passes a hosted mso_mdoc JSON Schema with docType and a namespace', () => {
    const result = assessCredentialTypes(
      snapshot([
        attestation({
          supportedFormats: ['mso_mdoc'],
          schemaReferences: [reference('mso_mdoc')],
        }),
      ]),
      resolver({
        [JSON_SCHEMA_URL]: jsonSchema({
          type: 'object',
          required: ['docType'],
          properties: {
            docType: { const: 'org.iso.18013.5.1.mDL' },
            'org.iso.18013.5.1': {
              type: 'object',
              properties: { family_name: { type: 'string' } },
            },
          },
        }),
      }),
    )

    expect(result.status).toBe('pass')
  })

  test('accepts a namespace declared only by a properties member', () => {
    const result = assessCredentialTypes(
      snapshot([
        attestation({
          supportedFormats: ['mso_mdoc'],
          schemaReferences: [reference('mso_mdoc')],
        }),
      ]),
      resolver({
        [JSON_SCHEMA_URL]: jsonSchema({
          properties: {
            docType: { const: 'org.iso.18013.5.1.mDL' },
            'org.iso.18013.5.1': { properties: { family_name: { type: 'string' } } },
          },
        }),
      }),
    )

    expect(result.status).toBe('pass')
  })

  test('fails an mso_mdoc schema without docType.const or without a namespace', () => {
    const cases = [
      {
        document: {
          properties: {
            'org.iso.18013.5.1': { type: 'object', properties: {} },
          },
        },
        reason: 'properties.docType.const',
      },
      {
        document: { properties: { docType: { const: 'org.iso.18013.5.1.mDL' } } },
        reason: 'at least one namespace',
      },
      {
        document: {
          properties: {
            docType: { const: 'org.iso.18013.5.1.mDL' },
            'org.iso.18013.5.1': { type: 'string' },
          },
        },
        reason: 'at least one namespace',
      },
    ]

    for (const entry of cases) {
      const result = assessCredentialTypes(
        snapshot([
          attestation({
            name: 'Mobile Driving Licence',
            supportedFormats: ['mso_mdoc'],
            schemaReferences: [reference('mso_mdoc')],
          }),
        ]),
        resolver({ [JSON_SCHEMA_URL]: jsonSchema(entry.document) }),
      )

      expect(result.status).toBe('fail')
      expect(result.issues[0]?.reason).toContain(entry.reason)
      expect(result.message).toContain('Mobile Driving Licence')
    }
  })

  test('fails an mso_mdoc format resolved to Type Metadata', () => {
    const result = assessCredentialTypes(
      snapshot([
        attestation({
          supportedFormats: ['mso_mdoc'],
          schemaReferences: [reference('mso_mdoc')],
        }),
      ]),
      resolver({ [JSON_SCHEMA_URL]: typeMetadata({ vct: 'https://example.org/vct/pid' }) }),
    )

    expect(result.status).toBe('fail')
    expect(result.issues[0]?.reason).toContain('JSON Schema')
  })

  test('fails a declared format with no schema reference', () => {
    const result = assessCredentialTypes(
      snapshot([attestation({ schemaReferences: [] })]),
      () => null,
    )

    expect(result.status).toBe('fail')
    expect(result.issues[0]).toMatchObject({
      format: 'dc+sd-jwt',
      uri: '',
      status: 'fail',
    })
    expect(result.issues[0]?.reason).toContain('no dc+sd-jwt schema reference')
  })

  test('warns for an external reference and names the required declaration', () => {
    const result = assessCredentialTypes(
      snapshot([
        attestation({
          schemaReferences: [reference('dc+sd-jwt', EXTERNAL_URL)],
        }),
      ]),
      () => null,
    )

    expect(result.status).toBe('warn')
    expect(result.message).toContain('external')
    expect(result.message).toContain('properties.vct.const')
    expect(result.message).toContain(EXTERNAL_URL)
    expect(result.issues[0]?.status).toBe('warn')
  })

  test('a failure wins over an external warning', () => {
    const result = assessCredentialTypes(
      snapshot([
        attestation({
          name: 'External PID',
          schemaReferences: [reference('dc+sd-jwt', EXTERNAL_URL)],
        }),
        attestation({ name: 'Hosted PID' }),
      ]),
      resolver({ [JSON_SCHEMA_URL]: jsonSchema({ type: 'object' }) }),
    )

    expect(result.status).toBe('fail')
    expect(result.message).toContain('Hosted PID')
    expect(result.message).not.toContain('External PID')
  })

  test('checks each declared format independently', () => {
    const result = assessCredentialTypes(
      snapshot([
        attestation({
          supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
          schemaReferences: [reference('dc+sd-jwt'), reference('mso_mdoc', OTHER_URL)],
        }),
      ]),
      resolver({
        [JSON_SCHEMA_URL]: jsonSchema({
          properties: { vct: { const: 'https://example.org/vct/pid' } },
        }),
        [OTHER_URL]: jsonSchema({ properties: { docType: { const: 'org.iso.18013.5.1.mDL' } } }),
      }),
    )

    expect(result.status).toBe('fail')
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.format).toBe('mso_mdoc')
  })

  test('bounds the reported message', () => {
    const result = assessCredentialTypes(
      snapshot([
        attestation({
          name: 'A'.repeat(2_000),
          schemaReferences: [reference('dc+sd-jwt', EXTERNAL_URL)],
        }),
      ]),
      () => null,
    )

    expect(result.message.length).toBeLessThanOrEqual(800)
    expect(result.message.endsWith('…')).toBe(true)
  })
})
