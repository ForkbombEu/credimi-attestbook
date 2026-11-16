// Callback verification primitives for anonymous webhook subscriptions
// (issue #118, FR-003/FR-008, specification §15).
//
// Verification proves that the subscriber controls the registered callback
// endpoint before the subscription can become delivery eligible. A fresh
// 256-bit challenge is minted per initiation, stored only as its SHA-256 hash,
// sent to the endpoint over a bounded HTTP handshake and accepted only when the
// endpoint answers with the exact challenge. The plaintext challenge exists
// only in the outbound request and is never returned by the API or logged.
//
// The callback is untrusted. A target is re-validated and resolved at
// verification time; every resolved answer must be public (or the literal
// loopback address explicitly allowed by the local test opt-in), and the
// transport connects to that pinned address so a second DNS answer cannot
// redirect the connection (DNS rebinding). Redirects are never followed.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { isBlockedAddress } from '../import/url'
import {
  createHttp1Transport,
  type Http1Response,
  type Http1Transport,
  type CreateHttp1TransportOptions,
} from '../net/http1'

import {
  isSubscriptionError,
  subscriptionCallbackUnreachable,
  subscriptionVerificationFailed,
} from './errors'
import { parseSubscriptionCallbackUrl } from './url'

/** Handshake type carried in the verification request body. */
export const SUBSCRIPTION_VERIFICATION_TYPE = 'attestbook.subscription.verification@1'

/** Prefix of every verification challenge (`attestbook verification`). */
export const SUBSCRIPTION_CHALLENGE_PREFIX = 'atv_'

/** 256 random bits encoded with base64url plus the prefix. */
export const SUBSCRIPTION_CHALLENGE_LENGTH = 47

/** Hard bound on a challenge value before it is hashed. */
export const MAX_SUBSCRIPTION_CHALLENGE_LENGTH = 128

const CHALLENGE_HASH_PATTERN = /^[0-9a-f]{64}$/

const LOOPBACK_LITERALS = new Set(['127.0.0.1', '::1'])

