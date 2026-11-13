// Schema and attribute validation against the pinned rulebook (issue #32).
//
// The rulebook version snapshot stores schema references (URI + W3C SRI), not
// schema bodies. A reference that is a canonical AttestBook-hosted URL is
// resolved from the immutable local store before the request is considered
// (#101); it is never fetched over HTTP and caller-supplied bytes cannot
// override it. External references still require the exact bytes from the
// caller: the SSRF-safe fetch path is issue #30. This module matches documents
// to the selected rulebook references, verifies the reference `#integrity`, and
// applies the document:
//   * SD-JWT VC Type Metadata is checked with the pinned
//     `@sd-jwt/sd-jwt-vc` `verifyClaimsAgainstTypeMetadata` implementation;
//   * any other object is treated as JSON Schema 2020-12 and validated with
//     Ajv 8.20.0.
//
// A reference whose document was not supplied is NOT_TESTED, never PASS.

import { createHash } from 'node:crypto'

import {
  TypeMetadataFormatSchema,
  verifyClaimsAgainstTypeMetadata,
  type ClaimPath,
  type TypeMetadataFormat,
} from '@sd-jwt/sd-jwt-vc'
import Ajv2020 from 'ajv/dist/2020.js'
import type { Disclosure } from '@sd-jwt/core'

import { sha256Sri } from '../public-urls'
import type { HostedSchemaResolution } from './hosted-schema'
import type {
  SchemaDocumentInput,
  SchemaReferenceEvidence,
  SnapshotSchemaReference,
  ValidationFinding,
  ValidationStatus,
} from './types'

const SRI_PATTERN = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=_-]+)$/

/** Defensive bound before a caller-supplied document reaches Ajv compilation. */
const MAX_SCHEMA_DEPTH = 64

/** Bound on credential claim nodes handed to any schema evaluator. */
const MAX_CREDENTIAL_CLAIM_NODES = 4_096

/**
 * Keywords whose evaluation AttestBook cannot bound yet. `pattern`/`format`
 * run JavaScript regular expressions or format validators over attacker
 * controlled strings (catastrophic backtracking), and `uniqueItems` is
 * super-linear. `$ref`/`$dynamicRef`/`$recursiveRef` can reach a hidden
 * `pattern` anywhere in the document, including unknown members and `enum`
 * values, so references are rejected until a safe resolver is pinned. All of
 * them are reported unsupported instead of executed or silently ignored.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  '$dynamicRef',
  '$recursiveRef',
  '$ref',
  // Legacy draft keyword; Ajv still evaluates it and its values are schemas.
  'dependencies',
  'format',
  'pattern',
  'patternProperties',
  'uniqueItems',
] as const

const SUPPORTED_SCHEMA_DIALECTS = new Set([
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/schema#',
])

const SINGLE_SCHEMA_KEYWORDS = new Set([
  'additionalProperties',
  'additionalItems',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
])

const MAP_SCHEMA_KEYWORDS = new Set(['$defs', 'definitions', 'dependentSchemas', 'properties'])

const ARRAY_SCHEMA_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])

/**
 * Root members that only make sense on a JSON Schema. A document that has both
 * `vct` and one of these is ambiguous: classifying it as Type Metadata would
 * silently skip its JSON Schema constraints.
 */
const JSON_SCHEMA_ROOT_KEYWORDS = [
  '$anchor',
  '$defs',
  '$dynamicAnchor',
  '$dynamicRef',
  '$recursiveRef',
  '$ref',
  '$schema',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'definitions',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'else',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'if',
  'items',
  'maxContains',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minContains',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'not',
  'oneOf',
  'pattern',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'required',
  'then',
  'type',
  'unevaluatedItems',
  'unevaluatedProperties',
  'uniqueItems',
] as const

function looksLikeJsonSchema(document: Record<string, unknown>): boolean {
  return JSON_SCHEMA_ROOT_KEYWORDS.some((keyword) => keyword in document)
}

