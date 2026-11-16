// Callback URL validation for anonymous webhook subscriptions (issue #117).
//
// A callback URL is untrusted input even though this slice never contacts it.
// Only an absolute `https` URL on a public host is accepted by default; embedded
// credentials, fragments, backslashes, non-printable characters, malformed or
// single-label DNS names, blocked hostnames and non-public IP literals are
// rejected. A literal loopback `http` URL is accepted only when the service is
// explicitly constructed with the test-only opt-in.
//
// No DNS lookup happens here, and registration never performs an outbound
// request. A hostname may resolve differently later; any future delivery worker
// must repeat the address checks and pin the connection.

import { isIP } from 'node:net'

import { isBlockedAddress } from '../import/url'

import { invalidSubscriptionInput } from './errors'

/** Hostnames that must never be a public callback target. */
const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain'])

/** DNS suffixes that are private, local or otherwise not a public target. */
const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa']

/** Literal loopback addresses accepted only by the test-only HTTP opt-in. */
const LOOPBACK_LITERALS = new Set(['127.0.0.1', '::1'])

/** Printable ASCII without space; the URL parser must not see control chars. */
const PRINTABLE_ASCII_PATTERN = /^[\x21-\x7e]+$/

/** One DNS label: letters, digits and interior hyphens. */
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export interface CallbackUrlOptions {
  readonly maxLength: number
  readonly allowLoopbackHttp: boolean
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isLoopbackLiteral(hostname: string): boolean {
  return LOOPBACK_LITERALS.has(stripBrackets(hostname))
}

/** True when the host is a syntactically valid public DNS name. */
function isPublicDnsName(hostname: string): boolean {
  if (hostname.endsWith('.') || hostname.length > 253) {
    return false
  }
  const labels = hostname.split('.')
  if (labels.length < 2) {
    return false
  }
  return labels.every(
    (label) => label !== '' && label.length <= 63 && DNS_LABEL_PATTERN.test(label),
  )
}

function isBlockedDnsName(hostname: string): boolean {
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return true
  }
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
}

/**
 * Validates and normalizes one `callbackUrl`. The returned value is the WHATWG
 * serialization, so the stored URL has a lowercase host, no default port and no
 * fragment, and a registration is compared against what the eventual delivery
 * would request.
 */
export function parseSubscriptionCallbackUrl(value: unknown, options: CallbackUrlOptions): string {
  if (typeof value !== 'string') {
    throw invalidSubscriptionInput('callbackUrl must be a string')
  }
  if (value === '' || value !== value.trim()) {
    throw invalidSubscriptionInput(
      'callbackUrl must be a non-empty URL without surrounding whitespace',
    )
  }
  if (value.length > options.maxLength) {
    throw invalidSubscriptionInput(
      `callbackUrl must be at most ${String(options.maxLength)} characters`,
    )
  }
  // The raw text is checked before parsing so a parser difference cannot hide
  // an ambiguous form: no controls/space, no backslash (a WHATWG path
  // separator) and no fragment marker.
  if (!PRINTABLE_ASCII_PATTERN.test(value)) {
    throw invalidSubscriptionInput('callbackUrl must contain only printable ASCII characters')
  }
  if (value.includes('\\')) {
    throw invalidSubscriptionInput('callbackUrl must not contain a backslash')
  }
  if (value.includes('#')) {
    throw invalidSubscriptionInput('callbackUrl must not have a fragment')
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidSubscriptionInput('callbackUrl must be an absolute URL')
  }

  const loopbackHttp =
    url.protocol === 'http:' && options.allowLoopbackHttp && isLoopbackLiteral(url.hostname)
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw invalidSubscriptionInput('callbackUrl must use https')
  }
  if (url.username !== '' || url.password !== '') {
    throw invalidSubscriptionInput('callbackUrl must not embed credentials')
  }
  if (url.hostname === '') {
    throw invalidSubscriptionInput('callbackUrl must name a host')
  }
  if (url.port === '0') {
    throw invalidSubscriptionInput('callbackUrl must not use port 0')
  }
  if (url.hostname.includes('%')) {
    throw invalidSubscriptionInput('callbackUrl has an invalid host')
  }
  if (isLoopbackLiteral(url.hostname)) {
    if (!loopbackHttp) {
      throw invalidSubscriptionInput('callbackUrl must target a public host')
    }
  } else {
    const hostname = stripBrackets(url.hostname)
    if (isIP(hostname) !== 0) {
      if (isBlockedAddress(hostname)) {
        throw invalidSubscriptionInput('callbackUrl must target a public host')
      }
    } else if (isBlockedDnsName(hostname) || !isPublicDnsName(hostname)) {
      throw invalidSubscriptionInput('callbackUrl must target a public host')
    }
  }

  const normalized = url.href
  if (normalized.length > options.maxLength) {
    throw invalidSubscriptionInput(
      `callbackUrl must be at most ${String(options.maxLength)} characters after normalization`,
    )
  }
  return normalized
}
