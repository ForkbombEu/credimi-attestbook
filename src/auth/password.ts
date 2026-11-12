// Argon2id password-hash primitives for the environment-configured
// administrator (issue #88).
//
// The administrator password is never stored: the deployment supplies an
// Argon2id PHC hash through `ADMIN_PASSWORD_HASH`. Bun ships the Argon2id
// implementation, so no extra native dependency is needed. The hash is
// validated before it is used: a weak or foreign encoding is treated as an
// invalid configuration instead of silently weakening login.

import { createHash, timingSafeEqual } from 'node:crypto'

/** Longest accepted username, matching the registry identifier bound. */
export const MAX_ADMIN_USERNAME_LENGTH = 256

/** Longest accepted password; longer input is rejected without hashing it. */
export const MAX_ADMIN_PASSWORD_LENGTH = 1024

/**
 * OWASP's Argon2id floor: at least 19 MiB of memory and two passes. Bun's
 * default (64 MiB, two passes) is above this floor.
 */
export const MIN_ARGON2ID_MEMORY_KIB = 19_456
export const MIN_ARGON2ID_TIME_COST = 2

const ARGON2ID_PATTERN =
  /^\$argon2id\$v=19\$m=([1-9]\d{0,8}),t=([1-9]\d{0,8}),p=([1-9]\d{0,8})\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/

/** Decoded parameters of a supported Argon2id PHC string. */
export interface Argon2idParameters {
  readonly memoryCostKiB: number
  readonly timeCost: number
  readonly parallelism: number
}

/**
 * Parses an Argon2id PHC string and returns its parameters, or `null` when the
 * encoding is not a supported Argon2id hash. The raw hash is never logged or
 * echoed.
 */
export function parseArgon2idHash(hash: string): Argon2idParameters | null {
  const match = ARGON2ID_PATTERN.exec(hash)
  if (match === null) {
    return null
  }
  const memoryCostKiB = Number(match[1])
  const timeCost = Number(match[2])
  const parallelism = Number(match[3])
  if (
    !Number.isSafeInteger(memoryCostKiB) ||
    !Number.isSafeInteger(timeCost) ||
    !Number.isSafeInteger(parallelism)
  ) {
    return null
  }
  return { memoryCostKiB, timeCost, parallelism }
}

/** True when the encoding is Argon2id with at least the minimum work factor. */
export function isStrongArgon2idHash(hash: string): boolean {
  const parameters = parseArgon2idHash(hash)
  return (
    parameters !== null &&
    parameters.memoryCostKiB >= MIN_ARGON2ID_MEMORY_KIB &&
    parameters.timeCost >= MIN_ARGON2ID_TIME_COST &&
    parameters.parallelism >= 1
  )
}

/**
 * Verifies a password against a supported Argon2id hash. A malformed hash or a
 * runtime verification failure is a failed match, never an exception that
 * would leak details or turn into a 500.
 */
export async function verifyArgon2idPassword(password: string, hash: string): Promise<boolean> {
  if (password === '' || password.length > MAX_ADMIN_PASSWORD_LENGTH) {
    return false
  }
  try {
    return await Bun.password.verify(password, hash)
  } catch {
    return false
  }
}

/**
 * Compares two strings in time independent of their content. Hashing first
 * makes the comparison independent of each input's length too, so an unknown
 * username does not answer measurably faster than a wrong password.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest()
  const rightDigest = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(leftDigest, rightDigest)
}
