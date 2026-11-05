// Strict JOSE wrapper around the OWF signer and verifier.
//
// OWF 0.5.4 `verifySchemaMeta` is permissive: it accepts a mismatched `alg`, a
// `typ` other than `attestation-schema+jwt`, a missing `x5c`, and a payload with
// no `iat`, for which it synthesises the verifier's clock (docs/standards.md
// §5.4). AttestBook must not use those returned values as key, algorithm or
// issuance evidence (decision D-3). This wrapper applies its own policy while
// still delegating the actual signature operation to the real package.

import {
  signSchemaMeta,
  verifySchemaMeta,
  type SignOptions,
  type VerifyOptions,
} from '@owf/eudi-attestation-schema'

import {
  fail,
  invalidInput,
  notTested,
  ok,
  preserved,
  unsupportedOperation,
  type AdapterDiagnostic,
  type AdapterResult,
} from './diagnostics'
import { OWF_PROFILE, type CanonicalSchemaMeta } from './model'
import { buildOwfSchemaMeta, parseOwfSchemaMeta } from './owf'

/** Algorithms the wrapper allows. ES256 is the default and the preferred one. */
export const ALLOWED_JWS_ALGORITHMS = [
  'ES256',
  'ES384',
  'ES512',
  'RS256',
  'RS384',
  'RS512',
] as const

export type JwsAlgorithm = (typeof ALLOWED_JWS_ALGORITHMS)[number]

export const DEFAULT_JWS_ALGORITHM: JwsAlgorithm = 'ES256'

const JOSE_TYPE = 'attestation-schema+jwt'

