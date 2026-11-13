// Rulebook-pinned SD-JWT VC structural validation engine (issue #32).
//
// The engine reads one immutable rulebook version from the registry, verifies
// the snapshot digest, parses the real credential artifact, applies the
// supplied rulebook schema documents and evaluates attestation constraints.
// It never verifies signatures, issuer trust, protocol conformance or
// interoperability, and it reports those dimensions as NOT_TESTED or
// NOT_APPLICABLE instead of inferring success from structural checks.

import { randomUUID } from 'node:crypto'

import { sha256Hex } from '../registry/digest'
import { invalidInput, notFound } from '../registry/errors'
import type { RulebookVersion } from '../registry/types'
import type { RulebookVersionSchemaReference } from '../registry/versioning'
import { TS11_ATTESTATION_LOS_VALUES, TS11_BINDING_TYPE_VALUES } from '../standards/profiles'

import { createDimension, dimensionDefinition, limitationsFromDimensions } from './dimensions'
import { recognizeCredentialFormat } from './format'
import {
  resolveHostedSchemaDocuments,
  type HostedSchemaOptions,
  type HostedSchemaResolution,
} from './hosted-schema'
import { parseValidateCredentialInput } from './request'
import type { SchemaValidationOutcome } from './schema'
import { validateSchemaDocuments, type SchemaSandboxLimits } from './schema-sandbox'
import { parseSdJwtVc, MAX_DISCLOSURES, type ParsedSdJwtVc } from './sd-jwt'
import {
  isImmutableRulebookVersion,
  RulebookSnapshotCache,
  type CachedRulebookSnapshot,
} from './snapshot-cache'
import {
  parseRulebookSnapshot,
  type ParsedRulebookSnapshot,
  type SnapshotAttestation,
} from './snapshot'
import { aggregateStatus } from './status'
import type {
  AttestationEvidence,
  CredentialValidationResult,
  RulebookValidationSource,
  SchemaReferenceEvidence,
  ValidationDimension,
  ValidationDimensionId,
  ValidationEvidenceValue,
  ValidationFinding,
  ValidationStatus,
} from './types'

const MAX_REPORTED_ATTESTATION_FORMATS = 16

