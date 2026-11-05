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
import {
  RULEBOOK_VERSION_FORMAT,
  type RulebookVersionDocument,
  type RulebookVersionSchemaReference,
} from '../registry/versioning'
import { TS11_ATTESTATION_LOS_VALUES, TS11_BINDING_TYPE_VALUES } from '../standards/profiles'

import { recognizeCredentialFormat } from './format'
import { parseValidateCredentialInput } from './request'
import { validateSchemaDocuments } from './schema'
import { parseSdJwtVc, type ParsedSdJwtVc } from './sd-jwt'
import { aggregateStatus } from './status'
import type {
  AttestationEvidence,
  CredentialValidationResult,
  RulebookValidationSource,
  SchemaReferenceEvidence,
  ValidationDimension,
  ValidationDimensionId,
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
}

interface SnapshotAttestation {
  readonly name: string
  readonly attestationLoS: string
  readonly bindingType: string
  readonly supportedFormats: readonly string[]
  readonly schemaReferences: readonly RulebookVersionSchemaReference[]
}

interface ParsedSnapshot {
  readonly attestations: readonly SnapshotAttestation[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function parseSnapshotReference(value: unknown): RulebookVersionSchemaReference {
  if (
    !isRecord(value) ||
    typeof value.formatIdentifier !== 'string' ||
    typeof value.uri !== 'string' ||
    !(value.integrity === null || typeof value.integrity === 'string')
  ) {
    throw new Error('the stored rulebook version snapshot has a malformed schema reference')
  }
  return {
    formatIdentifier: value.formatIdentifier,
    uri: value.uri,
    integrity: value.integrity,
  }
}

function parseSnapshotAttestation(value: unknown): SnapshotAttestation {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.attestationLoS !== 'string' ||
    typeof value.bindingType !== 'string' ||
    !isStringArray(value.supportedFormats) ||
    !Array.isArray(value.schemaReferences)
  ) {
    throw new Error('the stored rulebook version snapshot has a malformed attestation type')
  }
  return {
    name: value.name,
    attestationLoS: value.attestationLoS,
    bindingType: value.bindingType,
    supportedFormats: value.supportedFormats,
    schemaReferences: value.schemaReferences.map(parseSnapshotReference),
  }
}

/**
 * Parses and checks the stored snapshot bytes against the version metadata.
 * A mismatch means the registry is inconsistent, not that the caller's
 * credential is invalid, so these failures are internal errors.
 */
function parseSnapshot(bytes: Uint8Array, version: RulebookVersion): ParsedSnapshot {
  let document: unknown
  try {
    document = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw new Error('the stored rulebook version snapshot is not valid JSON')
  }
  const candidate = document as Partial<RulebookVersionDocument>
  if (
    !isRecord(document) ||
    candidate.format !== RULEBOOK_VERSION_FORMAT ||
    candidate.rulebookId !== version.rulebookId ||
    candidate.version !== version.version ||
    candidate.specVersion !== version.specVersion ||
    !Array.isArray(candidate.attestations)
  ) {
    throw new Error('the stored rulebook version snapshot does not match its version metadata')
  }
  return {
    attestations: candidate.attestations.map(parseSnapshotAttestation),
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

function dimension(
  id: ValidationDimensionId,
  status: ValidationStatus,
  findings: readonly ValidationFinding[] = [],
): ValidationDimension {
  return { id, status, findings }
}

function externalDimension(
  id: ValidationDimensionId,
  status: ValidationStatus,
  code: string,
  message: string,
  severity: 'warning' | 'info',
): ValidationDimension {
  return dimension(id, status, [finding(id, code, message, severity)])
}

function notExecutedDimension(
  id: ValidationDimensionId,
  code: string,
  message: string,
): ValidationDimension {
  return dimension(id, 'NOT_TESTED', [finding(id, code, message, 'warning')])
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
  }))
}

/** The typed, framework-independent credential validation service. */
export class CredentialValidator {
  private readonly source: RulebookValidationSource
  private readonly now: () => string
  private readonly generateId: () => string

