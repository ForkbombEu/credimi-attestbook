// SD-JWT VC structural parsing (issue #32).
//
// Parsing and disclosure handling are delegated to the pinned
// `@sd-jwt/core` 0.24.1 parser. This module adds only the AttestBook structural
// policy that the parser does not apply:
//   * a `vct` claim is required and must be a non-empty string;
//   * protected claims must be issuer-signed, not selectively disclosed;
//   * reserved members must not reappear in unpacked claims;
//   * the disclosure hash algorithm must be one this runtime can execute;
//   * derived-type aliases follow EC erratum #684 (issue #152).
//
// Signatures, issuer trust, status lists and key-binding proofs are NOT
// verified here. The cryptographic and trust dimensions stay NOT_TESTED.

import { createHash } from 'node:crypto'

import {
  createHashMapping,
  decodeJwt,
  decodeSdJwt,
  getClaims,
  type Disclosure,
  type Hasher,
} from '@sd-jwt/core'

import type { ValidationFinding } from './types'

/**
 * SD-JWT VC claims that must be carried in the issuer-signed payload.
 * `aka_vcts` is listed by SD-JWT VC draft-27 clause 2.2.2.3 among the claims
 * that cannot be selectively disclosed, and EC erratum #684 repeats the rule.
 */
const PROTECTED_CLAIMS = [
  'iss',
  'nbf',
  'exp',
  'cnf',
  'vct',
  'vct#integrity',
  'aka_vcts',
  'status',
] as const

const RESERVED_MEMBERS = new Set(['_sd', '_sd_alg', '_sd_decoy', '...'])

/** Base type every domestic PID SD-JWT VC derives from (EC erratum #684). */
export const DOMESTIC_PID_BASE_VCT = 'urn:eudi:pid:1'

/** Prefix shared by the base PID type and its domestic derived types. */
const PID_VCT_PREFIX = 'urn:eudi:pid:'

/** Depth bound for recursive claim inspection. */
const MAX_CLAIM_DEPTH = 64

/** Bound on disclosures unpacked by one credential. */
export const MAX_DISCLOSURES = 1_000

const NODE_HASH_ALGORITHMS: Readonly<Record<string, string>> = {
  'sha-256': 'sha256',
  'sha-384': 'sha384',
  'sha-512': 'sha512',
  'sha3-224': 'sha3-224',
  'sha3-256': 'sha3-256',
  'sha3-384': 'sha3-384',
  'sha3-512': 'sha3-512',
  'blake2s-256': 'blake2s256',
  'blake2b-512': 'blake2b512',
}

/** Parsed structural facts. Raw claims never leave the validation engine. */
export interface ParsedSdJwtVc {
  readonly header: Record<string, unknown>
  /** Issuer-signed payload with `_sd` digests still in place. */
  readonly packedPayload: Record<string, unknown>
  /** Payload with the supplied disclosures unpacked. */
  readonly claims: Record<string, unknown>
  readonly disclosures: readonly Disclosure[]
  /** Disclosures keyed by their decoded digest, for type-metadata checks. */
  readonly disclosureMap: Readonly<Record<string, Disclosure>>
  readonly vct: string
  /**
   * The validated `aka_vcts` aliases, or `undefined` when the claim is absent.
   * The aliases are type identifiers, not personal data.
   */
  readonly akaVcts: readonly string[] | undefined
  readonly disclosureCount: number
  readonly keyBindingPresent: boolean
}

export interface SdJwtParseFailure {
  readonly ok: false
  /** `invalid` means malformed input; `unsupported` means no execution happened. */
  readonly kind: 'invalid' | 'unsupported'
  readonly findings: readonly ValidationFinding[]
}

export interface SdJwtParseSuccess {
  readonly ok: true
  readonly value: ParsedSdJwtVc
}

export type SdJwtParseOutcome = SdJwtParseSuccess | SdJwtParseFailure

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nodeHashName(algorithm: string): string | null {
  return NODE_HASH_ALGORITHMS[algorithm] ?? null
}

/**
 * Hasher used by the SD-JWT parser and by type-metadata verification. The
 * runtime hash implementation is Node/Bun `crypto`, which both support.
 */