export interface CredentialValidatorOptions {
  readonly source: RulebookValidationSource
  /** Clock for the result timestamp; injectable for deterministic tests. */
  readonly now?: () => string
  /** Identifier generator; injectable for deterministic tests. */
  readonly generateId?: () => string
  /** Optional sandbox limits; production passes the configured values. */
  readonly sandbox?: SchemaSandboxLimits
  /**
   * Bounded cache for immutable (published/historical) parsed snapshots.
   * Defaults to a cache with the documented limits; pass `false` to disable
   * caching for a validator instance.
   */
  readonly snapshotCache?: RulebookSnapshotCache | false
  /**
   * Resolves canonical AttestBook-hosted schema URLs from the immutable local
   * store (#101). Absent when the deployment has no configured public origin,
   * in which case every reference keeps the caller-supplied document flow.
   */
  readonly hostedSchemas?: HostedSchemaOptions
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Proves a cached parsed snapshot still belongs to the version row it is used
 * for. The digest already identifies the exact bytes; this second check keeps
 * the version identity explicit for a cache that outlives the registry read.
 */
function assertSnapshotMatchesVersion(
  cached: CachedRulebookSnapshot,
  version: RulebookVersion,
): void {
  const snapshot = cached.snapshot
  if (
    snapshot.rulebookId !== version.rulebookId ||
    snapshot.version !== version.version ||
    snapshot.specVersion !== version.specVersion
  ) {
    throw new Error('the stored rulebook version snapshot does not match its version metadata')
  }
}

function finding(
  dimension: ValidationDimensionId,
  code: string,
  message: string,
  severity: 'error' | 'warning' | 'info',
  path?: string,
  expected?: string,
): ValidationFinding {
  return {
    code,
    message,
    severity,
    dimension,
    ...(path === undefined ? {} : { path }),
    ...(expected === undefined ? {} : { expected }),
  }
}

function notExecutedDimension(
  id: ValidationDimensionId,
  code: string,
  message: string,
  details: Readonly<Record<string, ValidationEvidenceValue>> = {},
): ValidationDimension {
  return createDimension({
    id,
    status: 'NOT_TESTED',
    applicable: true,
    executed: false,
    findings: [finding(id, code, message, 'warning')],
    evidence: {
      scope: dimensionDefinition(id).scope,
      reason: message,
      details: { executed: false, ...details },
    },
  })
}

function notApplicableDimension(
  id: ValidationDimensionId,
  code: string,
  message: string,
  details: Readonly<Record<string, ValidationEvidenceValue>> = {},
): ValidationDimension {
  return createDimension({
    id,
    status: 'NOT_APPLICABLE',
    applicable: false,
    executed: false,
    findings: [finding(id, code, message, 'info')],
    evidence: {
      scope: dimensionDefinition(id).scope,
      reason: message,
      details: { executed: false, ...details },
    },
  })
}

function executedDimension(
  id: ValidationDimensionId,
  status: Exclude<ValidationStatus, 'NOT_TESTED' | 'NOT_APPLICABLE'>,
  findings: readonly ValidationFinding[],
  reason: string,
  details: Readonly<Record<string, ValidationEvidenceValue>> = {},
): ValidationDimension {
  return createDimension({
    id,
    status,
    applicable: true,
    executed: true,
    findings,
    evidence: {
      scope: dimensionDefinition(id).scope,
      reason,
      details: { executed: true, ...details },
    },
  })
}

function attestationEvidence(attestation: SnapshotAttestation): AttestationEvidence {
  return {
    name: attestation.name,
    attestationLoS: attestation.attestationLoS,
    bindingType: attestation.bindingType,
    supportedFormats: attestation.supportedFormats.slice(0, MAX_REPORTED_ATTESTATION_FORMATS),
  }
}

function unparsedSchemaReferences(
  references: readonly RulebookVersionSchemaReference[],
): readonly SchemaReferenceEvidence[] {
  return references.map((reference) => ({
    formatIdentifier: reference.formatIdentifier,
    uri: reference.uri,
    integrity: reference.integrity,
    kind: null,
    applied: false,
    source: null,
  }))
}

/**
 * Builds the schema-validation dimension from a schema outcome. An
 * `INCONCLUSIVE` aggregate where no document was applied (for example an
 * unverifiable `sha384` or malformed integrity pin) means no schema check ran,
 * so the dimension is `NOT_TESTED` with `executed: false`. A `FAIL` is always a
 * real conclusion, even when the failing reference was not applied.
 */
export function schemaDimensionFromOutcome(
  outcome: SchemaValidationOutcome,
  referenceCount: number,
  documentsSupplied: number,
): ValidationDimension {
  const appliedDocuments = outcome.schemaReferences.filter((entry) => entry.applied).length
  const hostedReferences = outcome.schemaReferences.filter((entry) => entry.source === 'hosted')
  const status: ValidationStatus =
    outcome.status === 'INCONCLUSIVE' && appliedDocuments === 0 ? 'NOT_TESTED' : outcome.status
  const applicable = status !== 'NOT_APPLICABLE'
  const executed = status === 'PASS' || status === 'FAIL' || status === 'INCONCLUSIVE'
  const primaryFinding = outcome.findings.find((entry) => entry.severity !== 'info')
  return createDimension({
    id: 'schema_validation',
    status,
    applicable,
    executed,
    findings: outcome.findings,
    evidence: {
      scope: dimensionDefinition('schema_validation').scope,
      reason:
        status === 'PASS'
          ? 'Every schema document for the pinned references was applied and satisfied.'
          : (primaryFinding?.message ??
            'Schema validation did not reach a conclusive result for every pinned reference.'),
      details: {
        executed,
        references: referenceCount,
        documents_supplied: documentsSupplied,
        applied_documents: appliedDocuments,
        hosted_references: hostedReferences.length,
        hosted_documents_applied: hostedReferences.filter((entry) => entry.applied).length,
      },
    },
  })
}

/** The typed, framework-independent credential validation service. */
export class CredentialValidator {
  private readonly source: RulebookValidationSource
  private readonly now: () => string
  private readonly generateId: () => string
  private readonly sandbox: SchemaSandboxLimits
  private readonly snapshotCache: RulebookSnapshotCache | null
  private readonly hostedSchemas: HostedSchemaOptions | undefined

