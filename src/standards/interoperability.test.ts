// Interoperability checks for the ETSI EN 319 482-3 migration assessment.
//
// These tests are characterization evidence, not a conformance claim. They
// execute the existing AttestBook standards adapter and the pinned OWF package
// against frozen external fixtures:
//
//   * the normative Annex E JSON Schema of the public ETSI EN 319 482-3 draft
//     v0.0.7 (2026-11) — used to separate "ETSI model" from "AttestBook model";
//   * a captured SIROS catalogue response (TS11-shaped, unsigned);
//   * a captured FIDES signed catalogue response and its JWKS.
//
// The findings and the migration gap they imply are recorded in
// docs/etsi-interoperability.md. Passing here does not establish TS11, ETSI,
// cryptographic, trust, protocol or end-to-end interoperability conformance.

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import type { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020.js'

import {
  OWF_PROFILE,
  TS11_PROFILE,
  detectProfile,
  parseSchemaMetaDocument,
  signSchemaMetaJws,
  verifySchemaMetaJws,
} from './index'
import {
  buildOwfWire,
  buildTs11Document,
  createTestKey,
  TEST_CERTIFICATE_PEM,
} from './test/fixtures'
import etsiSchema from './test/interop-fixtures/etsi-482-3-v0.0.7-annex-e.schema.json'
import sirosCapture from './test/interop-fixtures/siros-schemas-2026-11-09.json'
import fidesJwksCapture from './test/interop-fixtures/fides-jwks-2026-11-09.json'

const FIXTURE_DIRECTORY = new URL('./test/interop-fixtures/', import.meta.url)

const ETSI_SCHEMA_VERSION = 'draft v0.0.7 (2026-11)'

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true })
const validateEtsi = ajv.compile(etsiSchema as object)

/** Errors from the draft Annex E schema, or an empty list when it is valid. */
function etsiProblems(document: unknown): string[] {
  if (validateEtsi(document) === true) {
    return []
  }
  return (validateEtsi.errors ?? []).map(
    (error) =>
      `${error.instancePath === '' ? '/' : error.instancePath} ${error.keyword} ${JSON.stringify(
        error.params,
      )}`,
  )
}

/** Minimal document that satisfies draft Annex E as long as no trust entries are added. */
function etsiSchemaMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'https://example.org/attestations/gym-membership',
    iat: 1_793_577_600,
    version: '1.0.0',
    rulebookURI: 'https://example.org/rulebooks/gym-membership/1.0.0.md',
    rulebookIntegrity: 'sha256-AAAA',
    attestationLoS: 'iso_18045_basic',
    bindingType: 'key',
    schemaURIs: [
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: 'https://example.org/schemas/gym.vctm.json',
        integrity: 'sha256-BBBB',
        meta: { vct: 'eu.example.gym.1' },
      },
    ],
    ...overrides,
  }
}

function fixtureSha256(name: string): string {
  return createHash('sha256')
    .update(readFileSync(new URL(name, FIXTURE_DIRECTORY)))
    .digest('hex')
}

interface FidesConformance {
  readonly level: 'compatible' | 'partial'
  readonly missing: readonly string[]
}

interface FidesEntry {
  readonly id: string
  readonly conformance?: FidesConformance
}

