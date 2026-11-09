// Rulebook-driven verifier constraint resolution (FR-014, issue #45).
//
// The resolver reads one pinned rulebook version, matches caller-supplied
// schema documents to its attestation references, verifies their sha256 SRI
// values and inspects the JSON Schema constraints in-process under hard bounds.
// It then returns the typed attribute/format constraints and the verifier-policy
// interfaces AttestBook can map them to, with every unsupported mapping
// reported. It performs no network request, signs nothing and claims no
// cryptographic, trust, protocol or interoperability result.

import { createHash } from 'node:crypto'

import { sha256Hex } from '../registry/digest'
import { invalidInput, notFound } from '../registry/errors'
import type { RulebookVersion } from '../registry/types'
import { parseRulebookVersionDocument } from '../registry/versioning'
import type { SchemaDocumentInput, SnapshotSchemaReference } from '../validation/types'

import {
  MAX_VERIFIER_ATTRIBUTES,
  assertBoundedDocument,
  classifySchemaDocument,
  inspectJsonSchema,
  type InspectedObjectLimitation,
} from './inspect'
import { buildDcqlMapping, buildPolicyInterfaces, isDcqlClaimPathExpressible } from './mapping'
import { parseResolveVerifierConstraintsInput } from './request'
import {
  VERIFIER_CONSTRAINTS_KIND,
  type ResolveVerifierConstraintsInput,
  type VerifierAttributeConstraint,
  type VerifierConstraintsResult,
  type VerifierFormatPolicy,
  type VerifierGroundingStatus,
  type VerifierPolicyDiagnostic,
  type VerifierPolicyService,
  type VerifierPolicySource,
  type VerifierRulebookEvidence,
  type VerifierSchemaReferenceEvidence,
} from './types'

const SRI_PATTERN = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=_-]+)$/