export function createSdJwtHasher(): Hasher {
  return (data, algorithm) => {
    const nodeAlgorithm = nodeHashName(algorithm)
    if (nodeAlgorithm === null) {
      throw new Error(`unsupported SD-JWT hash algorithm "${algorithm}"`)
    }
    const bytes = typeof data === 'string' ? data : new Uint8Array(data)
    return createHash(nodeAlgorithm).update(bytes).digest()
  }
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

function hasSelectivelyDisclosableParts(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasSelectivelyDisclosableParts)
  }
  if (!isRecord(value)) {
    return false
  }
  return (
    '_sd' in value || '...' in value || Object.values(value).some(hasSelectivelyDisclosableParts)
  )
}

function containsReservedMember(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsReservedMember)
  }
  if (!isRecord(value)) {
    return false
  }
  return Object.entries(value).some(
    ([key, child]) => RESERVED_MEMBERS.has(key) || containsReservedMember(child),
  )
}

/** True for a PID type the erratum treats as domestic, such as `urn:eudi:pid:de:1`. */
function isDomesticPidVct(vct: string): boolean {
  return vct.startsWith(PID_VCT_PREFIX) && vct !== DOMESTIC_PID_BASE_VCT
}

/**
 * Applies the derived-type structural rule of EC erratum #684: a present
 * `aka_vcts` must be a non-empty array of non-empty strings, must not repeat the
 * credential's own `vct`, and a domestic PID type must declare the base PID type.
 * The rule does not establish that the Issuer is authorised for an alias, so the
 * result is structural evidence only.
 *
 * Each alias array element is reported with a JSON Pointer index path.
 */
function checkDerivedTypeAliases(
  claims: Readonly<Record<string, unknown>>,
  vct: string,
  findings: ValidationFinding[],
): readonly string[] | undefined {
  const missingBaseAlias = (): void => {
    findings.push(
      finding(
        'missing_domestic_pid_base_alias',
        `A domestic PID type must declare the base type "${DOMESTIC_PID_BASE_VCT}" in \`aka_vcts\`.`,
        'error',
        '/aka_vcts',
        `aka_vcts contains "${DOMESTIC_PID_BASE_VCT}"`,
      ),
    )
  }

  const value = claims.aka_vcts
  if (value === undefined) {
    if (isDomesticPidVct(vct)) {
      missingBaseAlias()
    }
    return undefined
  }

  if (!Array.isArray(value) || value.length === 0) {
    findings.push(
      finding(
        'invalid_aka_vcts_shape',
        '`aka_vcts` must be a non-empty array of strings.',
        'error',
        '/aka_vcts',
        'a non-empty array of non-empty strings',
      ),
    )
    return undefined
  }

  const aliases: string[] = []
  let shapeValid = true
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry === '') {
      shapeValid = false
      findings.push(
        finding(
          'invalid_aka_vcts_entry',
          'Every `aka_vcts` entry must be a non-empty string type identifier.',
          'error',
          `/aka_vcts/${String(index)}`,
          'a non-empty string type identifier',
        ),
      )
      continue
    }
    aliases.push(entry)
  }

  // A malformed array is already a failure; do not also infer a missing alias
  // from entries that could not be read.
  if (!shapeValid) {
    return undefined
  }

  const ownVctIndex = aliases.indexOf(vct)
  if (ownVctIndex !== -1) {
    findings.push(
      finding(
        'aka_vcts_contains_vct',
        'The `aka_vcts` array must not contain the credential `vct` value.',
        'error',
        `/aka_vcts/${String(ownVctIndex)}`,
        'a type identifier different from the credential vct',
      ),
    )
  }

  if (isDomesticPidVct(vct) && !aliases.includes(DOMESTIC_PID_BASE_VCT)) {
    missingBaseAlias()
  }

  return aliases
}

