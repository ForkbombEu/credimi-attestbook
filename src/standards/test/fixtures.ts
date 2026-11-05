// Shared fixtures for the standards adapter tests.
//
// Everything here exercises the real pinned OWF packages: OWF builders create
// the OWF wire document and `@owf/crypto` ES256 generates the test key. The
// certificate contains no personal data and no usable private key.

import { createHash } from 'node:crypto'

import type { SignOptions, VerifyOptions } from '@owf/eudi-attestation-schema'
import {
  schemaMeta,
  schemaURI,
  trustAuthority,
  type SchemaMeta,
} from '@owf/eudi-attestation-schema'
import { ES256 } from '@owf/crypto'

export const TEST_CERTIFICATE_DER =
  'MIIBczCCARmgAwIBAgIUZt2jkmAgIIiw/wpvJU/4yL7ek/YwCgYIKoZIzj0EAwIwDzENMAsGA1UEAwwEdGVzdDAeFw0yNjAzMTYxODEwMTJaFw0zNjAzMTMxODEwMTJaMA8xDTALBgNVBAMMBHRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASa6ViWvoU/uOZiBHqFWLE/s+3Ts2K6XT9x2S+abUz/xu48DnP8eL89DQRS8TIUewZbW+H6GBuyFJjG/mSuqJf+o1MwUTAdBgNVHQ4EFgQUFDKBWF8aGWeDTQHphAhWXs9/J1AwHwYDVR0jBBgwFoAUFDKBWF8aGWeDTQHphAhWXs9/J1AwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEAibvAwfagitnTA7zKxcl8kuUaU+oBLClK8YXgs2WfHbwCIAQKqu6+GHkzWH8H0zMPKedvxJp34whrGoIarukWZjjp'

export const TEST_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----\n${TEST_CERTIFICATE_DER}\n-----END CERTIFICATE-----`

export const RULEBOOK_URI = 'https://example.com/rulebooks/gym-membership/1.0.0.md'
export const SCHEMA_URI = 'https://example.com/schemas/gym-membership.json'
export const EXAMPLE_VCT = 'eu.example.gym.1'

export const TEST_SCHEMA_DOCUMENT = JSON.stringify({
  type: 'object',
  properties: {
    given_name: { type: 'string' },
    member_since: { type: 'string' },
  },
  required: ['given_name'],
})

export function sha256Sri(value: string | Uint8Array): string {
  return `sha256-${createHash('sha256').update(value).digest('base64')}`
}

/** An OWF-profile document built entirely with the real OWF builders. */
export function buildOwfWire(): SchemaMeta {
  return schemaMeta()
    .id('https://example.com/attestations/gym-membership-card')
    .version('1.0.0')
    .rulebookURI(RULEBOOK_URI)
    .rulebookIntegrity(sha256Sri('rulebook-document'))
    .addTrustAuthority(
      trustAuthority()
        .frameworkType('etsi_tl')
        .value('https://example.com/trust-lists/gym-members.jws')
        .verificationMethod({
          type: 'X509Certificate',
          x509Certificate: TEST_CERTIFICATE_DER,
        })
        .build(),
    )
    .attestationLoS('iso_18045_basic')
    .bindingType('key')
    .addSchemaURI(
      schemaURI()
        .format('dc+sd-jwt')
        .uri(SCHEMA_URI)
        .integrity(sha256Sri(TEST_SCHEMA_DOCUMENT))
        .meta({ vct: EXAMPLE_VCT })
        .build(),
    )
    .build()
}

/** A TS11 v1.0.1-shaped document (OWF rejects this shape; the adapter does not). */
export function buildTs11Document(): Record<string, unknown> {
  return {
    id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    version: '1.0.0',
    rulebookURI: `${RULEBOOK_URI}#integrity=${sha256Sri('rulebook-document')}`,
    trustedAuthorities: [
      {
        frameworkType: 'etsi_tl',
        value: 'https://example.com/trust-lists/gym-members.jws',
        isLOTE: true,
      },
    ],
    attestationLoS: 'iso_18045_basic',
    bindingType: 'key',
    supportedFormats: ['dc+sd-jwt'],
    schemaURIs: [
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: `${SCHEMA_URI}#integrity=${sha256Sri(TEST_SCHEMA_DOCUMENT)}`,
      },
    ],
  }
}

export interface TestKey {
  readonly algorithm: 'ES256'
  readonly signer: SignOptions['signer']
  readonly verifier: VerifyOptions['verifier']
}

interface TestKeyPair {
  readonly privateKey: object
  readonly publicKey: object
}

export async function createTestKey(): Promise<TestKey> {
  const keyPair = (await ES256.generateKeyPair()) as unknown as TestKeyPair
  const signer = await ES256.getSigner(keyPair.privateKey)
  const verifier = await ES256.getVerifier(keyPair.publicKey)
  return { algorithm: 'ES256', signer, verifier }
}

export function encodeJwsValue(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** Signs an arbitrary JWS header/payload pair, as OWF verifySchemaMeta accepts. */
export async function craftJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signer: SignOptions['signer'],
): Promise<string> {
  const signingInput = `${encodeJwsValue(header)}.${encodeJwsValue(payload)}`
  const signature = await signer(signingInput)
  return `${signingInput}.${signature}`
}

export function decodeJwsPayload(jws: string): Record<string, unknown> {
  const parts = jws.split('.')
  const payload = parts[1] ?? ''
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

export function decodeJwsHeader(jws: string): Record<string, unknown> {
  const parts = jws.split('.')
  const header = parts[0] ?? ''
  return JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>
}