/** JSON Schema dialects this slice inspects; anything else is reported. */
const SUPPORTED_SCHEMA_DIALECTS = new Set([
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/schema#',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Boundaries every verifier-constraint result carries. */
const VERIFIER_LIMITATIONS: readonly string[] = [
  'The result exposes rulebook constraints and partial verifier-policy mappings; it is not an OpenID4VP authorization request, presentation definition or wallet-ready DCQL query.',
  'Attribute constraints come only from the exact schema documents supplied by the caller and matched to the pinned rulebook version; AttestBook does not fetch referenced documents.',
  'The DCQL mapping selects a format and claim paths only. JSON Schema value constraints, the required-claim rule, type identifiers, trusted authorities, holder proof and protocol parameters are reported as unsupported, never fabricated.',
  'SD-JWT VC Type Metadata references and unresolved JSON Schema keywords are reported; they are not converted into guessed constraints.',
  'No cryptographic verification, trust evaluation, protocol conformance or interoperability check is executed or implied by this result.',
  'No request, schema document or verifier policy is persisted; every response is computed from the pinned snapshot and the supplied bytes.',
]

function normalizeBase64(value: string): string {
  return value.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '')
}

function rulebookEvidence(
  rulebookName: string,
  rulebookId: string,
  version: RulebookVersion,
  digest: string,
): VerifierRulebookEvidence {
  return {
    id: rulebookId,
    name: rulebookName,
    version: version.version,
    digest,
    digestVerified: true,
    specVersion: version.specVersion,
    status: version.status,
  }
}

function diagnostic(code: string, message: string, path?: string): VerifierPolicyDiagnostic {
  return path === undefined ? { code, message } : { code, message, path }
}

function referenceEvidence(
  reference: SnapshotSchemaReference,
  options: {
    readonly integrityVerified: boolean
    readonly kind: 'json_schema' | 'type_metadata' | null
    readonly inspected: boolean
    readonly diagnostic?: string
  },
): VerifierSchemaReferenceEvidence {
  return {
    formatIdentifier: reference.formatIdentifier,
    uri: reference.uri,
    integrity: reference.integrity,
    integrityVerified: options.integrityVerified,
    kind: options.kind,
    inspected: options.inspected,
    ...(options.diagnostic === undefined ? {} : { diagnostic: options.diagnostic }),
  }
}

function validateSuppliedDocuments(
  request: ResolveVerifierConstraintsInput,
  attestationReferences: readonly SnapshotSchemaReference[],
): void {
  for (const supplied of request.schemaDocuments ?? []) {
    const matching = attestationReferences.filter((reference) => reference.uri === supplied.uri)
    if (matching.length === 0) {
      throw invalidInput(
        'schemaDocuments contains a URI that the selected attestation type does not reference in this rulebook version.',
      )
    }
    if (
      request.format !== undefined &&
      !matching.some((reference) => reference.formatIdentifier === request.format)
    ) {
      throw invalidInput(
        'schemaDocuments contains a URI that the selected attestation type does not reference for the requested format in this rulebook version.',
      )
    }
  }
}

function integrityProblem(
  reference: SnapshotSchemaReference,
): { readonly code: string; readonly message: string } | null {
  if (reference.integrity === null) {
    return {
      code: 'schema_reference_unpinned',
      message: `The rulebook schema reference "${reference.uri}" has no sha256 SRI value, so the supplied document cannot be grounded and was not inspected.`,
    }
  }
  const match = SRI_PATTERN.exec(reference.integrity)
  if (match === null) {
    return {
      code: 'invalid_integrity_value',
      message: `The rulebook schema reference "${reference.uri}" has a malformed integrity value, so the supplied document was not inspected.`,
    }
  }
  if (match[1] !== 'sha256') {
    return {
      code: 'unsupported_integrity_algorithm',
      message: `AttestBook verifies sha256 SRI only; the "${match[1] ?? 'unknown'}" pin for "${reference.uri}" was not checked and its document was not inspected.`,
    }
  }
  return null
}

function inspectFormat(
  format: string,
  index: number,
  references: readonly SnapshotSchemaReference[],
  documents: ReadonlyMap<string, SchemaDocumentInput>,
): VerifierFormatPolicy {
  const diagnostics: VerifierPolicyDiagnostic[] = []
  const schemaReferences: VerifierSchemaReferenceEvidence[] = []
  const attributes: VerifierAttributeConstraint[] = []
  const objectLimitations: InspectedObjectLimitation[] = []
  let appliedCount = 0
  let suppliedCount = 0

  for (const reference of references) {
    const supplied = documents.get(reference.uri)
    if (supplied === undefined) {
      diagnostics.push(
        diagnostic(
          'schema_document_not_supplied',
          `No document was supplied for the rulebook schema reference "${reference.uri}"; its constraints were not inspected.`,
          reference.uri,
        ),
      )
      schemaReferences.push(
        referenceEvidence(reference, {
          integrityVerified: false,
          kind: null,
          inspected: false,
          diagnostic: 'the caller supplied no document for this reference',
        }),
      )
      continue
    }
    suppliedCount += 1

    const problem = integrityProblem(reference)
    if (problem !== null) {
      diagnostics.push(diagnostic(problem.code, problem.message, reference.uri))
      schemaReferences.push(
        referenceEvidence(reference, {
          integrityVerified: false,
          kind: null,
          inspected: false,
          diagnostic: problem.message,
        }),
      )
      continue
    }

    const expected = normalizeBase64(SRI_PATTERN.exec(reference.integrity ?? '')?.[2] ?? '')
    const actual = normalizeBase64(
      createHash('sha256').update(supplied.content, 'utf8').digest('base64'),
    )
    if (actual !== expected) {
      throw invalidInput(
        `The supplied schema document for "${reference.uri}" does not match the pinned sha256 integrity value.`,
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(supplied.content)
    } catch {
      throw invalidInput(`The supplied schema document for "${reference.uri}" is not valid JSON.`)
    }
    assertBoundedDocument(parsed, `schema document "${reference.uri}"`)

    const kind = classifySchemaDocument(parsed)
    if (kind === 'unsupported') {
      throw invalidInput(
        `The supplied schema document for "${reference.uri}" must be a JSON object.`,
      )
    }
    if (kind === 'type_metadata') {
      diagnostics.push(
        diagnostic(
          'type_metadata_not_inspected',
          `The reference "${reference.uri}" resolves to SD-JWT VC Type Metadata, which declares claims and display data but no JSON Schema value constraints; it was not converted into guessed constraints.`,
          reference.uri,
        ),
      )
      schemaReferences.push(
        referenceEvidence(reference, {
          integrityVerified: true,
          kind: 'type_metadata',
          inspected: false,
          diagnostic: 'Type Metadata carries no JSON Schema value constraints',
        }),
      )
      continue
    }

    const dialect =
      isRecord(parsed) && Object.hasOwn(parsed, '$schema') ? parsed['$schema'] : undefined
    if (
      dialect !== undefined &&
      (typeof dialect !== 'string' || !SUPPORTED_SCHEMA_DIALECTS.has(dialect))
    ) {
      diagnostics.push(
        diagnostic(
          'unsupported_schema_dialect',
          `The reference "${reference.uri}" declares a JSON Schema dialect other than 2020-12, so its constraints were not inspected.`,
          reference.uri,
        ),
      )
      schemaReferences.push(
        referenceEvidence(reference, {
          integrityVerified: true,
          kind: 'json_schema',
          inspected: false,
          diagnostic: 'unsupported JSON Schema dialect',
        }),
      )
      continue
    }

    const inspection = inspectJsonSchema(parsed, reference.uri)
    appliedCount += 1
    attributes.push(...inspection.attributes)
    objectLimitations.push(...inspection.objectLimitations)
    for (const entry of inspection.diagnostics) {
      diagnostics.push(
        diagnostic(entry.code, `${reference.uri}: ${entry.message}`, entry.path ?? reference.uri),
      )
    }
    schemaReferences.push(
      referenceEvidence(reference, {
        integrityVerified: true,
        kind: 'json_schema',
        inspected: true,
      }),
    )
  }

  attributes.sort((left, right) => {
    const pointer = left.pointer.localeCompare(right.pointer)
    return pointer !== 0 ? pointer : left.sources.join().localeCompare(right.sources.join())
  })
  if (attributes.length > MAX_VERIFIER_ATTRIBUTES) {
    throw invalidInput(
      `The supplied schema documents declare more than ${MAX_VERIFIER_ATTRIBUTES} typed attributes.`,
    )
  }

  let grounding: VerifierGroundingStatus
  if (appliedCount > 0) {
    grounding = appliedCount === references.length ? 'verified' : 'partially_verified'
  } else {
    grounding = suppliedCount === 0 ? 'not_supplied' : 'not_grounded'
  }

  const mappedAttributes = attributes.map((attribute) => ({
    ...attribute,
    claimPathSupported: isDcqlClaimPathExpressible(format, attribute.claimPath),
  }))
  const dcql = buildDcqlMapping({
    format,
    index,
    attributes: mappedAttributes,
    objectLimitations,
  })
  return {
    format,
    grounding,
    schemaReferences,
    attributes: mappedAttributes,
    dcql,
    diagnostics,
  }
}

/** The typed, framework-independent verifier constraint resolver. */
export class VerifierPolicyResolver implements VerifierPolicyService {
  private readonly source: VerifierPolicySource

  constructor(options: { readonly source: VerifierPolicySource }) {
    this.source = options.source
  }

  resolve(input: unknown): VerifierConstraintsResult {
    const request = parseResolveVerifierConstraintsInput(input)

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

    const document = parseRulebookVersionDocument(content.bytes)
    const attestation = document.attestations.find(
      (candidate) => candidate.name === request.attestationType,
    )
    if (attestation === undefined) {
      throw notFound('The attestation type does not exist in this rulebook version.')
    }

    if (request.format !== undefined && !attestation.supportedFormats.includes(request.format)) {
      throw invalidInput('format is not supported by the selected attestation type.')
    }

    validateSuppliedDocuments(request, attestation.schemaReferences)

    const documents = new Map<string, SchemaDocumentInput>()
    for (const supplied of request.schemaDocuments ?? []) {
      documents.set(supplied.uri, supplied)
    }

    const formats = request.format === undefined ? attestation.supportedFormats : [request.format]
    const formatPolicies: VerifierFormatPolicy[] = []
    formats.forEach((format, index) => {
      const references = attestation.schemaReferences.filter(
        (reference) => reference.formatIdentifier === format,
      )
      if (references.length === 0) {
        formatPolicies.push({
          format,
          grounding: 'not_grounded',
          schemaReferences: [],
          attributes: [],
          dcql: buildDcqlMapping({ format, index, attributes: [], objectLimitations: [] }),
          diagnostics: [
            diagnostic(
              'no_schema_reference_for_format',
              `The selected attestation type declares no schema reference for the "${format}" format in this rulebook version, so no attribute constraint can be grounded.`,
            ),
          ],
        })
        return
      }
      formatPolicies.push(inspectFormat(format, index, references, documents))
    })

    const diagnostics: VerifierPolicyDiagnostic[] = []
    if (formatPolicies.length === 0) {
      diagnostics.push(
        diagnostic(
          'no_supported_format',
          'The selected attestation type declares no supported credential format in this rulebook version.',
        ),
      )
    }

    return {
      kind: VERIFIER_CONSTRAINTS_KIND,
      rulebook: rulebookEvidence(rulebook.name, rulebook.id, version, digest),
      attestation: {
        name: attestation.name,
        attestationLoS: attestation.attestationLoS,
        bindingType: attestation.bindingType,
        supportedFormats: [...attestation.supportedFormats],
      },
      formats: formatPolicies,
      policyInterfaces: buildPolicyInterfaces(),
      diagnostics,
      nonClaims: {
        presentationRequest: false,
        proof: false,
        cryptographicVerification: 'NOT_TESTED',
        protocolConformance: 'NOT_TESTED',
        interoperability: 'NOT_TESTED',
      },
      limitations: [...VERIFIER_LIMITATIONS],
    }
  }
}
