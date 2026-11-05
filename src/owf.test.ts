import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

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
 * mocking it. The `overrides` in package.json keep the transitive tree at the
 * exact versions exercised by the Phase 0 audit.
 */
const EXPECTED_OWF_VERSION = '0.5.4'
const EXPECTED_TRANSITIVE_VERSIONS = {
  '@owf/cose': '0.6.2',
  '@owf/crypto': '0.6.2',
  '@owf/identity-common': '0.6.2',
  '@owf/token-status-list': '0.6.2',
  '@sd-jwt/core': '0.24.1',
  '@sd-jwt/sd-jwt-vc': '0.24.1',
  zod: '4.6.7',
} as const

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

function readInstalledVersion(packageName: string): string {
  const manifestPath = new URL(`../node_modules/${packageName}/package.json`, import.meta.url)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version: string
  }

  return manifest.version
}

describe('OWF dependency smoke test', () => {
  test('the manifest and the installed package agree on the pinned tested version', () => {
    expect(applicationPackage.dependencies['@owf/eudi-attestation-schema']).toBe(
      EXPECTED_OWF_VERSION,
    )
    expect(owfPackage.name).toBe('@owf/eudi-attestation-schema')
    expect(owfPackage.version).toBe(EXPECTED_OWF_VERSION)
  })

  test('overrides keep the audited transitive dependency tree', () => {
    for (const [packageName, expectedVersion] of Object.entries(EXPECTED_TRANSITIVE_VERSIONS)) {
      expect({
        packageName,
        version: readInstalledVersion(packageName),
      }).toEqual({ packageName, version: expectedVersion })
    }
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