/**
 * A fresh Ajv instance per document: caller-supplied schemas are untrusted and
 * may reuse `$id` values, so compiled state must not leak between requests.
 */
function createAjv(): Ajv2020 {
  return new Ajv2020({
    // Stop after the first violation: building every error for an untrusted
    // schema applied to an attacker-controlled claim set is itself unbounded.
    allErrors: false,
    strict: false,
    // Reject unknown keywords instead of silently ignoring them: ignoring a
    // constraint would report PASS without evaluating it.
    strictSchema: true,
    validateFormats: false,
    allowUnionTypes: true,
  })
}

/** A schema reference that has been matched to a supplied document. */
export interface SchemaApplication {
  readonly reference: SnapshotSchemaReference
  readonly kind: 'type_metadata' | 'json_schema' | null
  readonly applied: boolean
  readonly status: ValidationStatus
  readonly findings: readonly ValidationFinding[]
}

export interface SchemaValidationOutcome {
  readonly status: ValidationStatus
  readonly findings: readonly ValidationFinding[]
  readonly applications: readonly SchemaApplication[]
  readonly schemaReferences: readonly SchemaReferenceEvidence[]
}

/**
 * Serializable input for the schema sandbox worker. It deliberately contains
 * no class instances: disclosures are reduced to the member name and value the
 * Type Metadata verifier reads.
 */
export interface SchemaEvaluationInput {
  readonly claims: Record<string, unknown>
  readonly packedPayload: Record<string, unknown>
  readonly disclosureMap: Readonly<
    Record<string, { readonly key?: string; readonly value: unknown }>
  >
  readonly vct: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function countNodes(value: unknown, limit: number): number {
  let count = 0
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const current = stack.pop()
    count += 1
    if (count > limit) {
      return count
    }
    if (Array.isArray(current)) {
      for (const entry of current) {
        stack.push(entry)
      }
    } else if (isRecord(current)) {
      for (const entry of Object.values(current)) {
        stack.push(entry)
      }
    }
  }
  return count
}

function exceedsDepth(value: unknown, limit: number, depth = 0): boolean {
  if (depth > limit) {
    return true
  }
  if (Array.isArray(value)) {
    return value.some((entry) => exceedsDepth(entry, limit, depth + 1))
  }
  if (isRecord(value)) {
    return Object.values(value).some((entry) => exceedsDepth(entry, limit, depth + 1))
  }
  return false
}

export interface UnsupportedSchemaKeyword {
  readonly keyword: string
  readonly path: readonly string[]
}

function scanSchemaNode(schema: unknown, path: readonly string[]): UnsupportedSchemaKeyword | null {
  if (typeof schema === 'boolean' || !isRecord(schema)) {
    return null
  }
  for (const keyword of UNSUPPORTED_SCHEMA_KEYWORDS) {
    if (keyword in schema) {
      return { keyword, path: [...path, keyword] }
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (SINGLE_SCHEMA_KEYWORDS.has(key)) {
      const found = scanSchemaValue(value, [...path, key])
      if (found !== null) {
        return found
      }
    } else if (MAP_SCHEMA_KEYWORDS.has(key) && isRecord(value)) {
      for (const [name, subSchema] of Object.entries(value)) {
        const found = scanSchemaNode(subSchema, [...path, key, name])
        if (found !== null) {
          return found
        }
      }
    } else if (ARRAY_SCHEMA_KEYWORDS.has(key) && Array.isArray(value)) {
      for (const [position, subSchema] of value.entries()) {
        const found = scanSchemaNode(subSchema, [...path, key, String(position)])
        if (found !== null) {
          return found
        }
      }
    }
  }
  return null
}

function scanSchemaValue(value: unknown, path: readonly string[]): UnsupportedSchemaKeyword | null {
  if (Array.isArray(value)) {
    for (const [position, subSchema] of value.entries()) {
      const found = scanSchemaNode(subSchema, [...path, String(position)])
      if (found !== null) {
        return found
      }
    }
    return null
  }
  return scanSchemaNode(value, path)
}

/**
 * Finds JSON Schema keywords AttestBook must not execute over untrusted input.
 * The walk is schema-aware: a *data property* named `pattern` under
 * `properties` is a property name, not the `pattern` keyword.
 */
export function findUnsupportedSchemaKeyword(schema: unknown): UnsupportedSchemaKeyword | null {
  return scanSchemaNode(schema, [])
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1')
}

/**
 * Renders a JSON Pointer. Type-metadata claim paths may contain a `null`
 * wildcard for an array element; JSON Pointer has no wildcard, so `*` is used
 * and documented in the API contract.
 */
export function toJsonPointer(segments: readonly (string | number | null)[]): string {
  if (segments.length === 0) {
    return '/'
  }
  return `/${segments
    .map((segment) => escapePointerSegment(segment === null ? '*' : String(segment)))
    .join('/')}`
}

function claimPath(path: ClaimPath): string {
  return toJsonPointer(path)
}

function finding(
  code: string,
  message: string,
  severity: 'error' | 'warning',
  path?: string,
  expected?: string,
): ValidationFinding {
  return {
    code,
    message,
    severity,
    dimension: 'schema_validation',
    ...(path === undefined ? {} : { path }),
    ...(expected === undefined ? {} : { expected }),
  }
}

function normalizeBase64(value: string): string {
  return value.replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '')
}

