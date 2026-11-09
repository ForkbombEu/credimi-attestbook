// Secure external artifact references (FR-015, issue #46).
//
// AttestBook prefers a reference to an externally stored artifact over an
// inline copy, so credential bytes are not embedded in every event. A
// reference is still untrusted input: it must be an absolute default-port
// `https` URL without embedded credentials, a fragment or an ambiguous
// hostname, and an IP-literal host must not be a loopback, private, link-local,
// multicast, reserved or cloud-metadata address. DNS resolution and
// connection-time SSRF pinning are deliberately not performed here because
// this slice never fetches the reference; any future fetcher must reuse the
// import pipeline's resolved-address checks.

import { isIP } from 'node:net'

import { isBlockedAddress } from '../import/url'

import { captureError } from './errors'
import type { CaptureLimits } from './limits'
import type { CaptureArtifactReference } from './types'

/** A bounded, parameter-free lowercase media type. */
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain'])

/** Validates and normalizes an untrusted media type. */
export function requireMediaType(value: unknown, field: string): string {
  if (typeof value !== 'string' || !MEDIA_TYPE_PATTERN.test(value)) {
    throw captureError(
      'invalid_capture',
      `${field} must be a bounded, parameter-free lowercase media type`,
      field,
    )
  }
  return value
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isBlockedHostname(hostname: string): boolean {
  if (hostname.endsWith('.')) {
    return true
  }
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return true
  }
  if (
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return true
  }
  const literal = stripBrackets(hostname)
  if (isIP(literal) !== 0) {
    return isBlockedAddress(literal)
  }
  // A single-label DNS name is never a public artifact host; on some clouds it
  // resolves to an internal metadata service.
  return !hostname.includes('.')
}

/**
 * Validates one untrusted `artifactRef`. The exact URI text is preserved so
 * provenance is not silently rewritten; the structural checks below reject
 * unsafe forms instead of normalizing them.
 */
export function parseCaptureArtifactReference(
  value: unknown,
  limits: CaptureLimits,
  field: string,
): CaptureArtifactReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw captureError('invalid_capture', `${field} must be an object`, field)
  }
  const record = value as Record<string, unknown>
  const members = new Set(Object.keys(record))
  for (const member of members) {
    if (member !== 'uri' && member !== 'mediaType' && member !== 'byteLength') {
      throw captureError('invalid_capture', `${field} contains an unsupported member`, field)
    }
  }

  const uri = record.uri
  if (typeof uri !== 'string') {
    throw captureError('invalid_reference', `${field}.uri must be a string`, `${field}.uri`)
  }
  if (uri === '' || uri !== uri.trim()) {
    throw captureError(
      'invalid_reference',
      `${field}.uri must be a non-empty URL without surrounding whitespace`,
      `${field}.uri`,
    )
  }
  if (uri.length > limits.maxArtifactRefLength) {
    throw captureError(
      'invalid_reference',
      `${field}.uri must be at most ${limits.maxArtifactRefLength} characters`,
      `${field}.uri`,
    )
  }

  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw captureError('invalid_reference', `${field}.uri must be an absolute URL`, `${field}.uri`)
  }
  if (url.protocol !== 'https:') {
    throw captureError('invalid_reference', `${field}.uri must use https`, `${field}.uri`)
  }
  if (url.username !== '' || url.password !== '') {
    throw captureError(
      'invalid_reference',
      `${field}.uri must not embed credentials`,
      `${field}.uri`,
    )
  }
  if (url.port !== '' && url.port !== '443') {
    throw captureError(
      'invalid_reference',
      `${field}.uri must use the default https port`,
      `${field}.uri`,
    )
  }
  // `url.hash` is empty for a trailing `#`, so check the submitted text too.
  if (uri.includes('#')) {
    throw captureError('invalid_reference', `${field}.uri must not have a fragment`, `${field}.uri`)
  }
  if (url.hostname === '') {
    throw captureError('invalid_reference', `${field}.uri must name a host`, `${field}.uri`)
  }
  if (url.hostname.includes('%')) {
    throw captureError('invalid_reference', `${field}.uri has an invalid host`, `${field}.uri`)
  }
  if (isBlockedHostname(url.hostname)) {
    throw captureError(
      'blocked_reference',
      `${field}.uri targets a blocked address or hostname`,
      `${field}.uri`,
    )
  }

  const mediaType = requireMediaType(record.mediaType, `${field}.mediaType`)
  const byteLength = record.byteLength
  if (
    byteLength !== undefined &&
    (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0)
  ) {
    throw captureError(
      'invalid_capture',
      `${field}.byteLength must be a non-negative safe integer`,
      `${field}.byteLength`,
    )
  }

  return {
    uri,
    mediaType,
    byteLength: byteLength === undefined ? null : byteLength,
  }
}
