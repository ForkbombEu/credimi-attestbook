// SD-JWT VC structural parsing (issue #32).
//
// Parsing and disclosure handling are delegated to the pinned
// `@sd-jwt/core` 0.24.1 parser. This module adds only the AttestBook structural
// policy that the parser does not apply:
//   * a `vct` claim is required and must be a non-empty string;
//   * protected claims must be issuer-signed, not selectively disclosed;
//   * reserved members must not reappear in unpacked claims;
//   * the disclosure hash algorithm must be one this runtime can execute.
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

/** SD-JWT VC claims that must be carried in the issuer-signed payload. */
const PROTECTED_CLAIMS = ['iss', 'nbf', 'exp', 'cnf', 'vct', 'vct#integrity', 'status'] as const

const RESERVED_MEMBERS = new Set(['_sd', '_sd_alg', '_sd_decoy', '...'])

/** Depth bound for recursive claim inspection. */
const MAX_CLAIM_DEPTH = 64

/** Bound on disclosures unpacked by one credential. */
const MAX_DISCLOSURES = 1_000

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
): ValidationFinding {
  return {
    code,
    message,
    severity,
    dimension: 'credential_parsing',
    ...(path === undefined ? {} : { path }),
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
      disclosureCount: decoded.disclosures.length,
      keyBindingPresent: decoded.kbJwt !== undefined,
    },
  }
}