  constructor(options: CredentialValidatorOptions) {
    this.source = options.source
    this.now = options.now ?? (() => new Date().toISOString())
    this.generateId = options.generateId ?? (() => randomUUID())
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

    const snapshot = parseSnapshot(content.bytes, version)
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

    const matchingReferences = attestation.schemaReferences.filter(
      (reference) =>
        recognition.format !== null && reference.formatIdentifier === recognition.format,
    )

    // A supplied document must belong to the selected attestation type in this
    // exact version; otherwise a caller could silently validate against an
    // unrelated schema.
    for (const document of request.schemaDocuments ?? []) {
      if (!matchingReferences.some((reference) => reference.uri === document.uri)) {
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
    const formatDimension = dimension(
      'format_recognition',
      recognition.recognized ? 'PASS' : 'FAIL',
      formatFindings,
    )

    let parsed: ParsedSdJwtVc | undefined
    let parsingDimension: ValidationDimension
    if (!recognition.recognized) {
      parsingDimension = notExecutedDimension(
        'credential_parsing',
        'format_not_recognized',
        'Credential parsing was not executed because the format was not recognised.',
      )
    } else if (!recognition.parserAvailable) {
      parsingDimension = notExecutedDimension(
        'credential_parsing',
        'format_parser_unavailable',
        `Credential parsing was not executed: AttestBook has no parser for "${recognition.format}".`,
      )
    } else {
      const outcome = await parseSdJwtVc(artifact.value)
      if (outcome.ok) {
        parsed = outcome.value
        parsingDimension = dimension('credential_parsing', 'PASS', [
          finding(
            'credential_parsing',
            'credential_parsed',
            `The credential was parsed as SD-JWT VC with ${outcome.value.disclosureCount} disclosure(s).`,
            'info',
            '/credential',
          ),
        ])
      } else if (outcome.kind === 'unsupported') {
        parsingDimension = dimension('credential_parsing', 'NOT_TESTED', outcome.findings)
      } else {
        parsingDimension = dimension('credential_parsing', 'FAIL', outcome.findings)
      }
    }

    let schemaDimension: ValidationDimension
    let schemaReferences: readonly SchemaReferenceEvidence[]
    if (parsed === undefined) {
      schemaDimension = notExecutedDimension(
        'schema_validation',
        'credential_not_parsed',
        'Schema validation was not executed because the credential was not parsed.',
      )
      schemaReferences = unparsedSchemaReferences(matchingReferences)
    } else if (matchingReferences.length === 0) {
      schemaDimension = dimension('schema_validation', 'NOT_APPLICABLE', [
        finding(
          'schema_validation',
          'no_matching_schema_reference',
          `The selected attestation type has no "${recognition.format ?? 'unknown'}" schema reference in this rulebook version.`,
          'info',
          '/schemaReferences',
        ),
      ])
      schemaReferences = []
    } else {
      const outcome = validateSchemaDocuments({
        references: matchingReferences,
        documents: request.schemaDocuments ?? [],
        parsed,
      })
      schemaDimension = dimension('schema_validation', outcome.status, outcome.findings)
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

      let status: ValidationStatus
      if (findings.some((entry) => entry.severity === 'error')) {
        status = 'FAIL'
      } else if (parsed === undefined) {
        status = 'NOT_TESTED'
        findings.push(
          finding(
            'attestation_constraints',
            'credential_not_parsed',
            'Credential-dependent attestation constraints were not evaluated because the credential was not parsed.',
            'info',
          ),
        )
      } else if (findings.some((entry) => entry.severity === 'warning')) {
        status = 'INCONCLUSIVE'
      } else {
        status = 'PASS'
      }
      attestationDimension = dimension('attestation_constraints', status, findings)
    }

    // FR-010 order: parsing, format recognition, crypto, schema, attestation,
    // trust, protocol, interoperability.
    const finalDimensions: readonly ValidationDimension[] = [
      parsingDimension,
      formatDimension,
      externalDimension(
        'cryptographic_verification',
        'NOT_TESTED',
        'signature_not_verified',
        'Credential signatures, key-binding proofs and status-list tokens were not verified; this endpoint performs structural validation only.',
        'warning',
      ),
      schemaDimension,
      attestationDimension,
      externalDimension(
        'issuer_trust',
        'NOT_TESTED',
        'trust_not_evaluated',
        'The credential issuer was not evaluated against trust anchors; no trust configuration was applied.',
        'warning',
      ),
      externalDimension(
        'protocol_conformance',
        'NOT_APPLICABLE',
        'protocol_not_applicable',
        'Protocol conformance requires a protocol interaction; a standalone credential artifact provides none.',
        'info',
      ),
      externalDimension(
        'interoperability',
        'NOT_APPLICABLE',
        'interoperability_not_applicable',
        'End-to-end interoperability requires external wallet and verifier execution and is never inferred from structural validation.',
        'info',
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
        digest,
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
      overallStatus: aggregateStatus(finalDimensions),
    }
  }
}
