// Schema and attribute validation against the pinned rulebook (issue #32).
//
// The rulebook version snapshot stores schema references (URI + W3C SRI), not
// schema bodies. AttestBook cannot fetch them yet: the SSRF-safe import path is
// issue #30. This module therefore accepts the exact document bytes from the
// caller, matches them to the selected rulebook references, verifies the
// reference `#integrity` when present, and applies the document:
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

import type { ParsedSdJwtVc } from './sd-jwt'
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

/** Cap on rendered JSON Schema errors from a single document. */
const MAX_SCHEMA_ERRORS = 50

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
  'dependencies',
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
 * A fresh Ajv instance per document: caller-supplied schemas are untrusted and
 * may reuse `$id` values, so compiled state must not leak between requests.
 */
function createAjv(): Ajv2020 {
  return new Ajv2020({
    allErrors: true,
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

export interface ValidateSchemaDocumentsOptions {
  readonly references: readonly SnapshotSchemaReference[]
  readonly documents: readonly SchemaDocumentInput[]
  readonly parsed: ParsedSdJwtVc
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function zodIssuePath(issue: { readonly path: readonly PropertyKey[] }): string {
  return toJsonPointer(issue.path.map((segment) => String(segment)))
}

function validateTypeMetadata(
  reference: SnapshotSchemaReference,
  index: number,
  document: unknown,
  parsed: ParsedSdJwtVc,
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
  if (typeMetadata.vct !== parsed.vct) {
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
    parsed.packedPayload,
    parsed.disclosureMap,
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
  parsed: ParsedSdJwtVc,
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

  if (validate(parsed.claims)) {
    return { reference, kind: 'json_schema', applied: true, status: 'PASS', findings: [] }
  }

  const errors = validate.errors ?? []
  const findings = errors.slice(0, MAX_SCHEMA_ERRORS).map((error: AjvErrorLike) => {
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
  if (errors.length > MAX_SCHEMA_ERRORS) {
    findings.push(
      finding(
        'schema_errors_truncated',
        `The JSON Schema reported ${errors.length} violations; only the first ${MAX_SCHEMA_ERRORS} are returned.`,
        'warning',
        '/claims',
      ),
    )
  }
  return {
    reference,
    kind: 'json_schema',
    applied: true,
    status: 'FAIL',
    findings,
  }
}

/**
 * Applies every supplied document to the selected rulebook references.
 * `references` must already be filtered to the credential format.
 */
export function validateSchemaDocuments(
  options: ValidateSchemaDocumentsOptions,
): SchemaValidationOutcome {
  const applications: SchemaApplication[] = []
  const schemaReferences: SchemaReferenceEvidence[] = []

  options.references.forEach((reference, index) => {
    const documentIndex = options.documents.findIndex((entry) => entry.uri === reference.uri)
    const supplied = documentIndex === -1 ? undefined : options.documents[documentIndex]
    if (supplied === undefined) {
      applications.push({
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
      })
      schemaReferences.push({
        formatIdentifier: reference.formatIdentifier,
        uri: reference.uri,
        integrity: reference.integrity,
        kind: null,
        applied: false,
      })
      return
    }

    let document: unknown
    try {
      document = JSON.parse(supplied.content)
    } catch {
      applications.push({
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
      })
      schemaReferences.push({
        formatIdentifier: reference.formatIdentifier,
        uri: reference.uri,
        integrity: reference.integrity,
        kind: null,
        applied: false,
      })
      return
    }

    const integrity = verifyIntegrity(reference, supplied.content, index)
    if (integrity.status !== 'verified') {
      applications.push({
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
      })
      schemaReferences.push({
        formatIdentifier: reference.formatIdentifier,
        uri: reference.uri,
        integrity: reference.integrity,
        kind: null,
        applied: false,
      })
      return
    }

    const kind: 'type_metadata' | 'json_schema' =
      isRecord(document) && typeof document.vct === 'string' ? 'type_metadata' : 'json_schema'

    if (exceedsDepth(document, MAX_SCHEMA_DEPTH)) {
      applications.push({
        reference,
        kind,
        applied: false,
        status: 'FAIL',
        findings: [
          finding(
            'schema_document_too_deep',
            `The supplied schema document exceeds the ${MAX_SCHEMA_DEPTH}-level nesting bound.`,
            'error',
            `/schemaDocuments/${documentIndex}`,
          ),
        ],
      })
      schemaReferences.push({
        formatIdentifier: reference.formatIdentifier,
        uri: reference.uri,
        integrity: reference.integrity,
        kind,
        applied: false,
      })
      return
    }

    if (kind === 'json_schema') {
      const unsupported = findUnsupportedSchemaKeyword(document)
      if (unsupported !== null) {
        applications.push({
          reference,
          kind,
          applied: false,
          status: 'NOT_TESTED',
          findings: [
            finding(
              'unsupported_schema_keyword',
              `The supplied JSON Schema uses "${unsupported.keyword}", which AttestBook cannot evaluate safely over untrusted input; schema validation was not executed.`,
              'warning',
              `/schemaReferences/${index}`,
            ),
          ],
        })
        schemaReferences.push({
          formatIdentifier: reference.formatIdentifier,
          uri: reference.uri,
          integrity: reference.integrity,
          kind,
          applied: false,
        })
        return
      }
    }

    const application =
      kind === 'type_metadata'
        ? validateTypeMetadata(reference, index, document, options.parsed)
        : validateJsonSchema(reference, index, document, options.parsed)

    const findings = [...integrity.findings, ...application.findings]
    applications.push({
      ...application,
      findings,
    })
    schemaReferences.push({
      formatIdentifier: reference.formatIdentifier,
      uri: reference.uri,
      integrity: reference.integrity,
      kind,
      applied: true,
    })
  })

  const findings = applications.flatMap((application) => application.findings)
  const statuses = applications.map((application) => application.status)
  let status: ValidationStatus
  if (statuses.includes('FAIL')) {
    status = 'FAIL'
  } else if (statuses.includes('INCONCLUSIVE')) {
    status = 'INCONCLUSIVE'
  } else if (statuses.every((entry) => entry === 'NOT_TESTED')) {
    status = 'NOT_TESTED'
  } else if (statuses.includes('NOT_TESTED')) {
    status = 'INCONCLUSIVE'
  } else if (statuses.includes('PASS')) {
    status = 'PASS'
  } else {
    status = 'NOT_APPLICABLE'
  }

  return { status, findings, applications, schemaReferences }
}