  constructor(options: CredentialValidatorOptions) {
    this.source = options.source
    this.now = options.now ?? (() => new Date().toISOString())
    this.generateId = options.generateId ?? (() => randomUUID())
    this.sandbox = options.sandbox ?? {}
    this.snapshotCache =
      options.snapshotCache === false
        ? null
        : (options.snapshotCache ?? new RulebookSnapshotCache())
    this.hostedSchemas = options.hostedSchemas
  }

  /**
   * Validates a credential artifact against one pinned rulebook version.
   * Throws `RegistryError` for a malformed request or unknown resource and a
   * plain `Error` only for a corrupt registry snapshot.
   */
  async validate(input: unknown): Promise<CredentialValidationResult> {
    const request = parseValidateCredentialInput(input)

    const rulebook = this.source.getRulebook(request.rulebookId)
    if (rulebook === null) {
      throw notFound('The rulebook does not exist.')
    }
    const version = this.source.getRulebookVersion(request.rulebookId, request.rulebookVersion)
    if (version === null) {
      throw notFound('The rulebook version does not exist.')
    }
    const cacheable = isImmutableRulebookVersion(version.status)
    const cached = cacheable ? this.snapshotCache?.get(version.contentDigest) : undefined
    let snapshot: ParsedRulebookSnapshot
    if (cached !== undefined) {
      // Re-verify the cached copy on every run: caching may skip the database
      // read, never the integrity check or the version-identity check.
      if (sha256Hex(cached.bytes) !== version.contentDigest) {
        throw new Error('the stored rulebook version content does not match its recorded digest')
      }
      assertSnapshotMatchesVersion(cached, version)
      snapshot = cached.snapshot
    } else {
      const content = this.source.getRulebookVersionContent(
        request.rulebookId,
        request.rulebookVersion,
      )
      if (content === null) {
        throw notFound('The rulebook version content does not exist.')
      }
      const digest = sha256Hex(content.bytes)
      if (digest !== version.contentDigest) {
        throw new Error('the stored rulebook version content does not match its recorded digest')
      }
      snapshot = parseRulebookSnapshot(content.bytes, version)
      if (cacheable) {
        this.snapshotCache?.set(version.contentDigest, content.bytes, snapshot)
      }
    }
    const attestation = snapshot.attestations.find(
      (candidate) => candidate.name === request.attestationType,
    )
    if (attestation === undefined) {
      throw notFound('The attestation type does not exist in this rulebook version.')
    }

    const artifact =
      typeof request.credential === 'string'
        ? { value: request.credential }
        : {
            value: request.credential.value,
            ...(request.credential.format === undefined
              ? {}
              : { format: request.credential.format }),
          }
    const recognition = recognizeCredentialFormat(artifact)

    const attestationReferences = attestation.schemaReferences
    const matchingReferences = attestationReferences.filter(
      (reference) =>
        recognition.format !== null && reference.formatIdentifier === recognition.format,
    )

    // A supplied document must belong to the selected attestation type in this
    // exact version; otherwise a caller could silently validate against an
    // unrelated schema. The URI is checked against every reference of the
    // attestation, so an unrecognised credential still gets a FAIL report
    // instead of a 400.
    for (const document of request.schemaDocuments ?? []) {
      if (!attestationReferences.some((reference) => reference.uri === document.uri)) {
        throw invalidInput(
          'schemaDocuments contains a URI that the selected attestation type does not reference in this rulebook version.',
        )
      }
    }

    const formatFindings: ValidationFinding[] = []
    if (!recognition.recognized) {
      formatFindings.push(
        finding(
          'format_recognition',
          'unrecognized_credential_format',
          'The credential artifact does not match a known credential format.',
          'error',
          '/credential',
        ),
      )
    } else if (!recognition.parserAvailable) {
      formatFindings.push(
        finding(
          'format_recognition',
          'format_parser_not_implemented',
          `No structural parser is implemented for "${recognition.format}"; the format was recognised but not parsed.`,
          'info',
          '/credential',
        ),
      )
    }
    let parsed: ParsedSdJwtVc | undefined
    let parsingDimension: ValidationDimension
    if (!recognition.recognized) {
      parsingDimension = notExecutedDimension(
        'credential_parsing',
        'format_not_recognized',
        'Credential parsing was not executed because the format was not recognised.',
        { format_recognized: false },
      )
    } else if (!recognition.parserAvailable) {
      parsingDimension = notExecutedDimension(
        'credential_parsing',
        'format_parser_unavailable',
        `Credential parsing was not executed: AttestBook has no parser for "${recognition.format}".`,
        { format: recognition.format, parser_available: false },
      )
    } else {
      const outcome = await parseSdJwtVc(artifact.value)
      if (outcome.ok) {
        parsed = outcome.value
        parsingDimension = executedDimension(
          'credential_parsing',
          'PASS',
          [
            finding(
              'credential_parsing',
              'credential_parsed',
              `The credential was parsed as SD-JWT VC with ${outcome.value.disclosureCount} disclosure(s).`,
              'info',
              '/credential',
            ),
          ],
          'The credential parsed as SD-JWT VC and its disclosure structure was verified.',
          {
            format: 'dc+sd-jwt',
            disclosure_count: outcome.value.disclosureCount,
            max_disclosures: MAX_DISCLOSURES,
          },
        )
      } else if (outcome.kind === 'unsupported') {
        parsingDimension = createDimension({
          id: 'credential_parsing',
          status: 'NOT_TESTED',
          applicable: true,
          executed: false,
          findings: outcome.findings,
          evidence: {
            scope: dimensionDefinition('credential_parsing').scope,
            reason:
              'Credential structure was not verified because the disclosure hash algorithm cannot be executed by this runtime.',
            details: { format: recognition.format, hash_algorithm_executable: false },
          },
        })
      } else {
        parsingDimension = createDimension({
          id: 'credential_parsing',
          status: 'FAIL',
          applicable: true,
          executed: true,
          findings: outcome.findings,
          evidence: {
            scope: dimensionDefinition('credential_parsing').scope,
            reason: 'The credential could not be parsed as a structurally valid SD-JWT VC.',
            details: { format: recognition.format, structurally_valid: false },
          },
        })
      }
    }

    let formatStatus: ValidationStatus
    let formatReason: string
    if (!recognition.recognized) {
      formatStatus = 'FAIL'
      formatReason = 'The credential artifact does not match a known credential format.'
    } else if (recognition.source === 'hint' && parsed === undefined) {
      formatStatus = 'INCONCLUSIVE'
      formatReason =
        'The credential format was taken only from the caller hint and the artifact was not parsed to confirm it.'
      formatFindings.push(
        finding(
          'format_recognition',
          'format_hint_unconfirmed',
          'The credential format was taken only from the caller hint and the artifact was not parsed to confirm it.',
          'warning',
          '/credential',
        ),
      )
    } else {
      formatStatus = 'PASS'
      formatReason = 'The credential format was recognised from the artifact.'
    }
    const formatDimension = executedDimension(
      'format_recognition',
      formatStatus,
      formatFindings,
      formatReason,
      {
        format: recognition.format,
        recognized: recognition.recognized,
        parser_available: recognition.parserAvailable,
        recognition_source: recognition.source,
      },
    )

    let schemaDimension: ValidationDimension
    let schemaReferences: readonly SchemaReferenceEvidence[]
    if (parsed === undefined) {
      schemaDimension = notExecutedDimension(
        'schema_validation',
        'credential_not_parsed',
        'Schema validation was not executed because the credential was not parsed.',
        { references: matchingReferences.length },
      )
      schemaReferences = unparsedSchemaReferences(matchingReferences)
    } else if (matchingReferences.length === 0) {
      schemaDimension = notApplicableDimension(
        'schema_validation',
        'no_matching_schema_reference',
        `The selected attestation type has no "${recognition.format ?? 'unknown'}" schema reference in this rulebook version.`,
        { references: 0, format: recognition.format },
      )
      schemaReferences = []
    } else {
      // Canonical hosted URLs are resolved from the immutable store before the
      // caller's documents are considered; caller bytes can never override one.
      const hosted: ReadonlyMap<number, HostedSchemaResolution> | undefined =
        this.hostedSchemas === undefined
          ? undefined
          : resolveHostedSchemaDocuments({
              references: matchingReferences,
              publicBaseUrl: this.hostedSchemas.publicBaseUrl,
              store: this.hostedSchemas.store,
            })
      const outcome = await validateSchemaDocuments(
        {
          references: matchingReferences,
          documents: request.schemaDocuments ?? [],
          ...(hosted === undefined ? {} : { hosted }),
          parsed,
        },
        this.sandbox,
      )
      schemaDimension = schemaDimensionFromOutcome(
        outcome,
        matchingReferences.length,
        request.schemaDocuments?.length ?? 0,
      )
      schemaReferences = outcome.schemaReferences
    }

    let attestationDimension: ValidationDimension
    if (!recognition.recognized) {
      attestationDimension = notExecutedDimension(
        'attestation_constraints',
        'credential_not_recognized',
        'Attestation constraints were not evaluated because the format was not recognised.',
      )
    } else {
      const findings: ValidationFinding[] = []
      const format = recognition.format
      if (format !== null && !attestation.supportedFormats.includes(format)) {
        findings.push(
          finding(
            'attestation_constraints',
            'format_not_supported_by_rulebook',
            `The selected attestation type does not support the "${format}" credential format.`,
            'error',
            '/credential',
            `format is one of ${attestation.supportedFormats.join(', ')}`,
          ),
        )
      }
      if (
        !(TS11_ATTESTATION_LOS_VALUES as readonly string[]).includes(attestation.attestationLoS)
      ) {
        findings.push(
          finding(
            'attestation_constraints',
            'unrecognized_attestation_los',
            `The rulebook attestationLoS "${attestation.attestationLoS}" is not in the pinned TS11 vocabulary; it was preserved, not coerced.`,
            'warning',
            '/attestation/attestationLoS',
          ),
        )
      }
      if (!(TS11_BINDING_TYPE_VALUES as readonly string[]).includes(attestation.bindingType)) {
        findings.push(
          finding(
            'attestation_constraints',
            'unrecognized_binding_type',
            `The rulebook bindingType "${attestation.bindingType}" is not in the pinned TS11 vocabulary; it was preserved, not coerced.`,
            'warning',
            '/attestation/bindingType',
          ),
        )
      }
      if (parsed !== undefined && attestation.bindingType === 'key') {
        const cnf = parsed.packedPayload.cnf
        if (cnf === undefined) {
          findings.push(
            finding(
              'attestation_constraints',
              'missing_key_binding',
              'The rulebook requires key binding, but the credential has no issuer-signed `cnf` claim.',
              'error',
              '/cnf',
              'the credential carries an issuer-signed cnf key-binding claim',
            ),
          )
        } else if (!isRecord(cnf)) {
          findings.push(
            finding(
              'attestation_constraints',
              'invalid_key_binding',
              'The credential `cnf` claim is not a JSON object.',
              'error',
              '/cnf',
              'cnf is a JSON object',
            ),
          )
        }
      }

      let status: Exclude<ValidationStatus, 'NOT_TESTED' | 'NOT_APPLICABLE'>
      let reason: string
      let credentialDependentChecksExecuted = true
      if (findings.some((entry) => entry.severity === 'error')) {
        status = 'FAIL'
        reason =
          'At least one attestation-specific constraint is violated by the credential or rulebook version.'
      } else if (parsed === undefined) {
        // The rulebook-level checks ran, but the credential-dependent check
        // could not, so the dimension is executed and inconclusive, never PASS.
        status = 'INCONCLUSIVE'
        reason =
          'Rulebook-level attestation constraints were evaluated, but the credential-dependent key-binding check could not run because the credential was not parsed.'
        credentialDependentChecksExecuted = false
        findings.push(
          finding(
            'attestation_constraints',
            'credential_dependent_checks_not_run',
            'Credential-dependent attestation constraints were not evaluated because the credential was not parsed.',
            'warning',
          ),
        )
      } else if (findings.some((entry) => entry.severity === 'warning')) {
        status = 'INCONCLUSIVE'
        reason =
          'The credential satisfies the attestation constraints, but at least one rulebook value is outside the pinned TS11 vocabulary and was preserved rather than coerced.'
      } else {
        status = 'PASS'
        reason =
          'The credential satisfies every attestation constraint observable without cryptography.'
      }
      attestationDimension = executedDimension(
        'attestation_constraints',
        status,
        findings,
        reason,
        {
          credential_format_supported:
            format === null || attestation.supportedFormats.includes(format),
          key_binding_required: attestation.bindingType === 'key',
          key_binding_present: parsed?.keyBindingPresent ?? null,
          credential_dependent_checks_executed: credentialDependentChecksExecuted,
        },
      )
    }

    // FR-010 order: parsing, format recognition, crypto, schema, attestation,
    // trust, protocol, interoperability.
    const cryptoReason =
      'Issuer JWS signatures, key-binding (KB-JWT) proofs and status-list tokens were not verified; this endpoint performs structural validation only.'
    const finalDimensions: readonly ValidationDimension[] = [
      parsingDimension,
      formatDimension,
      createDimension({
        id: 'cryptographic_verification',
        status: 'NOT_TESTED',
        applicable: true,
        executed: false,
        findings: [
          finding(
            'cryptographic_verification',
            'signature_not_verified',
            'The issuer JWS signature was not verified; structural validity is not cryptographic validity.',
            'warning',
            '/credential',
          ),
          finding(
            'cryptographic_verification',
            'key_binding_proof_not_verified',
            'Any key-binding (KB-JWT) proof was not verified, and possession of the bound key was not demonstrated.',
            'warning',
            '/cnf',
          ),
          finding(
            'cryptographic_verification',
            'status_list_not_checked',
            'The credential status was not checked against a status-list token or revocation policy.',
            'warning',
            '/status',
          ),
        ],
        evidence: {
          scope: dimensionDefinition('cryptographic_verification').scope,
          reason: cryptoReason,
          details: {
            executed: false,
            issuer_jws_signature_verified: false,
            key_binding_proof_verified: false,
            status_list_token_verified: false,
          },
        },
      }),
      schemaDimension,
      attestationDimension,
      notExecutedDimension(
        'issuer_trust',
        'trust_not_evaluated',
        'The credential issuer was not evaluated against trust anchors; no trust configuration was applied.',
        { trust_anchors_applied: false },
      ),
      notApplicableDimension(
        'protocol_conformance',
        'protocol_not_applicable',
        'Protocol conformance requires an issuer or verifier protocol interaction; a standalone credential artifact provides none.',
        { protocol_exchange_present: false },
      ),
      notApplicableDimension(
        'interoperability',
        'interoperability_not_applicable',
        'End-to-end interoperability requires external wallet and verifier execution and is never inferred from structural validation.',
        { external_wallet_execution: false },
      ),
    ]

    const violations = finalDimensions
      .flatMap((entry) => entry.findings)
      .filter((entry) => entry.severity !== 'info')

    return {
      validationId: this.generateId(),
      validatedAt: this.now(),
      rulebook: {
        id: rulebook.id,
        name: rulebook.name,
        version: version.version,
        digest: version.contentDigest,
        digestVerified: true,
        specVersion: version.specVersion,
        status: version.status,
      },
      attestation: attestationEvidence(attestation),
      credential: {
        format: recognition.format,
        vct: parsed?.vct ?? null,
        disclosureCount: parsed?.disclosureCount ?? 0,
        keyBindingPresent: parsed?.keyBindingPresent ?? false,
      },
      schemaReferences,
      dimensions: finalDimensions,
      violations,
      limitations: limitationsFromDimensions(finalDimensions),
      overallStatus: aggregateStatus(finalDimensions),
    }
  }
}
