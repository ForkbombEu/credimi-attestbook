#!/usr/bin/env node
/**
 * Reproducible audit probe for @owf/eudi-attestation-schema 0.5.4.
 *
 * The probe records observable behaviour of the published package; it is not a
 * substitute for the standards analysis in docs/standards.md. Run it with Node
 * (>=20) or Bun after `npm install` / `bun install`.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ES256 } from '@owf/crypto'
import { base64urlDecode, base64urlEncode } from '@owf/identity-common'
import * as owf from '@owf/eudi-attestation-schema'

const EXPECTED_VERSION = '0.5.4'
const installedPackage = JSON.parse(
  readFileSync(new URL('./node_modules/@owf/eudi-attestation-schema/package.json', import.meta.url), 'utf8')
)

let checks = 0
const ok = (message) => {
  checks += 1
  console.log(`  ok  ${message}`)
}
const section = (name) => console.log(`\n## ${name}`)
const sri = (value) => `sha256-${createHash('sha256').update(value).digest('base64')}`

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBczCCARmgAwIBAgIUZt2jkmAgIIiw/wpvJU/4yL7ek/YwCgYIKoZIzj0EAwIw
DzENMAsGA1UEAwwEdGVzdDAeFw0yNjAzMTYxODEwMTJaFw0zNjAzMTMxODEwMTJa
MA8xDTALBgNVBAMMBHRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASa6ViW
voU/uOZiBHqFWLE/s+3Ts2K6XT9x2S+abUz/xu48DnP8eL89DQRS8TIUewZbW+H6
GBuyFJjG/mSuqJf+o1MwUTAdBgNVHQ4EFgQUFDKBWF8aGWeDTQHphAhWXs9/J1Aw
HwYDVR0jBBgwFoAUFDKBWF8aGWeDTQHphAhWXs9/J1AwDwYDVR0TAQH/BAUwAwEB
/zAKBggqhkjOPQQDAgNIADBFAiEAibvAwfagitnTA7zKxcl8kuUaU+oBLClK8YXg
s2WfHbwCIAQKqu6+GHkzWH8H0zMPKedvxJp34whrGoIarukWZjjp
-----END CERTIFICATE-----`

const baseMeta = () =>
  owf
    .schemaMeta()
    .id('https://example.com/attestations/gym-membership-card')
    .version('1.0.0')
    .rulebookURI('https://example.com/rulebooks/gym-membership/1.0.0.md')
    .rulebookIntegrity(sri('rulebook'))
    .addTrustAuthority(
      owf
        .trustAuthority()
        .frameworkType('etsi_tl')
        .value('https://example.com/trust-lists/gym-members.jws')
        .verificationMethod({
          type: 'X509Certificate',
          x509Certificate: 'MIIBczCCARmgAwIBAgIUZt2jkmAgIIiw/wpvJU/4yL7ek/YwCgYIKoZIzj0EAwIw',
        })
        .build()
    )
    .addTrustAuthority(
      owf
        .trustAuthority()
        .frameworkType('x509')
        .value('MIIBczCCARmgAwIBAgIUZt2jkmAgIIiw/wpvJU/4yL7ek/YwCgYIKoZIzj0EAwIw')
        .build()
    )
    .attestationLoS('iso_18045_basic')
    .bindingType('key')
    .addSchemaURI(
      owf
        .schemaURI()
        .format('dc+sd-jwt')
        .uri('https://example.com/gym.sd-jwt.json')
        .integrity(sri('schema'))
        .meta({ vct: 'eu.example.gym.1' })
        .build()
    )
    .issuanceProfile({
      credentialSigningAlgValuesSupported: ['ES256'],
      proofTypesSupported: { jwt: { proof_signing_alg_values_supported: ['ES256'] } },
      keyAttestationRequired: true,
      maxValidityPeriod: 3600,
    })
    .build()

const rawJws = async (signer, header, payload) => {
  const encodedHeader = base64urlEncode(JSON.stringify(header))
  const encodedPayload = base64urlEncode(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = await signer(signingInput)
  return `${signingInput}.${signature}`
}

async function main() {
  section('Package and public surface')
  console.log(`  package ${installedPackage.name}@${installedPackage.version}`)
  assert.equal(installedPackage.version, EXPECTED_VERSION)
  ok(`installed version is ${EXPECTED_VERSION}`)

  const runtimeExports = Object.keys(owf).sort()
  assert.equal(runtimeExports.length, 46)
  for (const name of [
    'schemaMeta',
    'schemaURI',
    'trustAuthority',
    'validateSchemaMeta',
    'assertValidSchemaMeta',
    'signSchemaMeta',
    'verifySchemaMeta',
    'resolveSchemaReferences',
    'buildDcqlFromSchemaMeta',
    'buildCredentialConfigurationTemplate',
    'validateIssuerMetadataAgainstProfile',
    'verifyResolveAndBuildDcql',
  ]) {
    assert.equal(typeof owf[name], 'function', `missing runtime export ${name}`)
  }
  ok(`runtime exports found (${runtimeExports.length}); expected functions are present`)
  ok(`no credential validator export: ${String(owf.validateCredential)}`)

  section('Creation and structural validation')
  const meta = baseMeta()
  assert.deepEqual(owf.validateSchemaMeta(meta), { valid: true, errors: [] })
  ok('builders produce a document accepted by validateSchemaMeta')

  const missingIntegrity = structuredClone(meta)
  delete missingIntegrity.rulebookIntegrity
  assert.equal(owf.validateSchemaMeta(missingIntegrity).valid, false)
  ok('missing rulebookIntegrity is rejected')

  assert.equal(owf.validateSchemaMeta({ ...meta, version: '1.0' }).valid, false)
  ok('non-SemVer version is rejected')

  const missingSchemaIntegrity = structuredClone(meta)
  delete missingSchemaIntegrity.schemaURIs[0].integrity
  assert.equal(owf.validateSchemaMeta(missingSchemaIntegrity).valid, false)
  ok('missing schemaURI integrity is rejected')

  const missingSchemaMeta = structuredClone(meta)
  delete missingSchemaMeta.schemaURIs[0].meta
  assert.equal(owf.validateSchemaMeta(missingSchemaMeta).valid, false)
  ok('missing schemaURI meta is rejected')

  assert.equal(owf.validateSchemaMeta({ ...meta, id: 'not-a-url' }).valid, false)
  ok('non-URL id is rejected')

  assert.equal(owf.validateSchemaMeta({ ...meta, iat: 123.5 }).valid, false)
  ok('non-integer iat is rejected')

  assert.equal(owf.validateSchemaMeta({ ...meta, rulebookIntegrity: 'sha512-abc' }).valid, false)
  ok('non-sha256 SRI integrity is rejected')

  assert.equal(owf.validateSchemaMeta({ ...meta, schemaURIs: [] }).valid, false)
  ok('empty schemaURIs is rejected')

  assert.equal(owf.validateSchemaMeta({ ...meta, bindingType: 'none' }).valid, false)
  ok('bindingType none with binding/proof constraints is rejected')

  assert.equal(
    owf.validateSchemaMeta({
      ...meta,
      schemaURIs: [meta.schemaURIs[0], { ...meta.schemaURIs[0], uri: 'https://example.com/other.json' }],
    }).valid,
    false
  )
  ok('duplicate schemaURI formatIdentifier is rejected')

  const withExtraMembers = { ...meta, supportedFormats: ['dc+sd-jwt'], isLOTE: true }
  assert.equal(owf.validateSchemaMeta(withExtraMembers).valid, true)
  ok('unknown top-level members are accepted by validateSchemaMeta')

  const asserted = structuredClone(withExtraMembers)
  owf.assertValidSchemaMeta(asserted)
  assert.equal(Object.hasOwn(asserted, 'supportedFormats'), true)
  ok('assertValidSchemaMeta leaves unknown top-level members in place')

  const parsed = owf.SchemaMetaSchema.parse(withExtraMembers)
  assert.equal(Object.hasOwn(parsed, 'supportedFormats'), false)
  assert.equal(Object.hasOwn(parsed, 'isLOTE'), false)
  ok('SchemaMetaSchema.parse silently strips unknown top-level members')

  // TS11 v1.0.1-shaped document: id is a UUID, no OWF-only integrity fields,
  // no SchemaURI.meta, and TS11 trust framework values.
  const ts11Document = {
    id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    version: '1.0.0',
    rulebookURI: 'https://example.com/rulebook.md#integrity=sha256-abc',
    trustedAuthorities: [
      { frameworkType: 'aki', value: 'Y3VzdG9tLWFraQ' },
      { frameworkType: 'etsi_tl', value: 'https://example.com/trust-list', isLOTE: true },
      { frameworkType: 'openid_federation', value: 'https://example.com/federation' },
    ],
    attestationLoS: 'iso_18045_basic',
    bindingType: 'key',
    supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
    schemaURIs: [
      { formatIdentifier: 'dc+sd-jwt', uri: 'https://example.com/pid.dc+sd-jwt.json' },
      { formatIdentifier: 'mso_mdoc', uri: 'https://example.com/pid.mdoc.json' },
    ],
  }
  const ts11Result = owf.validateSchemaMeta(ts11Document)
  assert.equal(ts11Result.valid, false)
  for (const path of ['rulebookIntegrity', 'schemaURIs.0.integrity', 'schemaURIs.0.meta']) {
    assert.ok(ts11Result.errors.some((error) => error.path === path), `missing expected error ${path}`)
  }
  ok('a TS11 v1.0.1-shaped SchemaMeta document is rejected (see docs/standards.md)')

  section('Signing and verification')
  const { privateKey, publicKey } = await ES256.generateKeyPair()
  const signer = await ES256.getSigner(privateKey)
  const verifier = await ES256.getVerifier(publicKey)
  const signed = await owf.signSchemaMeta({
    schemaMeta: meta,
    keyId: 'audit-key-1',
    certificates: [TEST_CERT],
    signer,
  })
  const [, encodedPayload] = signed.jws.split('.')
  const jwsPayload = JSON.parse(base64urlDecode(encodedPayload))
  assert.equal(typeof jwsPayload.iat, 'number')
  assert.equal(Object.hasOwn(signed.payload, 'iat'), false)
  ok('signSchemaMeta injects iat into the JWS payload but not into result.payload')

  const verified = await owf.verifySchemaMeta({ jws: signed.jws, verifier })
  assert.equal(verified.payload.version, '1.0.0')
  assert.equal(verified.header.typ, 'attestation-schema+jwt')
  ok('valid JWS verifies and the schema payload is validated')

  const [headerPart, payloadPart, signaturePart] = signed.jws.split('.')
  const tamperedSignature = `${signaturePart[0] === 'A' ? 'B' : 'A'}${signaturePart.slice(1)}`
  await assert.rejects(
    owf.verifySchemaMeta({ jws: `${headerPart}.${payloadPart}.${tamperedSignature}`, verifier }),
    /Invalid signature/
  )
  ok('a tampered signature is rejected')

  const basePayload = { ...meta, iat: Math.floor(Date.now() / 1000) }

  const acceptedHeaders = []
  for (const [label, header, payload] of [
    ['typ=JWT', { alg: 'ES256', typ: 'JWT', kid: 'k1' }, basePayload],
    ['no x5c', { alg: 'ES256', typ: 'attestation-schema+jwt', kid: 'k1' }, basePayload],
    ['alg=none', { alg: 'none', typ: 'attestation-schema+jwt', kid: 'k1' }, basePayload],
    ['alg=RS256 over ES256 signature', { alg: 'RS256', typ: 'attestation-schema+jwt', kid: 'k1' }, basePayload],
    ['empty kid', { alg: 'ES256', typ: 'attestation-schema+jwt', kid: '', x5c: [] }, basePayload],
    ['no iat', { alg: 'ES256', typ: 'attestation-schema+jwt', kid: 'k1' }, meta],
  ]) {
    const jws = await rawJws(signer, header, payload)
    const observed = await owf.verifySchemaMeta({ jws, verifier })
    acceptedHeaders.push(`${label} -> header=${JSON.stringify(observed.header)}, iat=${observed.iat}`)
  }
  assert.equal(acceptedHeaders.length, 6)
  ok('verifySchemaMeta accepts inconsistent JOSE headers and a payload without iat')
  for (const observation of acceptedHeaders) console.log(`      observed: ${observation}`)

  const noIatJws = await rawJws(signer, { alg: 'ES256', typ: 'attestation-schema+jwt', kid: 'k1' }, meta)
  const noIatVerified = await owf.verifySchemaMeta({ jws: noIatJws, verifier })
  assert.ok(Math.abs(noIatVerified.iat - Math.floor(Date.now() / 1000)) < 10)
  ok('missing iat is replaced with the verifier current time')

  const zeroIatJws = await rawJws(
    signer,
    { alg: 'ES256', typ: 'attestation-schema+jwt', kid: 'k1' },
    { ...meta, iat: 0 }
  )
  const zeroIatVerified = await owf.verifySchemaMeta({ jws: zeroIatJws, verifier })
  assert.ok(Math.abs(zeroIatVerified.iat - Math.floor(Date.now() / 1000)) < 10)
  ok('iat=0 is also replaced with the verifier current time')

  const invalidSigned = await owf.signSchemaMeta({
    schemaMeta: { ...meta, schemaURIs: undefined },
    keyId: 'audit-key-1',
    certificates: [],
    signer,
    algorithm: 'RS256',
  })
  assert.equal(invalidSigned.header.alg, 'RS256')
  assert.deepEqual(invalidSigned.header.x5c, [])
  ok('signSchemaMeta signs unvalidated input and does not bind alg to the signer key')
  await assert.rejects(owf.verifySchemaMeta({ jws: invalidSigned.jws, verifier }), /Invalid SchemaMeta payload/)

  // The fixed certificate is unrelated to the generated key pair used for signing.
  assert.notEqual(verified.header.x5c[0], undefined)
  ok('verification succeeds while the x5c certificate is not checked against the signing key')

  section('Reference resolution, integrity and DCQL')
  const schemaDocument = {
    type: 'object',
    properties: {
      given_name: { type: 'string' },
      family_name: { type: 'string' },
      address: {
        type: 'object',
        properties: { street_address: { type: 'string' }, country: { type: 'string' } },
      },
      nationalities: { type: 'array', items: { type: 'string' } },
    },
  }
  const typeMetadataDocument = {
    vct: 'eu.example.gym.1',
    claims: [
      { path: ['given_name'], sd: 'allowed' },
      { path: ['address', 'country'], sd: 'always' },
    ],
  }
  const schemaText = JSON.stringify(schemaDocument)
  const typeMetadataText = JSON.stringify(typeMetadataDocument)
  const metaWithBothFormats = owf
    .schemaMeta()
    .id('https://example.com/attestations/gym')
    .version('1.0.0')
    .rulebookURI('https://example.com/rulebook.md')
    .rulebookIntegrity(sri('rulebook'))
    .addTrustAuthority(
      owf
        .trustAuthority()
        .frameworkType('etsi_tl')
        .value('https://example.com/tl.jws')
        .verificationMethod({
          type: 'X509Certificate',
          x509Certificate: 'MIIBczCCARmgAwIBAgIUZt2jkmAgIIiw/wpvJU/4yL7ek/YwCgYIKoZIzj0EAwIw',
        })
        .build()
    )
    .addTrustAuthority(
      owf
        .trustAuthority()
        .frameworkType('x509')
        .value('MIIBczCCARmgAwIBAgIUZt2jkmAgIIiw/wpvJU/4yL7ek/YwCgYIKoZIzj0EAwIw')
        .build()
    )
    .attestationLoS('iso_18045_basic')
    .bindingType('key')
    .addSchemaURI(
      owf
        .schemaURI()
        .format('dc+sd-jwt')
        .uri('https://example.com/gym.sd-jwt.json')
        .integrity(sri(typeMetadataText))
        .meta({ vct: 'eu.example.gym.1' })
        .build()
    )
    .addSchemaURI(
      owf
        .schemaURI()
        .format('mso_mdoc')
        .uri('https://example.com/gym.mdoc.json')
        .integrity(sri(schemaText))
        .meta({ doctype_value: 'eu.example.gym.1' })
        .build()
    )
    .build()

  const resolve = async (uri) => ({
    content: uri.endsWith('.sd-jwt.json') ? typeMetadataText : schemaText,
    contentType: 'application/json',
  })
  const resolved = await owf.resolveSchemaReferences({ schemaMeta: metaWithBothFormats, resolve })
  assert.equal(resolved.length, 2)
  assert.equal(resolved[0].typeMetadata?.claims?.length, 2)
  assert.equal(resolved[1].parsedSchema?.type, 'object')
  ok('SRI integrity is verified over transferred bytes and both reference formats resolve')

  const dcql = owf.buildDcqlFromSchemaMeta({
    schemaMeta: metaWithBothFormats,
    selectedFormats: ['dc+sd-jwt', 'mso_mdoc'],
    resolvedReferences: resolved,
    includeTrustedAuthorities: true,
  })
  assert.equal(dcql.credentials.length, 2)
  assert.equal(dcql.credentials[0].claims.length, 2)
  assert.deepEqual(owf.toDcqlTrustedAuthorities(metaWithBothFormats), [
    { type: 'etsi_tl', values: ['https://example.com/tl.jws'] },
  ])
  ok('DCQL claims are derived; only etsi_tl authorities are mapped (x509 is dropped)')

  await assert.rejects(
    owf.resolveSchemaReferences({
      schemaMeta: (() => {
        const bad = structuredClone(metaWithBothFormats)
        bad.schemaURIs[1].integrity = sri('not-the-content')
        return bad
      })(),
      selectedFormats: ['mso_mdoc'],
      resolve: async () => ({ content: schemaText }),
    }),
    /integrity mismatch/
  )
  ok('an SRI mismatch is rejected')

  await assert.rejects(
    owf.resolveSchemaReferences({
      schemaMeta: metaWithBothFormats,
      selectedFormats: ['mso_mdoc'],
      resolve: async () => ({ content: JSON.parse(schemaText) }),
    }),
    /parsed content/
  )
  ok('already-parsed content is rejected when integrity verification is enabled')

  const parsedAccepted = await owf.resolveSchemaReferences({
    schemaMeta: metaWithBothFormats,
    selectedFormats: ['mso_mdoc'],
    verifyIntegrity: false,
    resolve: async () => ({ content: JSON.parse(schemaText) }),
  })
  assert.equal(parsedAccepted.length, 1)
  ok('verifyIntegrity:false accepts parsed content and skips SRI checking')

  section('Issuer metadata helpers')
  const template = owf.buildCredentialConfigurationTemplate({
    schemaMeta: metaWithBothFormats,
    format: 'dc+sd-jwt',
    resolvedReferences: resolved,
  })
  assert.equal(template.credentialConfiguration.vct, 'eu.example.gym.1')
  assert.equal(Object.hasOwn(template.credentialConfiguration, 'scope'), false)
  ok('credential configuration template omits deployment fields and lists them separately')

  const issuerMetadata = {
    credential_configurations_supported: {
      'eu.example.gym.1': {
        format: 'dc+sd-jwt',
        vct: 'eu.example.gym.1',
        credential_signing_alg_values_supported: ['ES256'],
        proof_types_supported: {
          jwt: { proof_signing_alg_values_supported: ['ES256'], key_attestations_required: {} },
        },
      },
    },
  }
  assert.deepEqual(
    owf.validateIssuerMetadataAgainstProfile({
      issuerMetadata,
      schemaMeta: baseMeta(),
      format: 'dc+sd-jwt',
    }),
    { valid: true, errors: [] }
  )
  ok('issuer metadata matching the optional issuanceProfile validates')

  const disallowed = owf.validateIssuerMetadataAgainstProfile({
    issuerMetadata: {
      credential_configurations_supported: {
        x: {
          format: 'dc+sd-jwt',
          vct: 'eu.example.gym.1',
          credential_signing_alg_values_supported: ['ES384'],
          proof_types_supported: { jwt: { proof_signing_alg_values_supported: ['ES384'] } },
        },
      },
    },
    schemaMeta: baseMeta(),
    format: 'dc+sd-jwt',
  })
  assert.equal(disallowed.valid, false)
  ok('issuer metadata outside the issuanceProfile is rejected')

  section('End-to-end helper')
  const endToEnd = await owf.verifyResolveAndBuildDcql({
    jws: (await owf.signSchemaMeta({ schemaMeta: metaWithBothFormats, keyId: 'k1', certificates: [TEST_CERT], signer })).jws,
    verifier,
    selectedFormats: ['dc+sd-jwt'],
    resolve,
    includeTrustedAuthorities: true,
  })
  assert.equal(endToEnd.dcql.credentials.length, 1)
  ok('verifyResolveAndBuildDcql verifies, resolves and builds DCQL in one call')

  section('Summary')
  console.log(`  package: ${installedPackage.name}@${installedPackage.version}`)
  console.log(`  runtime exports: ${runtimeExports.length}`)
  console.log(`  checks passed: ${checks}`)
  console.log('  TS11 v1.0.1 SchemaMeta compatible: no (see docs/standards.md)')
  console.log('  credential validation API: absent')
}

main().catch((error) => {
  console.error('\nPROBE FAILED')
  console.error(error)
  process.exitCode = 1
})
