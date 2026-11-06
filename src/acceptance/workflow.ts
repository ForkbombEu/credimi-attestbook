// Phase 1 end-to-end acceptance workflow (issue #39).
//
// This module drives the real application over its HTTP surface: it imports a
// TS11 v1.0.1 rulebook from JSON, inspects and publishes an immutable version,
// validates a real signed SD-JWT VC with dimension-aware evidence, exports that
// evidence, and runs the negative cases that prove schema, cryptographic, trust
// and interoperability results are not conflated. It uses a real temporary
// SQLite database and the real migrations, registry, import pipeline, validation
// engine and built UI assets. Only the credential fixture and the TS11/OWF
// documents are synthetic.
//
// `runAcceptance` throws when any acceptance check fails. The CLI in
// `./cli.ts` writes the returned evidence as JSON and prints a summary.

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateSchemaMeta } from '@owf/eudi-attestation-schema'
import owfPackage from '@owf/eudi-attestation-schema/package.json'

import applicationPackage from '../../package.json'
import type {
  AttestationDetailResource,
  CredentialValidationResource,
  ImportPreviewResource,
  ImportResultResource,
  RulebookResource,
  RulebookVersionDocumentResource,
  RulebookVersionResource,
  SchemaReferenceResource,
} from '../api/schemas'
import { createApp } from '../app'
import { openDatabase } from '../db/database'
import { applyMigrations } from '../db/migrations'
import { RulebookImporter } from '../import'
import { provisionProvider } from '../registry/bootstrap'
import { Registry } from '../registry/registry'
import { CredentialValidator } from '../validation'
import { defaultCredentialClaims, issueTestCredential } from '../validation/test-support'

import {
  SCHEMA_DOCUMENT_TEXT,
  SCHEMA_URI,
  VCT,
  invalidTs11Document,
  owfDocument,
  sha256Sri,
  ts11Document,
} from './fixtures'

export interface AcceptanceCheck {
  readonly id: string
  readonly description: string
  readonly passed: boolean
  readonly detail?: string
}

export interface ValidationSummary {
  readonly overallStatus: CredentialValidationResource['overallStatus']
  readonly dimensions: readonly {
    readonly id: string
    readonly status: string
    readonly applicable: boolean
    readonly executed: boolean
    readonly findingCodes: readonly string[]
  }[]
  readonly limitationCodes: readonly string[]
  readonly violationCodes: readonly string[]
  readonly rulebookVersion: string
  readonly rulebookDigest: string
  readonly digestVerified: boolean
  readonly exportedEvidenceBytes: number
}

export interface AcceptanceEvidence {
  readonly generatedAt: string
  readonly appVersion: string
  readonly owf: {
    readonly packageVersion: string
    readonly validDocument: boolean
    readonly ts11DocumentRejectedByOwf: boolean
    readonly owfImportProfile: string
    readonly owfImportConformance: string
    readonly owfImportCompatible: boolean
  }
  readonly importPreview: {
    readonly compatible: boolean
    readonly structuralStatus: string
    readonly profile: string
    readonly conformance: string
    readonly schemaReferenceCount: number
    readonly limitations: readonly string[]
  }
  readonly rulebook: {
    readonly id: string
    readonly name: string
    readonly publicationStatus: string
    readonly attestationCount: number
    readonly schemaReferenceCount: number
    readonly schemaUri: string
    readonly schemaIntegrity: string
  }
  readonly version: {
    readonly label: string
    readonly status: string
    readonly contentDigest: string
    readonly recomputedDigest: string
    readonly specVersion: string
    readonly snapshotHasNormativeFields: boolean
  }
  readonly valid: ValidationSummary
  readonly negativeMissingClaim: ValidationSummary
  readonly negativeUnsupportedFormat: ValidationSummary
  readonly negativeNoSchemaDocument: ValidationSummary
  readonly nonConflation: {
    readonly structuralPassIsNotOverallPass: boolean
    readonly cryptographicVerificationNotTested: boolean
    readonly issuerTrustNotTested: boolean
    readonly protocolNotApplicable: boolean
    readonly interoperabilityNotApplicable: boolean
    readonly schemaFailureDoesNotBecomeSchemaPass: boolean
    readonly unsupportedFormatIsNotReportedPass: boolean
    readonly credentialNotInExportedEvidence: boolean
  }
  readonly ui: {
    readonly checked: boolean
    readonly servedRoutes: readonly string[]
  }
  readonly checks: readonly AcceptanceCheck[]
}

