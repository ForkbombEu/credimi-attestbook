// Bearer-token primitives for the provisional registry authentication model
// (decision D-10). Tokens are high-entropy random values; only a SHA-256 hash
// is ever persisted, so a database read cannot recover a usable credential.

import { createHash, randomBytes } from 'node:crypto'

const BEARER_TOKEN_PREFIX = 'att_'
const BEARER_TOKEN_BYTES = 32

/** Length of the hex-encoded SHA-256 token hash stored in the database. */
export const AUTH_TOKEN_HASH_LENGTH = 64

/** SHA-256 of a bearer token; the raw token is never stored. */
export function hashBearerToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/** Generates a new `att_`-prefixed bearer token with 256 bits of entropy. */
export function generateBearerToken(): string {
  return `${BEARER_TOKEN_PREFIX}${randomBytes(BEARER_TOKEN_BYTES).toString('base64url')}`
}