describe(`ETSI EN 319 482-3 ${ETSI_SCHEMA_VERSION} model compatibility`, () => {
  test('accepts an Annex E-valid SchemaMeta without trust authorities through the OWF profile', () => {
    const document = etsiSchemaMeta()
    expect(etsiProblems(document)).toEqual([])
    expect(detectProfile(document)).toMatchObject({ ok: true, value: OWF_PROFILE })

    const parsed = parseSchemaMetaDocument(document)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.value.id).toBe('https://example.org/attestations/gym-membership')
    expect(parsed.value.rulebookIntegrity).toBe('sha256-AAAA')
    expect(parsed.value.schemaURIs[0]?.integrity).toBe('sha256-BBBB')
    expect(parsed.value.schemaURIs[0]?.meta).toEqual({ vct: 'eu.example.gym.1' })
  })

  test('rejects a non-URI id that Annex E marks with format: uri', () => {
    const parsed = parseSchemaMetaDocument(etsiSchemaMeta({ id: 'not a uri' }))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) {
      return
    }
    expect(parsed.diagnostics.some((entry) => entry.message.includes('URL'))).toBe(true)
  })

  test('rejects the Annex E etsi_tl trust authority that OWF 0.5.4 requires a verificationMethod for', () => {
    const document = etsiSchemaMeta({
      trustedAuthorities: [
        { frameworkType: 'etsi_tl', value: 'https://example.org/trust-lists/gym.jws' },
      ],
    })
    expect(etsiProblems(document)).toEqual([])

    const parsed = parseSchemaMetaDocument(document)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) {
      return
    }
    expect(parsed.diagnostics.map((entry) => entry.code)).toContain('invalid_schema_meta')
    expect(parsed.diagnostics.map((entry) => entry.path)).toContain(
      'trustedAuthorities.0.verificationMethod',
    )
  })

  test('requires a SemVer version label that draft Annex E does not require', () => {
    const document = etsiSchemaMeta({ version: '1.5' })
    expect(etsiProblems(document)).toEqual([])

    const parsed = parseSchemaMetaDocument(document)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) {
      return
    }
    expect(parsed.diagnostics).toEqual([
      {
        kind: 'invalid_input',
        code: 'invalid_schema_meta',
        message: 'version must be a SemVer string',
        path: 'version',
      },
    ])
  })

  test('rejects TS11 v1.0.1-shaped metadata under the draft ETSI schema', () => {
    const document = buildTs11Document()
    expect(detectProfile(document)).toMatchObject({ ok: true, value: TS11_PROFILE })
    expect(parseSchemaMetaDocument(document).ok).toBe(true)

    const problems = etsiProblems(document)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.some((problem) => problem.includes('rulebookIntegrity'))).toBe(true)
    expect(problems.some((problem) => problem.includes('supportedFormats'))).toBe(true)
    expect(problems.some((problem) => problem.includes('integrity'))).toBe(true)
    expect(problems.some((problem) => problem.includes('meta'))).toBe(true)
  })

  test('rejects OWF-only members that the draft ETSI schema forbids', () => {
    const owfDocument = buildOwfWire() as unknown as Record<string, unknown>
    expect(parseSchemaMetaDocument(owfDocument).ok).toBe(true)
    expect(
      etsiProblems(owfDocument).some((problem) => problem.includes('verificationMethod')),
    ).toBe(true)

    const extended = etsiSchemaMeta({
      issuanceProfile: { batchIssuanceAllowed: true },
      schemaURIs: [
        {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://example.org/schemas/gym.vctm.json',
          integrity: 'sha256-BBBB',
          meta: {
            vct: 'eu.example.gym.1',
            credential_metadata: { display: [{ name: 'Gym membership' }] },
          },
        },
      ],
    })
    expect(parseSchemaMetaDocument(extended).ok).toBe(true)
    const problems = etsiProblems(extended)
    expect(problems.some((problem) => problem.includes('issuanceProfile'))).toBe(true)
    expect(problems.some((problem) => problem.includes('credential_metadata'))).toBe(true)
  })

  test('signs and verifies an Annex E-shaped SchemaMeta as a JWT', async () => {
    const parsed = parseSchemaMetaDocument(etsiSchemaMeta())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    const key = await createTestKey()
    const signed = await signSchemaMetaJws({
      schemaMeta: parsed.value,
      keyId: 'etsi-interoperability-test',
      certificates: [TEST_CERTIFICATE_PEM],
      signer: key.signer,
    })
    expect(signed.ok).toBe(true)
    if (!signed.ok) {
      return
    }
    expect(signed.value.header.typ).toBe('attestation-schema+jwt')

    const verified = await verifySchemaMetaJws({
      jws: signed.value.jws,
      verifier: key.verifier,
      algorithm: 'ES256',
      keyId: 'etsi-interoperability-test',
    })
    expect(verified.ok).toBe(true)
    if (!verified.ok) {
      return
    }
    expect(verified.value.schemaMeta.rulebookIntegrity).toBe('sha256-AAAA')
    expect(verified.value.schemaMeta.schemaURIs[0]?.meta).toEqual({ vct: 'eu.example.gym.1' })
  })

  test('keeps the recorded Annex E schema fixture verbatim', () => {
    expect(fixtureSha256('etsi-482-3-v0.0.7-annex-e.schema.json')).toBe(
      'ef546c4e00feceea78bf065fbc0a3110bb59338d0567786de2e768bc8e0fdea0',
    )
  })
})