const PEM_CERTIFICATE_PATTERN =
  /^-----BEGIN CERTIFICATE-----\s*[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*$/

const FORBIDDEN_JOSE_HEADER_MEMBERS = ['crit', 'b64', 'jwk', 'jku', 'x5u'] as const

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export interface JwsHeader {
  readonly alg: string
  readonly typ: string
  readonly kid: string
  readonly x5c: readonly string[]
}

export interface SignSchemaMetaOptions {
  readonly schemaMeta: CanonicalSchemaMeta
  readonly keyId: string
  readonly algorithm?: JwsAlgorithm
  /** PEM-encoded certificate chain; OWF converts each entry to base64 DER. */
  readonly certificates: readonly string[]
  readonly signer: SignOptions['signer']
}

export interface SignedSchemaMetaDocument {
  readonly jws: string
  readonly profile: typeof OWF_PROFILE
  readonly header: JwsHeader
  readonly iat: number
}

export interface VerifySchemaMetaOptions {
  readonly jws: string
  readonly verifier: VerifyOptions['verifier']
  /**
   * The algorithm the caller's verifier/key is expected to use. A header that
   * claims another algorithm is rejected even if OWF would verify it.
   */
  readonly algorithm: JwsAlgorithm
  /** The key id the caller expects; a different `kid` is rejected. */
  readonly keyId: string
}

export interface VerifiedSchemaMetaDocument {
  readonly schemaMeta: CanonicalSchemaMeta
  readonly profile: typeof OWF_PROFILE
  readonly header: JwsHeader
  readonly iat: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function checkAlgorithm(algorithm: string): AdapterDiagnostic | undefined {
  if ((ALLOWED_JWS_ALGORITHMS as readonly string[]).includes(algorithm)) {
    return undefined
  }
  return unsupportedOperation(
    'unsupported_jose_algorithm',
    `allowed JOSE algorithms are ${ALLOWED_JWS_ALGORITHMS.join(', ')}; "${algorithm}" is not supported`,
    'header.alg',
  )
}

export interface CompactJwsParts {
  readonly header: Record<string, unknown>
  readonly payload: Record<string, unknown>
  readonly signingInput: string
  readonly signature: string
}

function decodeJsonPart(part: string): Record<string, unknown> | undefined {
  if (!BASE64URL_PATTERN.test(part)) {
    return undefined
  }
  try {
    const decoded: unknown = JSON.parse(utf8Decoder.decode(Buffer.from(part, 'base64url')))
    return typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Classifies a payload for which OWF already verified the signature but then
 * rejected it as a `SchemaMeta`. Only explicit TS11 discriminators qualify;
 * anything else is invalid input, not a missing capability.
 */
function classifyUnsupportedPayload(
  payload: Record<string, unknown>,
): AdapterDiagnostic | undefined {
  if (Array.isArray(payload.data) && typeof payload.iss === 'string' && 'iat' in payload) {
    return unsupportedOperation(
      'unsupported_ts11_envelope',
      'the TS11 v1.0.1 catalogue list envelope {iss, iat, data} is not supported; OWF verifies only the OWF SchemaMeta compact JWS',
      'payload',
    )
  }
  if (Array.isArray(payload.supportedFormats)) {
    return unsupportedOperation(
      'unsupported_profile',
      'TS11 v1.0.1 SchemaMeta JWS verification is not supported; OWF verifies only its own SchemaMeta profile',
      'payload',
    )
  }
  return undefined
}

function normalizeRawHeader(rawHeader: Record<string, unknown>): {
  alg: string
  typ: string
  kid: string
  x5c: string[]
} {
  return {
    alg: typeof rawHeader.alg === 'string' ? rawHeader.alg : '',
    typ: typeof rawHeader.typ === 'string' ? rawHeader.typ : '',
    kid: typeof rawHeader.kid === 'string' ? rawHeader.kid : '',
    x5c: Array.isArray(rawHeader.x5c) ? (rawHeader.x5c as string[]) : [],
  }
}

/** Decodes a compact JWS without verifying it. Never use the result as evidence. */
export function decodeCompactJws(jws: string): AdapterResult<CompactJwsParts> {
  const parts = jws.split('.')
  if (parts.length !== 3) {
    return fail([
      invalidInput('invalid_jose_header', 'expected a compact JWS with three segments', 'jws'),
    ])
  }
  const [headerPart, payloadPart, signature] = parts
  if (
    headerPart === undefined ||
    payloadPart === undefined ||
    signature === undefined ||
    headerPart === '' ||
    payloadPart === '' ||
    signature === ''
  ) {
    return fail([
      invalidInput(
        'invalid_jose_header',
        'expected a compact JWS with three non-empty segments',
        'jws',
      ),
    ])
  }
  const header = decodeJsonPart(headerPart)
  const payload = decodeJsonPart(payloadPart)
  if (header === undefined || payload === undefined) {
    return fail([
      invalidInput(
        'invalid_jose_header',
        'compact JWS header and payload must be base64url-encoded JSON objects',
        'jws',
      ),
    ])
  }
  return ok({
    header,
    payload,
    signingInput: `${headerPart}.${payloadPart}`,
    signature,
  })
}

function checkHeader(
  header: { alg: string; typ: string; kid: string; x5c: string[] },
  expected: { algorithm: JwsAlgorithm; keyId: string },
): AdapterDiagnostic[] {
  const diagnostics: AdapterDiagnostic[] = []

  if (header.typ !== JOSE_TYPE) {
    diagnostics.push(
      invalidInput(
        'invalid_jose_header',
        `expected "typ" to be "${JOSE_TYPE}", received "${header.typ}"`,
        'header.typ',
      ),
    )
  }
  if (header.alg !== expected.algorithm) {
    const unsupported = checkAlgorithm(header.alg)
    diagnostics.push(
      unsupported ??
        invalidInput(
          'invalid_jose_header',
          `header algorithm "${header.alg}" is not the expected "${expected.algorithm}"`,
          'header.alg',
        ),
    )
  }
  if (header.kid !== expected.keyId) {
    diagnostics.push(
      invalidInput(
        'invalid_jose_header',
        `header key id "${header.kid}" is not the expected "${expected.keyId}"`,
        'header.kid',
      ),
    )
  }
  if (!Array.isArray(header.x5c) || header.x5c.length === 0) {
    diagnostics.push(
      invalidInput(
        'invalid_jose_header',
        'a non-empty "x5c" certificate chain is required',
        'header.x5c',
      ),
    )
  } else if (
    header.x5c.some((certificate) => typeof certificate !== 'string' || certificate.trim() === '')
  ) {
    diagnostics.push(
      invalidInput(
        'invalid_jose_header',
        'every "x5c" entry must be a non-empty base64 DER certificate',
        'header.x5c',
      ),
    )
  }

  return diagnostics
}

function checkForbiddenHeaderMembers(header: Record<string, unknown>): AdapterDiagnostic[] {
  const diagnostics: AdapterDiagnostic[] = []
  for (const member of FORBIDDEN_JOSE_HEADER_MEMBERS) {
    if (member in header) {
      diagnostics.push(
        invalidInput(
          'invalid_jose_header',
          `the "${member}" JOSE header member is not accepted by the AttestBook policy`,
          `header.${member}`,
        ),
      )
    }
  }
  return diagnostics
}

/**
 * Signs a canonical SchemaMeta document through OWF `signSchemaMeta`, after
 * serializing it to the OWF profile and enforcing the strict JOSE policy.
 *
 * TS11 catalogue-envelope signing is not supported: OWF signs a bare OWF
 * `SchemaMeta` and has no `{ iss, iat, data }` list envelope.
 */
export async function signSchemaMetaJws(
  options: SignSchemaMetaOptions,
): Promise<AdapterResult<SignedSchemaMetaDocument>> {
  const diagnostics: AdapterDiagnostic[] = []
  const algorithm = options.algorithm ?? DEFAULT_JWS_ALGORITHM

  const unsupported = checkAlgorithm(algorithm)
  if (unsupported !== undefined) {
    return fail([unsupported])
  }
  if (options.keyId.trim() === '') {
    return fail([
      invalidInput('missing_required_member', 'a non-empty key id is required', 'keyId'),
    ])
  }
  if (options.certificates.length === 0) {
    return fail([
      invalidInput(
        'missing_required_member',
        'at least one signing certificate is required; OWF emits an empty x5c otherwise',
        'certificates',
      ),
    ])
  }
  if (options.certificates.some((certificate) => !PEM_CERTIFICATE_PATTERN.test(certificate))) {
    return fail([
      invalidInput(
        'invalid_signing_certificate',
        'every signing certificate must be a PEM-encoded certificate',
        'certificates',
      ),
    ])
  }

  const built = buildOwfSchemaMeta(options.schemaMeta)
  if (!built.ok) {
    return built
  }
  diagnostics.push(...built.diagnostics)

  let signed: Awaited<ReturnType<typeof signSchemaMeta>>
  try {
    signed = await signSchemaMeta({
      schemaMeta: built.value,
      keyId: options.keyId,
      algorithm,
      certificates: [...options.certificates],
      signer: options.signer,
    })
  } catch (error) {
    return fail([
      ...diagnostics,
      invalidInput('signing_failed', errorMessage(error), 'certificates'),
    ])
  }

  const headerDiagnostics = checkHeader(signed.header, {
    algorithm,
    keyId: options.keyId,
  })
  if (headerDiagnostics.length > 0) {
    return fail([...diagnostics, ...headerDiagnostics])
  }

  const decoded = decodeCompactJws(signed.jws)
  if (!decoded.ok) {
    return fail([...diagnostics, ...decoded.diagnostics])
  }
  const forbiddenHeaderMembers = checkForbiddenHeaderMembers(decoded.value.header)
  if (forbiddenHeaderMembers.length > 0) {
    return fail([...diagnostics, ...forbiddenHeaderMembers])
  }
  const payloadIat = decoded.value.payload.iat
  if (typeof payloadIat !== 'number' || !Number.isInteger(payloadIat) || payloadIat <= 0) {
    return fail([
      ...diagnostics,
      invalidInput(
        'synthetic_iat',
        'the signed payload must carry a positive integer iat',
        'payload.iat',
      ),
    ])
  }

  if (options.schemaMeta.iat !== undefined && options.schemaMeta.iat !== signed.iat) {
    diagnostics.push(
      preserved(
        'signing_time_stamped',
        `OWF signSchemaMeta stamped iat ${signed.iat}; the canonical iat ${options.schemaMeta.iat} was replaced`,
        'iat',
      ),
    )
  }

  return ok(
    {
      jws: signed.jws,
      profile: OWF_PROFILE,
      header: {
        alg: signed.header.alg,
        typ: signed.header.typ,
        kid: signed.header.kid,
        x5c: signed.header.x5c,
      },
      iat: signed.iat,
    },
    diagnostics,
  )
}

/**
 * Verifies a compact JWS through OWF `verifySchemaMeta` and then applies the
 * strict JOSE policy. The returned `iat` is always taken from the signed
 * payload: a synthetic value supplied by OWF is rejected.
 *
 * The signature is checked; the x5c certificate chain, its trust anchor and the
 * `trustedAuthorities` references are not. That dimension is reported as
 * `not_tested`, never as PASS.
 */
export async function verifySchemaMetaJws(
  options: VerifySchemaMetaOptions,
): Promise<AdapterResult<VerifiedSchemaMetaDocument>> {
  const diagnostics: AdapterDiagnostic[] = []

  const unsupported = checkAlgorithm(options.algorithm)
  if (unsupported !== undefined) {
    return fail([unsupported])
  }
  if (options.keyId.trim() === '') {
    return fail([
      invalidInput('missing_required_member', 'a non-empty expected key id is required', 'keyId'),
    ])
  }

  const decoded = decodeCompactJws(options.jws)
  if (!decoded.ok) {
    return fail(decoded.diagnostics)
  }

  let verified: Awaited<ReturnType<typeof verifySchemaMeta>>
  try {
    verified = await verifySchemaMeta({ jws: options.jws, verifier: options.verifier })
  } catch (error) {
    const message = errorMessage(error)
    if (message === 'Invalid signature') {
      return fail([...diagnostics, invalidInput('invalid_signature', message, 'jws')])
    }
    if (message.startsWith('Invalid SchemaMeta payload')) {
      // OWF verifies the signature before it parses the payload, so this branch
      // is reached only for a valid signature. Apply the header policy first,
      // then decide whether the payload is unsupported or simply invalid.
      const rawHeaderDiagnostics = [
        ...checkForbiddenHeaderMembers(decoded.value.header),
        ...checkHeader(normalizeRawHeader(decoded.value.header), {
          algorithm: options.algorithm,
          keyId: options.keyId,
        }),
      ]
      if (rawHeaderDiagnostics.length > 0) {
        return fail([...diagnostics, ...rawHeaderDiagnostics])
      }
      const unsupportedPayload = classifyUnsupportedPayload(decoded.value.payload)
      if (unsupportedPayload !== undefined) {
        return fail([...diagnostics, unsupportedPayload])
      }
      return fail([...diagnostics, invalidInput('invalid_schema_meta', message, 'payload')])
    }
    return fail([...diagnostics, invalidInput('invalid_signature', message, 'jws')])
  }

  const headerDiagnostics = [
    ...checkForbiddenHeaderMembers(decoded.value.header),
    ...checkHeader(verified.header, {
      algorithm: options.algorithm,
      keyId: options.keyId,
    }),
  ]
  if (headerDiagnostics.length > 0) {
    return fail([...diagnostics, ...headerDiagnostics])
  }

  const payloadIat = decoded.value.payload.iat
  if (
    typeof payloadIat !== 'number' ||
    !Number.isInteger(payloadIat) ||
    payloadIat <= 0 ||
    verified.iat !== payloadIat
  ) {
    return fail([
      ...diagnostics,
      invalidInput(
        'synthetic_iat',
        'the JWS payload has no positive integer iat; OWF synthesises one from the verifier clock, which is not issuance evidence',
        'payload.iat',
      ),
    ])
  }

  // Validate the raw payload with the real OWF package and translate it while
  // preserving top-level members that `SchemaMetaSchema.parse` would strip.
  const parsed = parseOwfSchemaMeta(decoded.value.payload)
  if (!parsed.ok) {
    return fail([...diagnostics, ...parsed.diagnostics])
  }
  diagnostics.push(...parsed.diagnostics)
  diagnostics.push(
    notTested(
      'trust_not_tested',
      'the JWS signature was verified, but the x5c certificate chain, its trust anchor and trustedAuthorities were not validated',
      'header.x5c',
    ),
  )

  return ok(
    {
      schemaMeta: parsed.value,
      profile: OWF_PROFILE,
      header: {
        alg: verified.header.alg,
        typ: verified.header.typ,
        kid: verified.header.kid,
        x5c: verified.header.x5c,
      },
      iat: payloadIat,
    },
    diagnostics,
  )
}