function verifyIntegrity(
  reference: SnapshotSchemaReference,
  content: string,
  index: number,
): {
  readonly status: 'verified' | 'unpinned' | 'unverified' | 'mismatch'
  readonly findings: readonly ValidationFinding[]
} {
  if (reference.integrity === null) {
    return {
      status: 'unpinned',
      findings: [
        finding(
          'schema_document_unpinned',
          'The rulebook schema reference has no integrity value, so the supplied document was not applied and schema validation was not tested.',
          'warning',
          `/schemaReferences/${index}/integrity`,
        ),
      ],
    }
  }
  const match = SRI_PATTERN.exec(reference.integrity)
  if (match === null) {
    return {
      status: 'unverified',
      findings: [
        finding(
          'invalid_integrity_value',
          'The rulebook schema reference has a malformed integrity value; the supplied document was not pinned.',
          'warning',
          `/schemaReferences/${index}/integrity`,
        ),
      ],
    }
  }
  const algorithm = match[1]
  const expected = normalizeBase64(match[2] ?? '')
  if (algorithm !== 'sha256') {
    return {
      status: 'unverified',
      findings: [
        finding(
          'unsupported_integrity_algorithm',
          `AttestBook verifies sha256 SRI only; the "${algorithm}" pin was not checked.`,
          'warning',
          `/schemaReferences/${index}/integrity`,
        ),
      ],
    }
  }
  const actual = normalizeBase64(createHash('sha256').update(content, 'utf8').digest('base64'))
  if (actual !== expected) {
    return {
      status: 'mismatch',
      findings: [
        finding(
          'integrity_mismatch',
          'The supplied schema document does not match the pinned rulebook integrity value.',
          'error',
          `/schemaReferences/${index}/integrity`,
        ),
      ],
    }
  }
  return { status: 'verified', findings: [] }
}

/**
 * Verifies the pinned SRI of a hosted reference against the digest recorded for
 * the stored document. The bytes were already verified against that digest by
 * the resolver, so a matching pin proves the URI, the store and the rulebook
 * all name the same exact document.
 */
