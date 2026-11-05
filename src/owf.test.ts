import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  schemaMeta,
  schemaURI,
  trustAuthority,
  validateSchemaMeta,
} from '@owf/eudi-attestation-schema'
import owfPackage from '@owf/eudi-attestation-schema/package.json'

import applicationPackage from '../package.json'

/**
 * Smoke/integration coverage for the mandatory OWF dependency (decision D-1):
 * the test imports and executes the real pinned package under Bun rather than
 * mocking it.
 */
const EXPECTED_OWF_VERSION = '0.5.4'

// Test-only certificate body, reused from the Phase 0 audit probe. It contains
// no personal data or usable private key.
const TEST_CERTIFICATE =
  'MIIBczCCARmgAwIBAgIUZt2jkmAgIIiw/wpvJU/4yL7ek/YwCgYIKoZIzj0EAwIwDzENMAsGA1UEAwwEdGVzdDAeFw0yNjAzMTYxODEwMTJaFw0zNjAzMTMxODEwMTJaMA8xDTALBgNVBAMMBHRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASa6ViWvoU/uOZiBHqFWLE/s+3Ts2K6XT9x2S+abUz/xu48DnP8eL89DQRS8TIUewZbW+H6GBuyFJjG/mSuqJf+o1MwUTAdBgNVHQ4EFgQUFDKBWF8aGWeDTQHphAhWXs9/J1AwHwYDVR0jBBgwFoAUFDKBWF8aGWeDTQHphAhWXs9/J1AwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEAibvAwfagitnTA7zKxcl8kuUaU+oBLClK8YXgs2WfHbwCIAQKqu6+GHkzWH8H0zMPKedvxJp34whrGoIarukWZjjp'

const sha256 = (value: string): string =>
  `sha256-${createHash('sha256').update(value).digest('base64')}`

function buildExampleSchemaMeta() {
  return schemaMeta()
    .id('https://example.com/attestations/gym-membership-card')
    .version('1.0.0')
    .rulebookURI('https://example.com/rulebooks/gym-membership/1.0.0.md')
    .rulebookIntegrity(sha256('rulebook'))
    .addTrustAuthority(
      trustAuthority()
        .frameworkType('etsi_tl')
        .value('https://example.com/trust-lists/gym-members.jws')
        .verificationMethod({
          type: 'X509Certificate',
          x509Certificate: TEST_CERTIFICATE,
        })
        .build(),
    )
    .attestationLoS('iso_18045_basic')
    .bindingType('key')
    .addSchemaURI(
      schemaURI()
        .format('dc+sd-jwt')
        .uri('https://example.com/gym.sd-jwt.json')
        .integrity(sha256('schema'))
        .meta({ vct: 'eu.example.gym.1' })
        .build(),
    )
    .build()
}

describe('OWF dependency smoke test', () => {
  test('the manifest and the installed package agree on the pinned tested version', () => {
    expect(applicationPackage.dependencies['@owf/eudi-attestation-schema']).toBe(
      EXPECTED_OWF_VERSION,
    )
    expect(owfPackage.name).toBe('@owf/eudi-attestation-schema')
    expect(owfPackage.version).toBe(EXPECTED_OWF_VERSION)
  })

  test('the real package builds and structurally validates a SchemaMeta document', () => {
    const schemaMetaDocument = buildExampleSchemaMeta()

    expect(validateSchemaMeta(schemaMetaDocument)).toEqual({ valid: true, errors: [] })
  })

  test('the real package rejects a document with a missing rulebook integrity value', () => {
    const withoutIntegrity: Record<string, unknown> = { ...buildExampleSchemaMeta() }
    delete withoutIntegrity.rulebookIntegrity

    expect(validateSchemaMeta(withoutIntegrity).valid).toBe(false)
  })
})
