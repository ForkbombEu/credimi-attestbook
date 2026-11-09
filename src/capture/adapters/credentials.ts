// Bearer-credential primitives for capture adapters (FR-018, issue #47).
//
// The same provisional model as the registry (decision D-10) applies at the
// capture boundary: an adapter is configured with the SHA-256 hashes of the
// credentials it accepts, never with the raw secrets, and a presented
// credential is compared in constant time. The hash of a presented credential
// is computed before comparison so an unknown credential cannot be
// distinguished from a missing one by timing or by message.

import { timingSafeEqual } from 'node:crypto'

import { SHA256_HEX_PATTERN, sha256Hex } from '../../registry/digest'

/** Maximum accepted length of a presented bearer credential, in characters. */
export const MAX_CAPTURE_CREDENTIAL_LENGTH = 4_096

/** Returns the lowercase hexadecimal SHA-256 of a presented credential. */
export function hashCaptureCredential(secret: string): string {
  return sha256Hex(new TextEncoder().encode(secret))
}

/** True when a configured value is a SHA-256 credential hash. */
export function isCaptureCredentialHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value)
}

/**
 * Constant-time comparison of an already-hashed credential against configured
 * hashes. It fails closed: no configured hash means no credential is accepted.
 */
export function verifyCaptureCredentialHash(
  presentedHash: string | null,
  acceptedHashes: readonly string[],
): boolean {
  if (
    presentedHash === null ||
    !SHA256_HEX_PATTERN.test(presentedHash) ||
    acceptedHashes.length === 0
  ) {
    return false
  }
  const actual = Buffer.from(presentedHash, 'hex')
  let matched = false
  for (const accepted of acceptedHashes) {
    const expected = Buffer.from(accepted, 'hex')
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      matched = true
    }
  }
  return matched
}

/**
 * Constant-time check of a presented bearer credential against configured
 * hashes. The raw credential is hashed before comparison and is never stored.
 */
export function verifyCaptureCredential(
  presented: unknown,
  acceptedHashes: readonly string[],
): boolean {
  if (
    typeof presented !== 'string' ||
    presented === '' ||
    presented.length > MAX_CAPTURE_CREDENTIAL_LENGTH ||
    acceptedHashes.length === 0
  ) {
    return false
  }
  return verifyCaptureCredentialHash(hashCaptureCredential(presented), acceptedHashes)
}