function verifyHostedIntegrity(
  reference: SnapshotSchemaReference,
  contentDigest: string,
  index: number,
): {
  readonly status: 'verified' | 'unpinned' | 'unverified' | 'mismatch'
  readonly findings: readonly ValidationFinding[]
} {
  if (reference.integrity === null) {
    return {
      status: 'unpinned',
      findings: [
        finding(
          'hosted_schema_reference_unpinned',
          'The pinned AttestBook-hosted schema reference has no sha256 integrity value, so the stored document was not applied.',
          'warning',
          `/schemaReferences/${index}/integrity`,
        ),
      ],
    }
  }
  const match = SRI_PATTERN.exec(reference.integrity)
  if (match === null) {
    return {
      status: 'unverified',
      findings: [
        finding(
          'invalid_integrity_value',
          'The pinned AttestBook-hosted schema reference has a malformed integrity value; the stored document was not applied.',
          'warning',
          `/schemaReferences/${index}/integrity`,
        ),
      ],
    }
  }
  const algorithm = match[1]
  if (algorithm !== 'sha256') {
    return {
      status: 'unverified',
      findings: [
        finding(
          'unsupported_integrity_algorithm',
          `AttestBook verifies sha256 SRI only; the "${algorithm}" pin on the hosted schema reference was not checked.`,
          'warning',
          `/schemaReferences/${index}/integrity`,
        ),
      ],
    }
  }
  const expected = normalizeBase64(sha256Sri(contentDigest).slice('sha256-'.length))
  if (normalizeBase64(match[2] ?? '') !== expected) {
    return {
      status: 'mismatch',
      findings: [
        finding(
          'hosted_schema_integrity_mismatch',
          'The stored AttestBook-hosted schema document does not match the pinned rulebook integrity value; it was not applied.',
          'error',
          `/schemaReferences/${index}/integrity`,
        ),
      ],
    }
  }
  return { status: 'verified', findings: [] }
}

function zodIssuePath(issue: { readonly path: readonly PropertyKey[] }): string {
  return toJsonPointer(issue.path.map((segment) => String(segment)))
}

function validateTypeMetadata(
  reference: SnapshotSchemaReference,
  index: number,
  document: unknown,
  input: SchemaEvaluationInput,
): SchemaApplication {
  const schema = TypeMetadataFormatSchema.safeParse(document)
  if (!schema.success) {
    const first = schema.error.issues[0]
    return {
      reference,
      kind: 'type_metadata',
      applied: true,
      status: 'FAIL',
      findings: [
        finding(
          'invalid_type_metadata',
          'The supplied document does not match the SD-JWT VC Type Metadata schema.',
          'error',
          first === undefined ? `/schemaReferences/${index}` : zodIssuePath(first),
        ),
      ],
    }
  }

  const typeMetadata: TypeMetadataFormat = schema.data
  const findings: ValidationFinding[] = []
  if (typeMetadata.vct !== input.vct) {
    findings.push(
      finding(
        'vct_mismatch',
        'The type metadata `vct` does not match the credential `vct`.',
        'error',
        '/vct',
        `vct equals "${typeMetadata.vct}"`,
      ),
    )
    return {
      reference,
      kind: 'type_metadata',
      applied: true,
      status: 'FAIL',
      findings,
    }
  }

  if (typeMetadata.extends !== undefined || typeMetadata['extends#integrity'] !== undefined) {
    findings.push(
      finding(
        'type_metadata_extends_unsupported',
        'The supplied type metadata extends a parent type. AttestBook does not resolve the parent chain yet, so inherited mandatory and selective-disclosure constraints were not verified.',
        'warning',
        `/schemaReferences/${index}`,
      ),
    )
  }

  const verification = verifyClaimsAgainstTypeMetadata(
    typeMetadata,
    input.packedPayload,
    input.disclosureMap as unknown as Record<string, Disclosure>,
  )
  for (const path of verification.missingMandatoryClaims) {
    findings.push(
      finding(
        'missing_mandatory_claim',
        'A mandatory claim declared by the type metadata is absent from the credential.',
        'error',
        claimPath(path),
        'the mandatory claim is present',
      ),
    )
  }
  for (const path of verification.undisclosedMandatoryClaims) {
    findings.push(
      finding(
        'mandatory_claim_undisclosed',
        'A mandatory claim is present but was left selectively undisclosed.',
        'error',
        claimPath(path),
        'the mandatory claim is disclosed',
      ),
    )
  }
  for (const path of verification.invalidNonSelectivelyDisclosableClaims) {
    findings.push(
      finding(
        'claim_must_be_selectively_disclosable',
        'The type metadata requires this claim to be selectively disclosable, but it is issuer-signed in clear.',
        'error',
        claimPath(path),
        'the claim is selectively disclosable',
      ),
    )
  }
  for (const path of verification.invalidSelectivelyDisclosableClaims) {
    findings.push(
      finding(
        'claim_must_not_be_selectively_disclosable',
        'The type metadata forbids selectively disclosing this claim, but it was disclosed.',
        'error',
        claimPath(path),
        'the claim is issuer-signed, not selectively disclosed',
      ),
    )
  }
  for (const path of verification.extraClaims) {
    findings.push(
      finding(
        'undeclared_claim',
        'The credential contains a claim that the type metadata does not declare.',
        'warning',
        claimPath(path),
        'the claim is declared by the type metadata',
      ),
    )
  }

  return {
    reference,
    kind: 'type_metadata',
    applied: true,
    status: findings.some((entry) => entry.severity === 'error')
      ? 'FAIL'
      : findings.length > 0
        ? 'INCONCLUSIVE'
        : 'PASS',
    findings,
  }
}

