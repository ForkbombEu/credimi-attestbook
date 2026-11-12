// Environment configuration for the single administrator browser login
// (issue #88).
//
// The three variables form one all-or-nothing unit. An absent group leaves the
// browser login unavailable while the public API and provider bearer
// authentication keep working; a partial or invalid group is also reported as
// invalid instead of crashing the server. Reasons never include the hash or the
// password, so a startup warning cannot leak credential material.

import { MAX_ID_LENGTH } from '../registry/validation'

import { MAX_ADMIN_USERNAME_LENGTH, isStrongArgon2idHash, parseArgon2idHash } from './password'

export const ADMIN_USERNAME_ENV = 'ADMIN_USERNAME'
export const ADMIN_PASSWORD_HASH_ENV = 'ADMIN_PASSWORD_HASH'
export const ADMIN_PROVIDER_ID_ENV = 'ADMIN_PROVIDER_ID'

export interface ConfiguredAdminLogin {
  readonly status: 'configured'
  readonly username: string
  readonly passwordHash: string
  readonly providerId: string
}

export interface DisabledAdminLogin {
  readonly status: 'disabled'
  readonly reason: string
}

export interface InvalidAdminLogin {
  readonly status: 'invalid'
  readonly reason: string
}

/** The login configuration state; only `configured` can authenticate. */
export type AdminLoginConfig = ConfiguredAdminLogin | DisabledAdminLogin | InvalidAdminLogin

const CONFIGURED_TOGETHER =
  'ADMIN_USERNAME, ADMIN_PASSWORD_HASH and ADMIN_PROVIDER_ID must be configured together'

/**
 * Reads and validates the administrator login configuration. The caller never
 * receives an error object carrying the raw hash: invalid reasons name variables
 * and constraints only.
 */
export function loadAdminLoginConfig(
  env: Record<string, string | undefined> = Bun.env,
): AdminLoginConfig {
  const username = env[ADMIN_USERNAME_ENV]?.trim() ?? ''
  const passwordHash = env[ADMIN_PASSWORD_HASH_ENV]?.trim() ?? ''
  const providerId = env[ADMIN_PROVIDER_ID_ENV]?.trim() ?? ''

  if (username === '' && passwordHash === '' && providerId === '') {
    return { status: 'disabled', reason: 'administrator login is not configured' }
  }

  if (username === '' || passwordHash === '' || providerId === '') {
    return { status: 'invalid', reason: CONFIGURED_TOGETHER }
  }

  if (username.length > MAX_ADMIN_USERNAME_LENGTH) {
    return {
      status: 'invalid',
      reason: `${ADMIN_USERNAME_ENV} is longer than ${String(MAX_ADMIN_USERNAME_LENGTH)} characters`,
    }
  }

  if (providerId.length > MAX_ID_LENGTH) {
    return {
      status: 'invalid',
      reason: `${ADMIN_PROVIDER_ID_ENV} is longer than ${String(MAX_ID_LENGTH)} characters`,
    }
  }

  if (parseArgon2idHash(passwordHash) === null) {
    return {
      status: 'invalid',
      reason: `${ADMIN_PASSWORD_HASH_ENV} is not an Argon2id PHC hash`,
    }
  }

  if (!isStrongArgon2idHash(passwordHash)) {
    return {
      status: 'invalid',
      reason: `${ADMIN_PASSWORD_HASH_ENV} must be Argon2id with at least 19456 KiB of memory and two passes`,
    }
  }

  return { status: 'configured', username, passwordHash, providerId }
}