/** Mints a fresh opaque verification challenge. */
export function generateSubscriptionChallenge(): string {
  return `${SUBSCRIPTION_CHALLENGE_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** SHA-256 of a challenge, as stored. */
export function hashSubscriptionChallenge(challenge: string): string {
  return createHash('sha256').update(challenge, 'utf8').digest('hex')
}

/** True when the value has the shape of a stored challenge hash. */
export function isSubscriptionChallengeHash(value: string): boolean {
  return CHALLENGE_HASH_PATTERN.test(value)
}

/**
 * Constant-time comparison of an answered challenge with the one we sent. The
 * comparison hashes both sides first so the input length does not affect the
 * work performed, and it rejects an oversized answer before hashing it.
 */
export function subscriptionChallengeMatches(presented: string, expected: string): boolean {
  if (presented === '' || presented.length > MAX_SUBSCRIPTION_CHALLENGE_LENGTH) {
    return false
  }
  const presentedHash = Buffer.from(hashSubscriptionChallenge(presented), 'hex')
  const expectedHash = Buffer.from(hashSubscriptionChallenge(expected), 'hex')
  return (
    presentedHash.length === expectedHash.length && timingSafeEqual(presentedHash, expectedHash)
  )
}

/** One resolved address of a callback hostname. */
export interface CallbackHostAddress {
  readonly address: string
  readonly family: 4 | 6
}

/** Injectable DNS resolver; the default uses the operating system resolver. */
export type CallbackHostResolver = (hostname: string) => Promise<readonly CallbackHostAddress[]>

/** Resolver used in production; tests inject a deterministic resolver. */
export const systemCallbackHostResolver: CallbackHostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  const addresses: CallbackHostAddress[] = []
  for (const record of records) {
    if (record.family !== 4 && record.family !== 6) {
      throw new Error('the callback hostname resolved to an unsupported address family')
    }
    addresses.push({ address: record.address, family: record.family })
  }
  return addresses
}

/** A callback URL validated and pinned to one public address. */
export interface ResolvedCallbackTarget {
  readonly url: URL
  readonly hostname: string
  readonly address: string
  readonly family: 4 | 6
  readonly port: number
}

export interface ResolveCallbackTargetOptions {
  readonly maxCallbackUrlLength: number
  readonly allowLoopbackHttp: boolean
  /** Bound on the DNS lookup; the service's total deadline may be tighter. */
  readonly timeoutMs: number
  readonly resolver?: CallbackHostResolver
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isLoopbackLiteral(hostname: string): boolean {
  return LOOPBACK_LITERALS.has(hostname)
}

function resolveWithTimeout(
  resolver: CallbackHostResolver,
  hostname: string,
  timeoutMs: number,
): Promise<readonly CallbackHostAddress[]> {
  return new Promise<readonly CallbackHostAddress[]>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(
      () => {
        if (!settled) {
          settled = true
          reject(
            subscriptionCallbackUnreachable('timeout', 'The callback hostname lookup timed out.'),
          )
        }
      },
      Math.max(1, timeoutMs),
    )
    Promise.resolve()
      .then(() => resolver(hostname))
      .then(
        (addresses) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve(addresses)
          }
        },
        (error: unknown) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(
              error instanceof Error ? error : new Error('the callback hostname lookup failed'),
            )
          }
        },
      )
  })
}

function blockedTargetError(): Error {
  return subscriptionVerificationFailed(
    'blocked_target',
    'The callback target is not a public address, so it was not contacted.',
  )
}

/**
 * Re-validates the stored callback URL and resolves it to exactly one public
 * address at verification time. Registration performed only static checks;
 * this is the DNS and address-safety check that must protect the outbound
 * connection. A hostname with any non-public answer is refused, and the
 * caller connects to the returned address rather than resolving again.
 *
 * The test-only loopback opt-in permits a literal `127.0.0.1`/`::1` HTTP
 * target as configured by the local UAT start script. It never permits a DNS
 * name to resolve to loopback: supplied headers are not consulted.
 */
export async function resolveSubscriptionCallbackTarget(
  callbackUrl: string,
  options: ResolveCallbackTargetOptions,
): Promise<ResolvedCallbackTarget> {
  let normalized: string
  try {
    normalized = parseSubscriptionCallbackUrl(callbackUrl, {
      maxLength: options.maxCallbackUrlLength,
      allowLoopbackHttp: options.allowLoopbackHttp,
    })
  } catch (error) {
    if (isSubscriptionError(error)) {
      throw blockedTargetError()
    }
    throw error
  }

  const url = new URL(normalized)
  const hostname = stripBrackets(url.hostname)
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  const literal = isIP(hostname)

  if (literal !== 0) {
    const testLoopback =
      options.allowLoopbackHttp && url.protocol === 'http:' && isLoopbackLiteral(hostname)
    if (isBlockedAddress(hostname) && !testLoopback) {
      throw blockedTargetError()
    }
    return { url, hostname, address: hostname, family: literal === 4 ? 4 : 6, port }
  }

  const resolver = options.resolver ?? systemCallbackHostResolver
  let addresses: readonly CallbackHostAddress[]
  try {
    addresses = await resolveWithTimeout(resolver, hostname, options.timeoutMs)
  } catch (error) {
    if (isSubscriptionError(error)) {
      throw error
    }
    throw subscriptionCallbackUnreachable(
      'dns_failure',
      'The callback hostname could not be resolved to a public address.',
    )
  }

  if (addresses.length === 0) {
    throw subscriptionCallbackUnreachable(
      'dns_failure',
      'The callback hostname resolved to no address, so it was not contacted.',
    )
  }
  for (const record of addresses) {
    if (record.family !== 4 && record.family !== 6) {
      throw subscriptionCallbackUnreachable(
        'dns_failure',
        'The callback hostname resolved to an unsupported address family.',
      )
    }
    if (isBlockedAddress(record.address)) {
      throw blockedTargetError()
    }
  }

  // Prefer a validated IPv4 answer when one exists; a host without an IPv6
  // route would otherwise fail even though a public IPv4 path is available.
  const chosen = addresses.find((record) => record.family === 4) ?? addresses[0]
  if (chosen === undefined) {
    throw subscriptionCallbackUnreachable(
      'dns_failure',
      'The callback hostname resolved to no address, so it was not contacted.',
    )
  }
  return { url, hostname, address: chosen.address, family: chosen.family, port }
}

/** Production transport for the callback handshake. */
export function createSubscriptionVerificationTransport(
  options: CreateHttp1TransportOptions = {},
): Http1Transport {
  return createHttp1Transport(options)
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') {
    return false
  }
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? ''
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

export interface VerificationAcknowledgementOptions {
  readonly maxResponseBytes: number
}

/**
 * Enforces the response half of the handshake. The endpoint must answer
 * `200` with a JSON object whose `challenge` member is the exact challenge we
 * sent. A redirect, another status, a non-JSON body, an oversized body, a
 * malformed body or a different challenge keeps the subscription pending.
 * Every failure message is safe to return: none contains the challenge.
 */
export function validateSubscriptionVerificationResponse(
  response: Http1Response,
  expectedChallenge: string,
  options: VerificationAcknowledgementOptions,
): void {
  if (response.body.byteLength > options.maxResponseBytes) {
    throw subscriptionVerificationFailed(
      'response_too_large',
      'The callback response exceeded the verification response limit.',
    )
  }
  if (response.status >= 300 && response.status < 400) {
    throw subscriptionVerificationFailed(
      'redirect_not_followed',
      'The callback answered with a redirect, which is never followed.',
    )
  }
  if (response.status !== 200) {
    throw subscriptionVerificationFailed(
      'unexpected_status',
      'The callback did not answer the verification challenge with HTTP 200.',
    )
  }
  if (!isJsonContentType(response.headers['content-type'])) {
    throw subscriptionVerificationFailed(
      'invalid_response',
      'The callback verification response is not JSON.',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(response.body).toString('utf8'))
  } catch {
    throw subscriptionVerificationFailed(
      'invalid_response',
      'The callback verification response is not valid JSON.',
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw subscriptionVerificationFailed(
      'invalid_response',
      'The callback verification response is not a JSON object.',
    )
  }
  const answered = (parsed as Record<string, unknown>)['challenge']
  if (typeof answered !== 'string') {
    throw subscriptionVerificationFailed(
      'invalid_response',
      'The callback verification response does not carry a challenge.',
    )
  }
  if (!subscriptionChallengeMatches(answered, expectedChallenge)) {
    throw subscriptionVerificationFailed(
      'challenge_mismatch',
      'The callback did not return the exact verification challenge.',
    )
  }
}