interface AjvErrorLike {
  readonly instancePath?: string
  readonly keyword?: string
  readonly message?: string
  readonly params?: Record<string, unknown>
}

function validateJsonSchema(
  reference: SnapshotSchemaReference,
  index: number,
  document: unknown,
  claims: Record<string, unknown>,
): SchemaApplication {
  if (typeof document !== 'boolean' && !isRecord(document)) {
    return {
      reference,
      kind: 'json_schema',
      applied: false,
      status: 'FAIL',
      findings: [
        finding(
          'invalid_json_schema',
          'The supplied document is not a JSON Schema object.',
          'error',
          `/schemaReferences/${index}`,
        ),
      ],
    }
  }

  if (isRecord(document) && '$schema' in document) {
    const dialect = document.$schema
    if (typeof dialect !== 'string' || !SUPPORTED_SCHEMA_DIALECTS.has(dialect)) {
      return {
        reference,
        kind: 'json_schema',
        applied: false,
        status: 'NOT_TESTED',
        findings: [
          finding(
            'unsupported_schema_dialect',
            'The supplied JSON Schema declares a dialect other than JSON Schema 2020-12; schema validation was not executed.',
            'warning',
            `/schemaReferences/${index}`,
          ),
        ],
      }
    }
  }

  let validate: ReturnType<Ajv2020['compile']>
  try {
    validate = createAjv().compile(document)
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message.includes('strict mode: unknown keyword')) {
      return {
        reference,
        kind: 'json_schema',
        applied: false,
        status: 'NOT_TESTED',
        findings: [
          finding(
            'unsupported_schema_keyword',
            'The supplied JSON Schema uses a keyword AttestBook does not evaluate; schema validation was not executed.',
            'warning',
            `/schemaReferences/${index}`,
          ),
        ],
      }
    }
    return {
      reference,
      kind: 'json_schema',
      applied: false,
      status: 'FAIL',
      findings: [
        finding(
          'invalid_json_schema',
          'The supplied document is not a compilable JSON Schema 2020-12 document.',
          'error',
          `/schemaReferences/${index}`,
        ),
      ],
    }
  }

  if (validate(claims)) {
    return { reference, kind: 'json_schema', applied: true, status: 'PASS', findings: [] }
  }

  const findings = (validate.errors ?? []).map((error: AjvErrorLike) => {
    const path =
      error.instancePath === undefined || error.instancePath === '' ? '/' : error.instancePath
    const keyword = error.keyword ?? 'schema'
    return finding(
      'schema_violation',
      `The credential claims violate the JSON Schema "${keyword}" constraint.`,
      'error',
      path,
      keyword,
    )
  })
  return {
    reference,
    kind: 'json_schema',
    applied: true,
    status: 'FAIL',
    findings,
  }
}