describe('captured external catalogue interoperability', () => {
  test('parses 27 of 32 SIROS entries and records the five TS11 SemVer rejections', () => {
    const entries = sirosCapture.data as unknown as Record<string, unknown>[]
    expect(entries).toHaveLength(32)

    const outcomes = entries.map((entry) => ({ entry, result: parseSchemaMetaDocument(entry) }))
    const accepted = outcomes.filter((outcome) => outcome.result.ok)
    const rejected = outcomes.filter((outcome) => !outcome.result.ok)
    expect(accepted).toHaveLength(27)
    expect(rejected).toHaveLength(5)

    expect(
      rejected.map((outcome) => `${String(outcome.entry.id)}@${String(outcome.entry.version)}`),
    ).toEqual([
      '2e5a14fb-3ddb-51a5-9efa-51806cb8ac5e@1.5',
      'b0880349-7a3d-57a2-9dbb-51c3ea022b33@1.0',
      '96c78c4f-9907-537f-9493-b7177fb63524@1.5',
      '10928af8-e06b-5922-94c2-074e1207874e@1.8',
      '1f281d3b-2ba9-515e-a4fd-693996715bb9@1.0',
    ])
    for (const outcome of rejected) {
      if (outcome.result.ok) {
        continue
      }
      expect(outcome.result.diagnostics).toEqual([
        {
          kind: 'invalid_input',
          code: 'invalid_member_value',
          message: 'expected a SemVer version',
          path: 'version',
        },
      ])
    }

    const first = accepted[0]
    expect(first?.result.ok).toBe(true)
    if (first?.result.ok === true) {
      expect(first.entry.id).toBe('109402dd-713d-5471-ace5-c9ee31fdd8d1')
      expect(first.result.value.rulebookURI).toBe(
        'https://registry.siros.org/sirosfoundation/demo_student_id/rulebook.html',
      )
      expect(first.result.value.supportedFormats).toEqual(['dc+sd-jwt'])
    }

    // The captured catalogue is TS11-shaped, not ETSI draft Annex E-shaped.
    expect(entries.filter((entry) => etsiProblems(entry).length === 0)).toEqual([])
    expect(fixtureSha256('siros-schemas-2026-11-09.json')).toBe(
      '865fa84de7fa1ca6b4e9da7010dcaff55afa2dd643c76884737ac9b0d1fb7a5b',
    )
  })

  test('verifies the captured FIDES signature and records its structural outcomes', () => {
    const jwt = readFileSync(
      new URL('fides-schemas-2026-11-09.jwt', FIXTURE_DIRECTORY),
      'utf8',
    ).trim()
    const parts = jwt.split('.')
    const [headerPart, payloadPart, signaturePart] = parts
    expect(parts).toHaveLength(3)
    if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
      return
    }

    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    expect(header).toEqual({ alg: 'ES256', kid: 'fides-cat-2026-v1', typ: 'JWT' })
    const jwk = fidesJwksCapture.keys[0] as unknown as webcrypto.JsonWebKey
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' })
    expect(
      verifySignature(
        'sha256',
        Buffer.from(`${headerPart}.${payloadPart}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signaturePart, 'base64url'),
      ),
    ).toBe(true)
    expect(fixtureSha256('fides-schemas-2026-11-09.jwt')).toBe(
      '3f7386fd70448b018d46b59021ea6143945af8a34c849d961bd98b7f97be76f5',
    )

    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
      content: FidesEntry[]
    }
    const entries = payload.content
    expect(entries).toHaveLength(121)

    const compatible = entries.filter((entry) => entry.conformance?.level === 'compatible')
    const partial = entries.filter((entry) => entry.conformance?.level === 'partial')
    expect(compatible).toHaveLength(10)
    expect(partial).toHaveLength(111)

    // FIDES' own "compatible" label is not TS11 v1.0.1 structural validity.
    expect(compatible.filter((entry) => parseSchemaMetaDocument(entry).ok)).toEqual([])
    for (const entry of compatible) {
      expect(entry.conformance?.missing).toContain('attestationLoS')
      expect(entry.conformance?.missing).toContain('schemaURIs')
    }

    const accepted = partial.filter((entry) => parseSchemaMetaDocument(entry).ok)
    expect(accepted).toHaveLength(20)
    expect(entries.filter((entry) => !parseSchemaMetaDocument(entry).ok)).toHaveLength(101)

    // The signed catalogue is TS11-shaped, not ETSI draft Annex E-shaped.
    expect(entries.filter((entry) => etsiProblems(entry).length === 0)).toEqual([])
  })
})
