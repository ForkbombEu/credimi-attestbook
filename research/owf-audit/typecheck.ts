/**
 * Compile-only probe for the public TypeScript surface of
 * @owf/eudi-attestation-schema 0.5.4.
 *
 * Run with `npm run typecheck`. This file is never executed.
 */

import {
  buildCredentialConfigurationTemplate,
  buildDcqlFromSchemaMeta,
  schemaMeta,
  schemaURI,
  trustAuthority,
  validateIssuerMetadataAgainstProfile,
  validateSchemaMeta,
  type BuildDcqlFromSchemaMetaResult,
  type CredentialConfigurationTemplate,
  type ResolveSchemaReferencesOptions,
  type SchemaMeta,
  type SchemaURI,
  type TrustAuthority,
  type ValidationResult,
} from '@owf/eudi-attestation-schema'

const authority: TrustAuthority = trustAuthority()
  .frameworkType('etsi_tl')
  .value('https://example.com/trust-list.jws')
  .verificationMethod({
    type: 'X509Certificate',
    x509Certificate: 'MIIBczCCARmgAwIBAgIUZt2jkmAgIIiw/wpvJU/4yL7ek/YwCgYIKoZIzj0EAwIw',
  })
  .build()

const schema: SchemaURI = schemaURI()
  .format('dc+sd-jwt')
  .uri('https://example.com/schema.json')
  .integrity('sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
  .meta({ vct: 'eu.example.test.1' })
  .build()

const meta: SchemaMeta = schemaMeta()
  .id('https://example.com/attestations/test')
  .version('1.0.0')
  .rulebookURI('https://example.com/rulebook.md')
  .rulebookIntegrity('sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
  .addTrustAuthority(authority)
  .attestationLoS('iso_18045_basic')
  .bindingType('none')
  .addSchemaURI(schema)
  .build()

const validation: ValidationResult = validateSchemaMeta(meta)
const resolverOptions: ResolveSchemaReferencesOptions = {
  schemaMeta: meta,
  resolve: async () => ({ content: '{}' }),
}
const dcql: BuildDcqlFromSchemaMetaResult = buildDcqlFromSchemaMeta({
  schemaMeta: meta,
  selectedFormats: ['dc+sd-jwt'],
})
const template: CredentialConfigurationTemplate = buildCredentialConfigurationTemplate({
  schemaMeta: meta,
  format: 'dc+sd-jwt',
})
const issuerMetadataValidation: ValidationResult = validateIssuerMetadataAgainstProfile({
  issuerMetadata: {},
  schemaMeta: meta,
  format: 'dc+sd-jwt',
})

void [validation, resolverOptions, dcql, template, issuerMetadataValidation]