/** D-8 status aggregation for the schema-validation dimension. */
export function aggregateSchemaStatus(statuses: readonly ValidationStatus[]): ValidationStatus {
  if (statuses.length === 0) {
    return 'NOT_APPLICABLE'
  }
  if (statuses.includes('FAIL')) {
    return 'FAIL'
  }
  if (statuses.includes('INCONCLUSIVE')) {
    return 'INCONCLUSIVE'
  }
  if (statuses.every((entry) => entry === 'NOT_TESTED')) {
    return 'NOT_TESTED'
  }
  if (statuses.includes('NOT_TESTED')) {
    return 'INCONCLUSIVE'
  }
  if (statuses.includes('PASS')) {
    return 'PASS'
  }
  return 'NOT_APPLICABLE'
}

/** A reference whose document resolved to enough facts to finish in-process. */
export interface SettledSchemaDocument {
  readonly index: number
  readonly application: SchemaApplication
  readonly evidence: SchemaReferenceEvidence
}

/** A verified document whose compute-heavy evaluation belongs in the sandbox. */
export interface PendingSchemaDocument {
  readonly index: number
  readonly reference: SnapshotSchemaReference
  readonly kind: 'type_metadata' | 'json_schema'
  readonly document: unknown
  readonly integrityFindings: readonly ValidationFinding[]
  /**
   * Document provenance for the API evidence. Absent for the compile-only
   * registration check, which never produces validation evidence.
   */
  readonly source?: 'hosted' | 'caller'
}

export interface PreparedSchemaDocuments {
  readonly settled: readonly SettledSchemaDocument[]
  readonly pending: readonly PendingSchemaDocument[]
}

export interface PrepareSchemaDocumentsOptions {
  readonly references: readonly SnapshotSchemaReference[]
  readonly documents: readonly SchemaDocumentInput[]
  /**
   * Resolved hosted documents keyed by reference index (#101). A reference in
   * this map is never resolved from the caller's documents, so caller content
   * cannot override a trusted pinned hosted schema.
   */
  readonly hosted?: ReadonlyMap<number, HostedSchemaResolution>
  readonly claims: Record<string, unknown>
}

function settle(
  index: number,
  reference: SnapshotSchemaReference,
  application: SchemaApplication,
  source: 'hosted' | 'caller' | null,
): SettledSchemaDocument {
  return {
    index,
    application,
    evidence: {
      formatIdentifier: reference.formatIdentifier,
      uri: reference.uri,
      integrity: reference.integrity,
      kind: application.kind,
      applied: application.applied,
      source,
    },
  }
}

/**
 * Applies every supplied or hosted document to the selected rulebook
 * references. `references` must already be filtered to the credential format.
 * This performs only the cheap checks in the HTTP process: input bounds,
 * reference matching, integrity, JSON parsing, depth, ambiguity and the
 * unsupported-keyword scan. Only verified documents reach `pending`.
 */
export function prepareSchemaDocuments(
  options: PrepareSchemaDocumentsOptions,
): PreparedSchemaDocuments {
  const settled: SettledSchemaDocument[] = []
  const pending: PendingSchemaDocument[] = []

  const claimNodes = countNodes(options.claims, MAX_CREDENTIAL_CLAIM_NODES)
  if (claimNodes > MAX_CREDENTIAL_CLAIM_NODES) {
    for (const [index, reference] of options.references.entries()) {
      settled.push(
        settle(
          index,
          reference,
          {
            reference,
            kind: null,
            applied: false,
            status: 'NOT_TESTED',
            findings: [
              finding(
                'credential_claims_too_many',
                `The credential carries more than ${MAX_CREDENTIAL_CLAIM_NODES} claim nodes; schema validation was not executed.`,
                'warning',
                `/schemaReferences/${index}`,
              ),
            ],
          },
          null,
        ),
      )
    }
    return { settled, pending }
  }

  options.references.forEach((reference, index) => {
    const hosted = options.hosted?.get(index)
    if (hosted !== undefined) {
      prepareHostedReference(reference, index, hosted, settled, pending)
      return
    }
    prepareCallerReference(reference, index, options, settled, pending)
  })

  return { settled, pending }
}

