// Shared fixtures for credential-validation tests (issue #32).
//
// Credentials are real SD-JWT VC compact serializations produced by the pinned
// `@sd-jwt/sd-jwt-vc` package signed with a throwaway ES256 test key. No real
// key, certificate or personal data is used, and the registry is a real migrated
// SQLite database from `../registry/test-support`.

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

import { ES256 } from '@owf/crypto'
import { SDJwtVcInstance, type SdJwtVcPayload } from '@sd-jwt/sd-jwt-vc'

import { provisionProvider } from '../registry/bootstrap'
import type { Registry } from '../registry/registry'
import { createSdJwtHasher } from './sd-jwt'

export const TEST_VCT = 'https://example.org/vct/pid'

/** A type metadata document matching the default credential fixture. */
export const PID_TYPE_METADATA: TypeMetadataFixture = {
  vct: TEST_VCT,
  name: 'PID',
  claims: [
    { path: ['given_name'], mandatory: true, sd: 'allowed' },
    { path: ['family_name'], mandatory: true, sd: 'allowed' },
    { path: ['birthdate'], mandatory: true, sd: 'allowed' },
    { path: ['age'], sd: 'never' },
  ],
}

interface TypeMetadataFixture {
  readonly vct: string
  readonly name: string
  readonly claims: readonly {
    readonly path: readonly string[]
    readonly mandatory?: boolean
    readonly sd?: 'always' | 'allowed' | 'never'
  }[]
}

export const PID_TYPE_METADATA_TEXT = JSON.stringify(PID_TYPE_METADATA)

/** A JSON Schema 2020-12 document describing the same attributes. */
export const PID_JSON_SCHEMA_TEXT = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['given_name', 'birthdate'],
  properties: {
    given_name: { type: 'string', minLength: 1 },
    family_name: { type: 'string' },
    birthdate: { type: 'string', minLength: 10 },
    age: { type: 'integer', minimum: 0 },
  },
})

/** W3C SRI `sha256-<base64>` over the exact UTF-8 document text. */
export function sha256Sri(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`
}

export function defaultCredentialClaims(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const claims: Record<string, unknown> = {
    iss: 'https://issuer.example/pid',
    vct: TEST_VCT,
    iat: 1_700_000_000,
    cnf: {
      jwk: {
        kty: 'EC',
        crv: 'P-256',
        x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
        y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
      },
    },
    given_name: 'Ada',
    family_name: 'Lovelace',
    birthdate: '1815-12-10',
    age: 36,
  }
  return Object.assign(claims, overrides)
}

export interface IssueCredentialOptions {
  readonly claims?: Readonly<Record<string, unknown>>
  readonly selectiveClaims?: readonly string[]
}

let cachedSigner: Promise<(data: string) => Promise<string>> | undefined

/** A throwaway ES256 key pair, generated once per test process. */
function testSigner(): Promise<(data: string) => Promise<string>> {
  cachedSigner ??= ES256.generateKeyPair().then(({ privateKey }) =>
    ES256.getSigner(privateKey as object),
  )
  return cachedSigner
}

/**
 * Issues a real, genuinely signed SD-JWT VC with a throwaway test key. The
 * structural engine does not verify the signature, but the fixture exercises
 * the real compact serialization the pinned parser produces.
 */
export async function issueTestCredential(options: IssueCredentialOptions = {}): Promise<string> {
  let saltCounter = 0
  const signer = await testSigner()
  const instance = new SDJwtVcInstance({
    signer,
    signAlg: 'ES256',
    hasher: createSdJwtHasher(),
    saltGenerator: () => `test-salt-${String(saltCounter++).padStart(4, '0')}`,
  })

  const claims = (options.claims ?? defaultCredentialClaims()) as SdJwtVcPayload
  const selectiveClaims = options.selectiveClaims ?? ['given_name', 'family_name', 'birthdate']
  // The pinned package's DisclosureFrame generic cannot infer an index-signature
  // payload; the frame is a plain `_sd` list at this level.
  const frame = selectiveClaims.length === 0 ? undefined : { _sd: [...selectiveClaims] }
  return instance.issue(claims, frame as never)
}

export interface SeedRulebookOptions {
  readonly authority?: string
  readonly rulebookName?: string
  readonly attestationName?: string
  readonly attestationLoS?: string
  readonly bindingType?: string
  readonly supportedFormats?: readonly string[]
  readonly schemaFormatIdentifier?: string
  readonly schemaUri?: string
  readonly schemaContent?: string
  /** Overrides the computed sha256 SRI pin; used to test unverifiable pins. */
  readonly schemaIntegrity?: string
}

export interface SeededRulebook {
  readonly rulebookId: string
  readonly rulebookName: string
  readonly attestationName: string
  readonly version: string
  readonly digest: string
  readonly schemaUri: string
  readonly schemaContent: string
  readonly integrity: string
  readonly token: string
}

/**
 * Creates a provider, a rulebook with one attestation type, a schema reference
 * and a published version. The version snapshot is immutable from then on.
 */
export function seedPublishedRulebook(
  database: Database,
  registry: Registry,
  options: SeedRulebookOptions = {},
): SeededRulebook {
  const authority = options.authority ?? 'authority-1'
  const provider = provisionProvider(database, {
    name: `Provider ${authority}`,
    publicationAuthority: authority,
  })
  const token = provider.token.secret
  const attestationName = options.attestationName ?? 'PID'
  const rulebookName = options.rulebookName ?? 'PID Rulebook'
  const schemaUri = options.schemaUri ?? TEST_VCT
  const schemaContent = options.schemaContent ?? PID_TYPE_METADATA_TEXT
  const integrity = options.schemaIntegrity ?? sha256Sri(schemaContent)

  const rulebook = registry.createRulebook(token, {
    name: rulebookName,
    description: 'Fixture rulebook for structural validation tests',
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: attestationName,
        attestationLoS: options.attestationLoS ?? 'iso_18045_high',
        bindingType: options.bindingType ?? 'key',
        supportedFormats: options.supportedFormats ?? ['dc+sd-jwt'],
      },
    ],
  })
  const attestation = registry
    .listAttestations(rulebook.id)
    .find((candidate) => candidate.name === attestationName)
  if (attestation === undefined) {
    throw new Error('seed fixture failed to create the attestation type')
  }
  registry.addSchemaReference(token, rulebook.id, {
    formatIdentifier: options.schemaFormatIdentifier ?? 'dc+sd-jwt',
    uri: schemaUri,
    integrity,
    attestationId: attestation.id,
  })

  const version = registry.createRulebookVersion(token, rulebook.id, { version: '1.0' })
  registry.publishRulebookVersion(token, rulebook.id, '1.0')

  return {
    rulebookId: rulebook.id,
    rulebookName,
    attestationName,
    version: version.version,
    digest: version.contentDigest,
    schemaUri,
    schemaContent,
    integrity,
    token,
  }
}
