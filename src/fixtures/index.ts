// Public surface of the rulebook-driven issuer fixture module (FR-013, #44).
//
// See docs/fixtures.md for the supported synthesis subset, the unsigned-payload
// boundary and the negative-case derivation rules.

export {
  IssuerFixtureGenerator,
  IssuerFixtureUnavailableError,
  type IssuerFixtureGeneratorOptions,
} from './generate'

export {
  MAX_FIXTURE_OVERRIDE_PATH_LENGTH,
  MAX_FIXTURE_OVERRIDES,
  parseGenerateIssuerFixtureInput,
} from './request'

export {
  ISSUER_FIXTURE_KIND,
  ISSUER_FIXTURE_NEGATIVE_CATEGORIES,
  ISSUER_FIXTURE_PATH,
  type GenerateIssuerFixtureInput,
  type IssuerFixtureAttribute,
  type IssuerFixtureAttestationEvidence,
  type IssuerFixtureDiagnostic,
  type IssuerFixtureFinding,
  type IssuerFixtureNegativeCase,
  type IssuerFixtureNegativeCategory,
  type IssuerFixtureOverride,
  type IssuerFixtureOverrideInput,
  type IssuerFixturePayloadValidation,
  type IssuerFixtureResult,
  type IssuerFixtureRulebookEvidence,
  type IssuerFixtureSchemaReferenceEvidence,
  type IssuerFixtureService,
  type IssuerFixtureSource,
} from './types'