/** Settles or queues one canonical AttestBook-hosted reference. */
function prepareHostedReference(
  reference: SnapshotSchemaReference,
  index: number,
  resolution: HostedSchemaResolution,
  settled: SettledSchemaDocument[],
  pending: PendingSchemaDocument[],
): void {
  if (resolution.kind === 'missing') {
    settled.push(
      settle(
        index,
        reference,
        {
          reference,
          kind: null,
          applied: false,
          status: 'NOT_TESTED',
          findings: [
            finding(
              'hosted_schema_document_missing',
              'The pinned AttestBook-hosted schema document is not present in the local schema store; schema validation was not executed.',
              'warning',
              `/schemaReferences/${index}`,
            ),
          ],
        },
        'hosted',
      ),
    )
    return
  }

  if (resolution.kind === 'corrupt') {
    settled.push(
      settle(
        index,
        reference,
        {
          reference,
          kind: null,
          applied: false,
          status: 'FAIL',
          findings: [
            finding(
              'hosted_schema_document_corrupt',
              'The stored bytes of the pinned AttestBook-hosted schema document do not match their recorded SHA-256 digest; the document was not applied.',
              'error',
              `/schemaReferences/${index}`,
            ),
          ],
        },
        'hosted',
      ),
    )
    return
  }

  const integrity = verifyHostedIntegrity(reference, resolution.contentDigest, index)
  if (integrity.status !== 'verified') {
    settled.push(
      settle(
        index,
        reference,
        {
          reference,
          kind: null,
          applied: false,
          status:
            integrity.status === 'mismatch'
              ? 'FAIL'
              : integrity.status === 'unverified'
                ? 'INCONCLUSIVE'
                : 'NOT_TESTED',
          findings: integrity.findings,
        },
        'hosted',
      ),
    )
    return
  }

  let document: unknown
  try {
    document = JSON.parse(resolution.content)
  } catch {
    settled.push(
      settle(
        index,
        reference,
        {
          reference,
          kind: null,
          applied: false,
          status: 'FAIL',
          findings: [
            finding(
              'invalid_schema_document',
              'The stored AttestBook-hosted schema document is not valid JSON.',
              'error',
              `/schemaReferences/${index}`,
            ),
          ],
        },
        'hosted',
      ),
    )
    return
  }

  queueVerifiedDocument(
    index,
    reference,
    document,
    integrity.findings,
    'hosted',
    `/schemaReferences/${index}`,
    settled,
    pending,
  )
}

/** Settles or queues one reference resolved from the caller's documents. */
function prepareCallerReference(
  reference: SnapshotSchemaReference,
  index: number,
  options: PrepareSchemaDocumentsOptions,
  settled: SettledSchemaDocument[],
  pending: PendingSchemaDocument[],
): void {
  const documentIndex = options.documents.findIndex((entry) => entry.uri === reference.uri)
  const supplied = documentIndex === -1 ? undefined : options.documents[documentIndex]
  if (supplied === undefined) {
    settled.push(
      settle(
        index,
        reference,
        {
          reference,
          kind: null,
          applied: false,
          status: 'NOT_TESTED',
          findings: [
            finding(
              'schema_document_not_supplied',
              `No document was supplied for the rulebook schema reference "${reference.uri}"; schema validation was not executed.`,
              'warning',
              `/schemaReferences/${index}`,
            ),
          ],
        },
        null,
      ),
    )
    return
  }

  const integrity = verifyIntegrity(reference, supplied.content, index)
  if (integrity.status !== 'verified') {
    settled.push(
      settle(
        index,
        reference,
        {
          reference,
          kind: null,
          applied: false,
          status:
            integrity.status === 'mismatch'
              ? 'FAIL'
              : integrity.status === 'unverified'
                ? 'INCONCLUSIVE'
                : 'NOT_TESTED',
          findings: integrity.findings,
        },
        'caller',
      ),
    )
    return
  }

  let document: unknown
  try {
    document = JSON.parse(supplied.content)
  } catch {
    settled.push(
      settle(
        index,
        reference,
        {
          reference,
          kind: null,
          applied: false,
          status: 'FAIL',
          findings: [
            finding(
              'invalid_schema_document',
              'The supplied schema document is not valid JSON.',
              'error',
              `/schemaDocuments/${documentIndex}`,
            ),
          ],
        },
        'caller',
      ),
    )
    return
  }

  queueVerifiedDocument(
    index,
    reference,
    document,
    integrity.findings,
    'caller',
    `/schemaDocuments/${documentIndex}`,
    settled,
    pending,
  )
}

