// Offline fixtures for the Phase 1 end-to-end acceptance workflow (issue #39).
//
// The TS11 and OWF documents are synthetic and contain no personal data. The
// credential artifact used by the acceptance run is issued at runtime with a
// throwaway key by the validation test support, never committed.

import { createHash } from 'node:crypto'

import { schemaMeta, schemaURI, trustAuthority } from '@owf/eudi-attestation-schema'

export const RULEBOOK_UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
export const RULEBOOK_URI = 'https://example.org/rulebooks/pid'
export const SCHEMA_URI = 'https://example.org/schemas/pid-credential.json'
export const VCT = 'https://example.org/vct/pid'

/** W3C SRI `sha256-<base64>` over the exact UTF-8 document text. */
export function sha256Sri(text: string): string {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`
}

/**
 * A JSON Schema 2020-12 document for the acceptance credential. It uses only
 * keywords the bounded schema sandbox executes (no `format`, `pattern`,
 * `uniqueItems` or `$ref`), so a structurally valid credential must make the
 * schema dimension an executed PASS rather than a NOT_TESTED result.
 */
export const SCHEMA_DOCUMENT_TEXT = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['given_name', 'family_name', 'birthdate'],
  properties: {
    given_name: { type: 'string', minLength: 1 },
    family_name: { type: 'string', minLength: 1 },
    birthdate: { type: 'string', minLength: 10 },
    age: { type: 'integer', minimum: 0 },
  },
})

/** A valid EC TS11 v1.0.1 SchemaMeta document, ready for a JSON import. */
export function ts11Document(): Record<string, unknown> {
  return {
    id: RULEBOOK_UUID,
    version: '1.0.0',
    rulebookURI: `${RULEBOOK_URI}#integrity=${sha256Sri('rulebook-document')}`,
    trustedAuthorities: [
      {
        frameworkType: 'etsi_tl',
        value: 'https://example.org/trust-lists/pid.jws',
        isLOTE: true,
      },
    ],
    attestationLoS: 'iso_18045_high',
    bindingType: 'key',
    supportedFormats: ['dc+sd-jwt'],
    schemaURIs: [
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: `${SCHEMA_URI}#integrity=${sha256Sri(SCHEMA_DOCUMENT_TEXT)}`,
      },
    ],
  }
}

/** The same TS11 document with a required member removed (negative fixture). */
export function invalidTs11Document(): Record<string, unknown> {
  const document = ts11Document()
  delete document.bindingType
  return document
}

/**
 * A valid OWF 0.5.4 SchemaMeta document built with the real pinned OWF
 * builders. The import layer classifies it `partial` against TS11 because the
 * OWF profile carries members TS11 does not.
 */
export function owfDocument() {
  return schemaMeta()
    .id('https://example.org/attestations/badge')
    .version('2.0.0')
    .rulebookURI('https://example.org/rulebooks/badge/2.0.0')
    .rulebookIntegrity(sha256Sri('badge-rulebook'))
    .addTrustAuthority(
      trustAuthority()
        .frameworkType('etsi_tl')
        .value('https://example.org/trust-lists/badge.jws')
        .verificationMethod({
          type: 'X509Certificate',
          x509Certificate:
            'MIIBczCCARmgAwIBAgIUZt2jkmAgIIiw/wpvJU/4yL7ek/YwCgYIKoZIzj0EAwIwDzENMAsGA1UEAwwEdGVzdDAeFw0yNjAzMTYxODEwMTJaFw0zNjAzMTMxODEwMTJaMA8xDTALBgNVBAMMBHRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASa6ViWvoU/uOZiBHqFWLE/s+3Ts2K6XT9x2S+abUz/xu48DnP8eL89DQRS8TIUewZbW+H6GBuyFJjG/mSuqJf+o1MwUTAdBgNVHQ4EFgQUFDKBWF8aGWeDTQHphAhWXs9/J1AwHwYDVR0jBBgwFoAUFDKBWF8aGWeDTQHphAhWXs9/J1AwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEAibvAwfagitnTA7zKxcl8kuUaU+oBLClK8YXgs2WfHbwCIAQKqu6+GHkzWH8H0zMPKedvxJp34whrGoIarukWZjjp',
        })
        .build(),
    )
    .attestationLoS('iso_18045_basic')
    .bindingType('key')
    .addSchemaURI(
      schemaURI()
        .format('dc+sd-jwt')
        .uri('https://example.org/schemas/badge.json')
        .integrity(sha256Sri('badge-schema'))
        .meta({ vct: 'eu.example.badge.1' })
        .build(),
    )
    .build()
}