/** A failed acceptance check; the message names every failed check. */
export class AcceptanceError extends Error {
  readonly checks: readonly AcceptanceCheck[]

  constructor(checks: readonly AcceptanceCheck[]) {
    const failed = checks.filter((check) => !check.passed)
    super(
      `Phase 1 acceptance failed ${failed.length} check(s):\n` +
        failed.map((check) => `- ${check.id}: ${check.description}`).join('\n'),
    )
    this.name = 'AcceptanceError'
    this.checks = checks
  }
}

class Checker {
  readonly checks: AcceptanceCheck[] = []

  ok(id: string, description: string, condition: boolean, detail?: string): boolean {
    const passed = condition === true
    this.checks.push({
      id,
      description,
      passed,
      ...(detail === undefined ? {} : { detail }),
    })
    return passed
  }

  equal(id: string, description: string, actual: unknown, expected: unknown): boolean {
    return this.ok(
      id,
      description,
      Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
  }

  finish(): void {
    if (this.checks.some((check) => !check.passed)) {
      throw new AcceptanceError(this.checks)
    }
  }
}

interface JsonData<T> {
  readonly data: T
}

interface ErrorEnvelope {
  readonly error: { readonly code: string; readonly message: string }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function summarize(result: CredentialValidationResource, exportedText: string): ValidationSummary {
  return {
    overallStatus: result.overallStatus,
    dimensions: result.dimensions.map((dimension) => ({
      id: dimension.id,
      status: dimension.status,
      applicable: dimension.applicable,
      executed: dimension.executed,
      findingCodes: dimension.findings.map((finding) => finding.code),
    })),
    limitationCodes: result.limitations.map((limitation) => limitation.code),
    violationCodes: result.violations.map((violation) => violation.code),
    rulebookVersion: result.rulebook.version,
    rulebookDigest: result.rulebook.digest,
    digestVerified: result.rulebook.digestVerified,
    exportedEvidenceBytes: Buffer.byteLength(exportedText, 'utf8'),
  }
}

function dimension(result: CredentialValidationResource, id: string) {
  return result.dimensions.find((entry) => entry.id === id)
}

function assertDimension(
  checker: Checker,
  result: CredentialValidationResource,
  id: string,
  expected: { status: string; applicable: boolean; executed: boolean },
  label: string,
): void {
  const found = dimension(result, id)
  checker.ok(`${label}.dimension.${id}.present`, `${label}: ${id} is reported`, found !== undefined)
  if (found === undefined) {
    return
  }
  checker.equal(
    `${label}.dimension.${id}.status`,
    `${label}: ${id} is ${expected.status}`,
    found.status,
    expected.status,
  )
  checker.equal(
    `${label}.dimension.${id}.applicable`,
    `${label}: ${id} applicability is ${String(expected.applicable)}`,
    found.applicable,
    expected.applicable,
  )
  checker.equal(
    `${label}.dimension.${id}.executed`,
    `${label}: ${id} execution is ${String(expected.executed)}`,
    found.executed,
    expected.executed,
  )
}

export interface AcceptanceOptions {
  /**
   * Directory containing the built UI, `false` to skip the UI-asset checks
   * (the unit-test job has no build output), or omitted to use `./dist/ui`.
   */
  readonly uiRoot?: string | false
  /** Clock used for evidence metadata. */
  readonly now?: () => string
}

/**
 * Runs the complete Phase 1 acceptance workflow. The application is built in
 * process from a fresh temporary SQLite database; no listener or external
 * service is required.
 */
export async function runAcceptance(
  options: AcceptanceOptions = {},
): Promise<{ readonly evidence: AcceptanceEvidence; readonly checks: readonly AcceptanceCheck[] }> {
  const checker = new Checker()
  const directory = mkdtempSync(join(tmpdir(), 'attestbook-acceptance-'))
  const database = openDatabase(join(directory, 'acceptance.sqlite'))
  const now = options.now ?? (() => new Date().toISOString())

  try {
    applyMigrations(database, { now: () => '2026-01-01T00:00:00.000Z' })
    checker.ok('migrations.applied', 'all checked-in migrations apply to an empty database', true)

    const registry = new Registry({ database, now })
    const importer = new RulebookImporter({ registry })
    const validation = new CredentialValidator({ source: registry, now })
    const uiRoot = options.uiRoot ?? './dist/ui'
    const uiAvailable = uiRoot !== false && existsSync(join(uiRoot, 'index.html'))
    const app = createApp({
      registry,
      importer,
      validation,
      ...(uiAvailable ? { uiRoot } : {}),
    })
    const server = { app }

    const provider = provisionProvider(database, {
      name: 'Acceptance Issuer',
      publicationAuthority: 'acceptance-issuer',
      tokenLabel: 'acceptance',
    })
    const token = provider.token.secret

    const requestJson = async <T>(
      method: string,
      path: string,
      body?: unknown,
      bearer?: string,
    ): Promise<{ status: number; data: T; headers: Headers }> => {
      const response = await server.app.request(path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      const parsed = text === '' ? undefined : (JSON.parse(text) as T)
      return { status: response.status, data: parsed as T, headers: response.headers }
    }

    // ---------------------------------------------------------- OWF package
    checker.equal(
      'owf.package.version',
      'the installed @owf/eudi-attestation-schema is the pinned 0.5.4 baseline',
      owfPackage.version,
      '0.5.4',
    )

    const owf = owfDocument()
    const owfValidDocument = validateSchemaMeta(owf).valid
    checker.ok(
      'owf.validDocument',
      'the real OWF package structurally validates an OWF 0.5.4 SchemaMeta built with its own builders',
      owfValidDocument,
    )
    const owfRejectsTs11 = validateSchemaMeta(ts11Document()).valid === false
    checker.ok(
      'owf.ts11.negative',
      'the real OWF package rejects a TS11 v1.0.1 document, so OWF parsing is never treated as TS11 validation',
      owfRejectsTs11,
    )

    const owfPreview = await requestJson<JsonData<ImportPreviewResource>>(
      'POST',
      '/api/v1/imports/preview',
      { source: { kind: 'json', content: JSON.stringify(owf), name: 'owf-badge.json' } },
      token,
    )
    const owfEntry = owfPreview.data?.data.entries[0]
    checker.equal(
      'owf.import.status',
      'the OWF document previews as a compatible entry',
      owfPreview.status,
      200,
    )
    checker.equal(
      'owf.import.profile',
      'the OWF document is classified with the OWF 0.5.4 profile',
      owfEntry?.profile,
      'owf@0.5.4',
    )
    checker.equal(
      'owf.import.conformance',
      'the OWF document is classified partial against the TS11 baseline',
      owfEntry?.conformance,
      'partial',
    )
    checker.ok(
      'owf.import.compatible',
      'the OWF entry is structurally valid and safe to import',
      owfEntry?.compatible === true && owfEntry?.structuralStatus === 'valid',
    )

    // ------------------------------------------------------ import TS11
    const ts11Text = JSON.stringify(ts11Document())
    const preview = await requestJson<JsonData<ImportPreviewResource>>(
      'POST',
      '/api/v1/imports/preview',
      { source: { kind: 'json', content: ts11Text, name: 'ts11-pid.json' } },
      token,
    )
    const previewEntry = preview.data?.data.entries[0]
    checker.equal('import.preview.status', 'the TS11 preview returns 200', preview.status, 200)
    checker.ok(
      'import.preview.compatible',
      'the TS11 entry is structurally valid, compatible and conformant with the pinned baseline',
      previewEntry?.structuralStatus === 'valid' &&
        previewEntry?.compatible === true &&
        previewEntry?.conformance === 'conformant_subset' &&
        previewEntry?.profile === 'ts11@1.0.1',
    )
    checker.equal(
      'import.preview.schemaReferences',
      'the preview retains the one pinned schema reference',
      previewEntry?.schemaReferences.length,
      1,
    )

    const imported = await requestJson<JsonData<ImportResultResource>>(
      'POST',
      '/api/v1/imports',
      { source: { kind: 'json', content: ts11Text, name: 'ts11-pid.json' } },
      token,
    )
    const importEntry = imported.data?.data.entries[0]
    checker.equal('import.status', 'the authenticated import returns 200', imported.status, 200)
    checker.equal(
      'import.disposition',
      'the new entry is created as a draft',
      importEntry?.disposition,
      'created',
    )
    const rulebookId = importEntry?.rulebookId
    checker.ok(
      'import.rulebookId',
      'the import returns the created rulebook id',
      typeof rulebookId === 'string',
    )

    if (typeof rulebookId !== 'string') {
      checker.finish()
      throw new Error('unreachable: a created rulebook id is required')
    }

    // ------------------------------------------- inspect the imported draft
    const rulebookRead = await requestJson<JsonData<RulebookResource>>(
      'GET',
      `/api/v1/rulebooks/${rulebookId}`,
    )
    const rulebook = rulebookRead.data?.data
    checker.equal(
      'rulebook.status',
      'the imported rulebook is a draft',
      rulebook?.publicationStatus,
      'draft',
    )
    checker.equal(
      'rulebook.specVersion',
      'the rulebook records the pinned TS11 specification version',
      rulebook?.applicableSpec,
      'ts11@1.0.1',
    )

    const attestationsRead = await requestJson<JsonData<readonly AttestationDetailResource[]>>(
      'GET',
      `/api/v1/rulebooks/${rulebookId}/attestations`,
    )
    const attestations = attestationsRead.data?.data ?? []
    const attestation = attestations[0]
    checker.equal(
      'attestations.count',
      'the imported working copy has one attestation type',
      attestations.length,
      1,
    )
    checker.equal(
      'attestations.los',
      'the attestation keeps the TS11 level of assurance',
      attestation?.attestationLoS,
      'iso_18045_high',
    )
    checker.equal(
      'attestations.binding',
      'the attestation keeps the TS11 binding type',
      attestation?.bindingType,
      'key',
    )
    checker.ok(
      'attestations.formats',
      'the attestation keeps the supported credential format',
      JSON.stringify(attestation?.supportedFormats) === JSON.stringify(['dc+sd-jwt']),
    )

    const referencesRead = await requestJson<JsonData<readonly SchemaReferenceResource[]>>(
      'GET',
      `/api/v1/rulebooks/${rulebookId}/schema-references`,
    )
    const reference = referencesRead.data?.data?.[0]
    checker.equal(
      'schemaReference.uri',
      'the schema reference URI is retained without its fragment',
      reference?.uri,
      SCHEMA_URI,
    )
    checker.equal(
      'schemaReference.integrity',
      'the W3C SRI pin is retained as a separate integrity value',
      reference?.integrity,
      sha256Sri(SCHEMA_DOCUMENT_TEXT),
    )

    // --------------------------------------- freeze and publish a version
    const attestationName = attestation?.name
    checker.ok(
      'attestation.name',
      'the imported attestation type has a name',
      typeof attestationName === 'string',
    )
    if (typeof attestationName !== 'string') {
      checker.finish()
      throw new Error('unreachable: an attestation name is required')
    }

    const createdVersion = await requestJson<JsonData<RulebookVersionResource>>(
      'POST',
      `/api/v1/rulebooks/${rulebookId}/versions`,
      { version: '1.0.0' },
      token,
    )
    checker.equal(
      'version.create.status',
      'freezing the working copy returns 201',
      createdVersion.status,
      201,
    )
    checker.equal(
      'version.create.statusValue',
      'the frozen version starts as a draft',
      createdVersion.data?.data.status,
      'draft',
    )

    const published = await requestJson<JsonData<RulebookVersionResource>>(
      'POST',
      `/api/v1/rulebooks/${rulebookId}/versions/1.0.0/publish`,
      {},
      token,
    )
    checker.equal(
      'version.publish.status',
      'publishing the draft returns 200',
      published.status,
      200,
    )
    checker.equal(
      'version.publish.statusValue',
      'the version is published',
      published.data?.data.status,
      'published',
    )

    const versionsRead = await requestJson<JsonData<readonly RulebookVersionResource[]>>(
      'GET',
      `/api/v1/rulebooks/${rulebookId}/versions`,
    )
    const versions = versionsRead.data?.data ?? []
    checker.equal('versions.count', 'the rulebook has one immutable version', versions.length, 1)
    checker.equal('versions.label', 'the version label is retained', versions[0]?.version, '1.0.0')
    checker.equal(
      'versions.digest',
      'the published version has a content digest',
      typeof versions[0]?.contentDigest,
      'string',
    )

    const contentResponse = await server.app.request(
      `/api/v1/rulebooks/${rulebookId}/versions/1.0.0/content`,
    )
    const contentBytes = new Uint8Array(await contentResponse.arrayBuffer())
    const snapshot = JSON.parse(
      Buffer.from(contentBytes).toString('utf8'),
    ) as RulebookVersionDocumentResource
    const recomputedDigest = sha256Hex(contentBytes)
    checker.equal(
      'version.digest.reproducible',
      'the SHA-256 of the exact snapshot bytes equals the published digest',
      recomputedDigest,
      versions[0]?.contentDigest,
    )
    checker.equal(
      'version.contentDigest.header',
      'the content response carries the same digest in Content-Digest',
      contentResponse.headers.get('content-digest'),
      `sha-256=:${Buffer.from(recomputedDigest, 'hex').toString('base64')}:`,
    )
    const snapshotHasNormativeFields =
      snapshot.format === 'attestbook.rulebook-version@1' &&
      snapshot.specVersion === 'ts11@1.0.1' &&
      snapshot.attestations.length === 1 &&
      snapshot.attestations[0]?.attestationLoS === 'iso_18045_high' &&
      snapshot.attestations[0]?.bindingType === 'key' &&
      JSON.stringify(snapshot.attestations[0]?.schemaReferences) ===
        JSON.stringify([
          {
            formatIdentifier: 'dc+sd-jwt',
            uri: SCHEMA_URI,
            integrity: sha256Sri(SCHEMA_DOCUMENT_TEXT),
          },
        ])
    checker.ok(
      'version.snapshot.normative',
      'the exact snapshot keeps the normative attestation, format and schema-reference fields',
      snapshotHasNormativeFields,
    )

    // ------------------------------------------------ validate a credential
    const credential = await issueTestCredential()

    const validate = async (
      body: Record<string, unknown>,
    ): Promise<{
      status: number
      payload: JsonData<CredentialValidationResource> | ErrorEnvelope
    }> => {
      const response = await requestJson<JsonData<CredentialValidationResource> | ErrorEnvelope>(
        'POST',
        '/api/v1/credentials/validate',
        body,
      )
      return { status: response.status, payload: response.data }
    }

    const validBody = {
      rulebookId,
      rulebookVersion: '1.0.0',
      attestationType: attestationName,
      credential,
      schemaDocuments: [{ uri: SCHEMA_URI, content: SCHEMA_DOCUMENT_TEXT }],
    }
    const validResponse = await validate(validBody)
    checker.equal(
      'validation.valid.status',
      'the structural validation request returns 200',
      validResponse.status,
      200,
    )
    const valid = (validResponse.payload as JsonData<CredentialValidationResource>).data
    const exportedText = JSON.stringify(valid)
    const validSummary = summarize(valid, exportedText)

    checker.equal(
      'validation.valid.overall',
      'a structurally valid credential is NOT_TESTED overall',
      valid.overallStatus,
      'NOT_TESTED',
    )
    checker.equal(
      'validation.valid.rulebookVersion',
      'the result pins the requested rulebook version',
      valid.rulebook.version,
      '1.0.0',
    )
    checker.equal(
      'validation.valid.digest',
      'the result carries the pinned content digest',
      valid.rulebook.digest,
      versions[0]?.contentDigest,
    )
    checker.ok(
      'validation.valid.digestVerified',
      'the engine recomputed and verified the pinned snapshot digest',
      valid.rulebook.digestVerified === true,
    )
    checker.equal(
      'validation.valid.dimensions',
      'all eight FR-010 dimensions are reported',
      valid.dimensions.length,
      8,
    )

    assertDimension(
      checker,
      valid,
      'credential_parsing',
      { status: 'PASS', applicable: true, executed: true },
      'validation.valid',
    )
    assertDimension(
      checker,
      valid,
      'format_recognition',
      { status: 'PASS', applicable: true, executed: true },
      'validation.valid',
    )
    assertDimension(
      checker,
      valid,
      'schema_validation',
      { status: 'PASS', applicable: true, executed: true },
      'validation.valid',
    )
    assertDimension(
      checker,
      valid,
      'attestation_constraints',
      { status: 'PASS', applicable: true, executed: true },
      'validation.valid',
    )
    assertDimension(
      checker,
      valid,
      'cryptographic_verification',
      { status: 'NOT_TESTED', applicable: true, executed: false },
      'validation.valid',
    )
    assertDimension(
      checker,
      valid,
      'issuer_trust',
      { status: 'NOT_TESTED', applicable: true, executed: false },
      'validation.valid',
    )
    assertDimension(
      checker,
      valid,
      'protocol_conformance',
      { status: 'NOT_APPLICABLE', applicable: false, executed: false },
      'validation.valid',
    )
    assertDimension(
      checker,
      valid,
      'interoperability',
      { status: 'NOT_APPLICABLE', applicable: false, executed: false },
      'validation.valid',
    )
    checker.ok(
      'validation.valid.limitations',
      'the result names the unverified signature, key binding, status list, trust, protocol and interoperability checks',
      [
        'signature_not_verified',
        'key_binding_proof_not_verified',
        'status_list_not_checked',
        'trust_not_evaluated',
        'protocol_not_applicable',
        'interoperability_not_applicable',
      ].every((code) => validSummary.limitationCodes.includes(code)),
    )
    checker.equal(
      'validation.valid.credential.vct',
      'the result reports the credential vct without claims',
      valid.credential.vct,
      VCT,
    )
    checker.ok(
      'validation.valid.credential.format',
      'the result reports the recognised credential format',
      valid.credential.format === 'dc+sd-jwt',
    )
    checker.ok(
      'validation.valid.evidence.exported',
      'the dimension-aware evidence serializes as JSON',
      validSummary.exportedEvidenceBytes > 0 && JSON.parse(exportedText) !== null,
    )
    checker.ok(
      'validation.valid.evidence.noCredential',
      'the exported evidence never contains the credential artifact or claim values',
      !exportedText.includes(credential) &&
        !exportedText.includes('Ada') &&
        !exportedText.includes('Lovelace') &&
        !exportedText.includes('1815-12-10'),
    )

    // -------------------------------- negative: a failing attribute constraint
    const invalidCredential = await issueTestCredential({
      claims: defaultCredentialClaims({ birthdate: 18151210 }),
    })
    const missingClaimResponse = await validate({
      ...validBody,
      credential: invalidCredential,
    })
    const missingClaim = (missingClaimResponse.payload as JsonData<CredentialValidationResource>)
      .data
    const missingClaimSummary = summarize(missingClaim, JSON.stringify(missingClaim))
    checker.equal(
      'validation.negative.schema.status',
      'an attribute type violation returns 200',
      missingClaimResponse.status,
      200,
    )
    checker.equal(
      'validation.negative.schema.overall',
      'a schema failure is reported as FAIL overall',
      missingClaim.overallStatus,
      'FAIL',
    )
    assertDimension(
      checker,
      missingClaim,
      'schema_validation',
      { status: 'FAIL', applicable: true, executed: true },
      'validation.negative.schema',
    )
    checker.ok(
      'validation.negative.schema.finding',
      'the schema failure names the failing JSON Pointer path and constraint',
      missingClaim.violations.some(
        (violation) =>
          violation.dimension === 'schema_validation' &&
          typeof violation.path === 'string' &&
          violation.path.startsWith('/') &&
          typeof violation.expected === 'string',
      ),
    )

    // --------------------------------- negative: an unsupported credential format
    const unsupportedFormatResponse = await validate({
      ...validBody,
      credential: { format: 'mso_mdoc', value: credential },
    })
    const unsupportedFormat = (
      unsupportedFormatResponse.payload as JsonData<CredentialValidationResource>
    ).data
    const unsupportedFormatSummary = summarize(unsupportedFormat, JSON.stringify(unsupportedFormat))
    checker.equal(
      'validation.negative.format.status',
      'an unsupported format returns 200',
      unsupportedFormatResponse.status,
      200,
    )
    checker.equal(
      'validation.negative.format.overall',
      'an unsupported format is not reported as a pass',
      unsupportedFormat.overallStatus,
      'FAIL',
    )
    assertDimension(
      checker,
      unsupportedFormat,
      'credential_parsing',
      { status: 'NOT_TESTED', applicable: true, executed: false },
      'validation.negative.format',
    )
    assertDimension(
      checker,
      unsupportedFormat,
      'attestation_constraints',
      { status: 'FAIL', applicable: true, executed: true },
      'validation.negative.format',
    )
    checker.ok(
      'validation.negative.format.finding',
      'the rulebook-level format mismatch is reported explicitly',
      unsupportedFormat.violations.some(
        (violation) => violation.code === 'format_not_supported_by_rulebook',
      ),
    )

    // ------------------------------- negative: no schema document supplied
    const noSchemaResponse = await validate({
      rulebookId,
      rulebookVersion: '1.0.0',
      attestationType: attestationName,
      credential,
    })
    const noSchema = (noSchemaResponse.payload as JsonData<CredentialValidationResource>).data
    const noSchemaSummary = summarize(noSchema, JSON.stringify(noSchema))
    checker.equal(
      'validation.negative.noSchema.status',
      'a validation without schema documents returns 200',
      noSchemaResponse.status,
      200,
    )
    checker.equal(
      'validation.negative.noSchema.overall',
      'a missing schema document keeps the overall result NOT_TESTED',
      noSchema.overallStatus,
      'NOT_TESTED',
    )
    assertDimension(
      checker,
      noSchema,
      'schema_validation',
      { status: 'NOT_TESTED', applicable: true, executed: false },
      'validation.negative.noSchema',
    )
    checker.ok(
      'validation.negative.noSchema.finding',
      'the unexecuted schema dimension is reported, never silently passed',
      noSchema.violations.some((violation) => violation.code === 'schema_document_not_supplied'),
    )

    // -------------------------------------------- negative: invalid TS11 input
    const invalidPreview = await requestJson<JsonData<ImportPreviewResource> | ErrorEnvelope>(
      'POST',
      '/api/v1/imports/preview',
      {
        source: {
          kind: 'json',
          content: JSON.stringify(invalidTs11Document()),
          name: 'broken.json',
        },
      },
      token,
    )
    const invalidEntry =
      invalidPreview.status === 200
        ? (invalidPreview.data as JsonData<ImportPreviewResource>).data.entries[0]
        : undefined
    checker.ok(
      'import.negative.invalidTs11',
      'a TS11 document missing a required member is invalid and incompatible',
      (invalidPreview.status === 200 &&
        invalidEntry?.structuralStatus === 'invalid' &&
        invalidEntry?.compatible === false) ||
        (invalidPreview.status === 422 &&
          (invalidPreview.data as ErrorEnvelope).error.code === 'import_rejected'),
    )

    // --------------------------------------- non-conflation of the dimensions
    const nonConflation = {
      structuralPassIsNotOverallPass: valid.overallStatus !== 'PASS',
      cryptographicVerificationNotTested:
        dimension(valid, 'cryptographic_verification')?.status === 'NOT_TESTED',
      issuerTrustNotTested: dimension(valid, 'issuer_trust')?.status === 'NOT_TESTED',
      protocolNotApplicable: dimension(valid, 'protocol_conformance')?.status === 'NOT_APPLICABLE',
      interoperabilityNotApplicable:
        dimension(valid, 'interoperability')?.status === 'NOT_APPLICABLE',
      schemaFailureDoesNotBecomeSchemaPass:
        dimension(missingClaim, 'schema_validation')?.status === 'FAIL',
      unsupportedFormatIsNotReportedPass:
        dimension(unsupportedFormat, 'credential_parsing')?.status !== 'PASS',
      credentialNotInExportedEvidence: !exportedText.includes(credential),
    }
    checker.ok(
      'nonConflation.all',
      'schema, cryptographic, trust, protocol and interoperability results remain distinguishable',
      Object.values(nonConflation).every((value) => value === true),
      JSON.stringify(nonConflation),
    )

    // -------------------------------------------------- UI assets are served
    const servedRoutes: string[] = []
    if (uiAvailable) {
      for (const path of ['/', '/rulebooks/example', '/playground']) {
        const response = await server.app.request(path)
        const html = await response.text()
        if (
          checker.ok(
            `ui.route.${path}`,
            `the built UI is served at ${path}`,
            response.status === 200 && html.includes('<title>Rulebook catalog'),
          )
        ) {
          servedRoutes.push(path)
        }
      }
    }

    const evidence: AcceptanceEvidence = {
      generatedAt: now(),
      appVersion: applicationPackage.version,
      owf: {
        packageVersion: owfPackage.version,
        validDocument: owfValidDocument,
        ts11DocumentRejectedByOwf: owfRejectsTs11,
        owfImportProfile: String(owfEntry?.profile),
        owfImportConformance: String(owfEntry?.conformance),
        owfImportCompatible: owfEntry?.compatible === true,
      },
      importPreview: {
        compatible: previewEntry?.compatible === true,
        structuralStatus: String(previewEntry?.structuralStatus),
        profile: String(previewEntry?.profile),
        conformance: String(previewEntry?.conformance),
        schemaReferenceCount: previewEntry?.schemaReferences.length ?? 0,
        limitations: preview.data?.data.compatibility.limitations ?? [],
      },
      rulebook: {
        id: rulebookId,
        name: rulebook?.name ?? '',
        publicationStatus: String(rulebook?.publicationStatus),
        attestationCount: attestations.length,
        schemaReferenceCount: referencesRead.data?.data.length ?? 0,
        schemaUri: String(reference?.uri),
        schemaIntegrity: String(reference?.integrity),
      },
      version: {
        label: '1.0.0',
        status: String(versions[0]?.status),
        contentDigest: String(versions[0]?.contentDigest),
        recomputedDigest,
        specVersion: snapshot.specVersion,
        snapshotHasNormativeFields,
      },
      valid: validSummary,
      negativeMissingClaim: missingClaimSummary,
      negativeUnsupportedFormat: unsupportedFormatSummary,
      negativeNoSchemaDocument: noSchemaSummary,
      nonConflation,
      ui: { checked: uiAvailable, servedRoutes },
      checks: checker.checks,
    }

    checker.finish()
    return { evidence, checks: checker.checks }
  } finally {
    database.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