/** Shared bounds after a document's exact bytes and pin were verified. */
function queueVerifiedDocument(
  index: number,
  reference: SnapshotSchemaReference,
  document: unknown,
  integrityFindings: readonly ValidationFinding[],
  source: 'hosted' | 'caller',
  documentPath: string,
  settled: SettledSchemaDocument[],
  pending: PendingSchemaDocument[],
): void {
  const provenance = source === 'hosted' ? 'stored' : 'supplied'
  const typeMetadataLike = isRecord(document) && typeof document.vct === 'string'
  const kind: 'type_metadata' | 'json_schema' = typeMetadataLike ? 'type_metadata' : 'json_schema'

  if (exceedsDepth(document, MAX_SCHEMA_DEPTH)) {
    settled.push(
      settle(
        index,
        reference,
        {
          reference,
          kind,
          applied: false,
          status: 'FAIL',
          findings: [
            finding(
              'schema_document_too_deep',
              `The ${provenance} schema document exceeds the ${MAX_SCHEMA_DEPTH}-level nesting bound.`,
              'error',
              documentPath,
            ),
          ],
        },
        source,
      ),
    )
    return
  }

  if (typeMetadataLike && looksLikeJsonSchema(document)) {
    settled.push(
      settle(
        index,
        reference,
        {
          reference,
          kind: null,
          applied: false,
          status: 'NOT_TESTED',
          findings: [
            finding(
              'ambiguous_schema_document',
              `The ${provenance} document has a \`vct\` member and JSON Schema keywords; its kind is ambiguous, so it was not evaluated.`,
              'warning',
              `/schemaReferences/${index}`,
            ),
          ],
        },
        source,
      ),
    )
    return
  }

  if (kind === 'json_schema') {
    const unsupported = findUnsupportedSchemaKeyword(document)
    if (unsupported !== null) {
      settled.push(
        settle(
          index,
          reference,
          {
            reference,
            kind,
            applied: false,
            status: 'NOT_TESTED',
            findings: [
              finding(
                'unsupported_schema_keyword',
                `The ${provenance} JSON Schema uses "${unsupported.keyword}", which AttestBook cannot evaluate safely over untrusted input; schema validation was not executed.`,
                'warning',
                `/schemaReferences/${index}`,
              ),
            ],
          },
          source,
        ),
      )
      return
    }
  }

  pending.push({
    index,
    reference,
    kind,
    document,
    integrityFindings,
    source,
  })
}

/**
 * Runs in the sandbox child only. Evaluates one verified document against the
 * credential facts and returns its application.
 */
export function evaluateSchemaDocument(
  pending: PendingSchemaDocument,
  input: SchemaEvaluationInput,
): SchemaApplication {
  const application =
    pending.kind === 'type_metadata'
      ? validateTypeMetadata(pending.reference, pending.index, pending.document, input)
      : validateJsonSchema(pending.reference, pending.index, pending.document, input.claims)

  if (pending.integrityFindings.length === 0) {
    return application
  }
  return {
    ...application,
    findings: [...pending.integrityFindings, ...application.findings],
  }
}