const SAFE_ERROR_MESSAGES: readonly (readonly [string, string])[] = [
  [
    'missing SD-JWT separator',
    'The credential is not an SD-JWT compact serialization (the "~" separator is missing).',
  ],
  [
    'Unreferenced disclosure',
    'The credential contains a disclosure that the issuer-signed payload does not reference.',
  ],
  ['Duplicate disclosure digest', 'The credential contains two disclosures with the same digest.'],
  [
    'Duplicate digest found',
    'The credential references the same disclosure digest more than once.',
  ],
  [
    'conflicts with existing payload key',
    'A disclosure collides with a claim already present in the issuer-signed payload.',
  ],
  ['conflicts with another disclosure', 'Two disclosures claim the same member name.'],
  ['Invalid disclosure', 'The credential contains a malformed disclosure.'],
  ['Invalid _sd claim', 'The credential contains an invalid `_sd` digest list.'],
  [
    'Object-property disclosure',
    'A disclosure that carries a member name was used as an array element.',
  ],
  ['Array disclosure', 'An array-element disclosure was used as an object member.'],
  ['Nested _sd_alg', 'The credential nests `_sd_alg`; only a top-level value is allowed.'],
  ['Invalid JWT', 'The credential does not contain a decodable compact JWT.'],
]

/**
 * Maps a parser exception to a safe diagnostic. The pinned parser sometimes
 * embeds the serialized credential in its message; those messages must never be
 * copied into a result or a log.
 */
function describeParseFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  for (const [fragment, safeMessage] of SAFE_ERROR_MESSAGES) {
    if (message.includes(fragment)) {
      return safeMessage
    }
  }
  return 'The credential is not a structurally valid SD-JWT VC.'
}

function finding(
  code: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
  path?: string,
  expected?: string,
): ValidationFinding {
  return {
    code,
    message,
    severity,
    dimension: 'credential_parsing',
    ...(path === undefined ? {} : { path }),
    ...(expected === undefined ? {} : { expected }),
  }
}

function invalid(findings: readonly ValidationFinding[]): SdJwtParseFailure {
  return { ok: false, kind: 'invalid', findings }
}

/**
 * Structurally parses a compact SD-JWT VC presentation or credential. The
 * signature is not verified; `getClaims` only unpacks disclosures after the
 * parser has checked their digests, references and collisions.
 */
