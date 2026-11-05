// Content digests for immutable rulebook versions (issue #29).
//
// Decision D-6: the digest is SHA-256 over the exact stored artifact bytes, so
// it is reproducible without a canonicalization library. A digest is exposed as
// lowercase hexadecimal text, which is what `artifacts.digest` stores and what
// the schema validates.

import { createHash } from 'node:crypto'

/** Shape of an AttestBook content digest: lowercase hex SHA-256. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

/** Returns the lowercase hexadecimal SHA-256 of the exact bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