export async function parseSdJwtVc(credential: string): Promise<SdJwtParseOutcome> {
  if (!credential.includes('~')) {
    return invalid([
      finding(
        'invalid_sd_jwt_compact',
        'The credential is not an SD-JWT compact serialization (the "~" separator is missing).',
        'error',
        '/credential',
      ),
    ])
  }

  let decodedJwt: { header: Record<string, unknown>; payload: Record<string, unknown> }
  try {
    decodedJwt = decodeJwt<Record<string, unknown>, Record<string, unknown>>(
      credential.split('~')[0] ?? '',
    )
  } catch {
    return invalid([
      finding(
        'invalid_compact_jwt',
        'The credential does not start with a decodable compact JWT.',
        'error',
        '/credential',
      ),
    ])
  }

  const typ = decodedJwt.header.typ
  if (typ === undefined) {
    return invalid([
      finding(
        'missing_typ_header',
        'The issuer-signed JWT has no `typ` header; "dc+sd-jwt" or "vc+sd-jwt" is required.',
        'error',
        '/header/typ',
      ),
    ])
  }
  if (typ !== 'dc+sd-jwt' && typ !== 'vc+sd-jwt') {
    return invalid([
      finding(
        'unexpected_typ_header',
        'The issuer-signed JWT `typ` header must be "dc+sd-jwt" or "vc+sd-jwt".',
        'error',
        '/header/typ',
      ),
    ])
  }

  const packedPayload = decodedJwt.payload
  const vct = packedPayload.vct
  if (typeof vct !== 'string' || vct.trim() === '') {
    return invalid([
      finding(
        'missing_vct',
        'The SD-JWT VC issuer-signed payload has no non-empty `vct` claim.',
        'error',
        '/vct',
      ),
    ])
  }

  const hashAlgorithm = packedPayload._sd_alg ?? 'sha-256'
  if (typeof hashAlgorithm !== 'string') {
    return invalid([
      finding('invalid_sd_alg', '`_sd_alg` must be a string when present.', 'error', '/_sd_alg'),
    ])
  }
  const nodeHashAlgorithm = nodeHashName(hashAlgorithm)
  if (nodeHashAlgorithm === null) {
    return {
      ok: false,
      kind: 'unsupported',
      findings: [
        finding(
          'unsupported_hash_algorithm',
          `The disclosure hash algorithm "${hashAlgorithm}" cannot be executed by this runtime; the credential structure was not verified.`,
          'warning',
          '/_sd_alg',
        ),
      ],
    }
  }
  try {
    createHash(nodeHashAlgorithm)
  } catch {
    return {
      ok: false,
      kind: 'unsupported',
      findings: [
        finding(
          'unsupported_hash_algorithm',
          `The disclosure hash algorithm "${hashAlgorithm}" is not available in this runtime; the credential structure was not verified.`,
          'warning',
          '/_sd_alg',
        ),
      ],
    }
  }

  const hasher = createSdJwtHasher()
  let decoded: Awaited<ReturnType<typeof decodeSdJwt>>
  try {
    decoded = await decodeSdJwt(credential, hasher)
  } catch (error) {
    return invalid([finding('invalid_sd_jwt', describeParseFailure(error), 'error', '/credential')])
  }

  if (decoded.disclosures.length > MAX_DISCLOSURES) {
    return invalid([
      finding(
        'too_many_disclosures',
        `The credential carries more than ${MAX_DISCLOSURES} disclosures; it was not unpacked.`,
        'error',
        '/credential',
      ),
    ])
  }

  if (
    exceedsDepth(decoded.jwt.payload, MAX_CLAIM_DEPTH) ||
    decoded.disclosures.some((disclosure) => exceedsDepth(disclosure.value, MAX_CLAIM_DEPTH))
  ) {
    return invalid([
      finding(
        'claim_depth_exceeded',
        `The credential claims exceed the ${MAX_CLAIM_DEPTH}-level nesting bound.`,
        'error',
        '/credential',
      ),
    ])
  }

  let claims: Record<string, unknown>
  try {
    const unpacked = await getClaims(decoded.jwt.payload, decoded.disclosures, hasher)
    if (!isRecord(unpacked)) {
      return invalid([
        finding(
          'invalid_sd_jwt_payload',
          'The unpacked credential payload is not a JSON object.',
          'error',
          '/credential',
        ),
      ])
    }
    claims = unpacked
  } catch (error) {
    if (error instanceof RangeError) {
      return invalid([
        finding(
          'claim_depth_exceeded',
          `The credential claims exceed the ${MAX_CLAIM_DEPTH}-level nesting bound.`,
          'error',
          '/credential',
        ),
      ])
    }
    return invalid([
      finding('invalid_disclosures', describeParseFailure(error), 'error', '/credential'),
    ])
  }

  if (exceedsDepth(claims, MAX_CLAIM_DEPTH)) {
    return invalid([
      finding(
        'claim_depth_exceeded',
        `The unpacked credential claims exceed the ${MAX_CLAIM_DEPTH}-level nesting bound.`,
        'error',
        '/credential',
      ),
    ])
  }

  let disclosureMap: Record<string, Disclosure>
  try {
    disclosureMap = await createHashMapping(decoded.disclosures, {
      hasher,
      alg: hashAlgorithm,
    })
  } catch (error) {
    return invalid([
      finding('invalid_disclosures', describeParseFailure(error), 'error', '/credential'),
    ])
  }

  const findings: ValidationFinding[] = []
  const akaVcts = checkDerivedTypeAliases(claims, vct, findings)
  for (const name of PROTECTED_CLAIMS) {
    if (name in claims && !(name in decoded.jwt.payload)) {
      findings.push(
        finding(
          'protected_claim_selectively_disclosed',
          `The protected claim "${name}" must be issuer-signed, not selectively disclosed.`,
          'error',
          `/${name}`,
        ),
      )
    }
    if (name in decoded.jwt.payload && hasSelectivelyDisclosableParts(decoded.jwt.payload[name])) {
      findings.push(
        finding(
          'protected_claim_selectively_disclosable',
          `The protected claim "${name}" must not contain selectively disclosable parts.`,
          'error',
          `/${name}`,
        ),
      )
    }
  }
  if (containsReservedMember(claims)) {
    findings.push(
      finding(
        'reserved_member_disclosed',
        'The credential exposes a reserved SD-JWT member in its unpacked claims.',
        'error',
        '/credential',
      ),
    )
  }

  if (findings.length > 0) {
    return invalid(findings)
  }

  return {
    ok: true,
    value: {
      header: decoded.jwt.header,
      packedPayload: decoded.jwt.payload,
      claims,
      disclosures: decoded.disclosures,
      disclosureMap,
      vct,
      akaVcts,
      disclosureCount: decoded.disclosures.length,
      keyBindingPresent: decoded.kbJwt !== undefined,
    },
  }
}
