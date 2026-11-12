// Single-administrator browser login and server-side sessions (issue #88).
//
// The administrator is an existing registry provider bound through
// `ADMIN_PROVIDER_ID`. Login verifies an Argon2id password hash supplied by the
// deployment and creates an opaque session; it never creates a provider, never
// mints or returns a provider bearer token and never stores one in the session.
// Provider bearer authentication keeps its own independent path.
//
// See docs/security.md §2.1 for the model and docs/api.md §3.11 for the HTTP
// contract.

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

import type { Provider } from '../registry/types'

import type { AdminLoginConfig } from './config'
import {
  MAX_ADMIN_PASSWORD_LENGTH,
  MAX_ADMIN_USERNAME_LENGTH,
  constantTimeEquals,
  verifyArgon2idPassword,
} from './password'
import {
  DEFAULT_ADMIN_LOGIN_MAX_CLIENT_FAILURES,
  DEFAULT_ADMIN_LOGIN_MAX_FAILURES,
  LoginRateLimiter,
} from './rate-limit'
import {
  ADMIN_SESSION_TTL_MS,
  MAX_ADMIN_SESSION_ID_LENGTH,
  adminAuthFingerprint,
  generateAdminSessionId,
  hashAdminSessionId,
} from './session'

/** Provider lookup seam so tests do not need a full registry. */
export interface AdminProviderSource {
  getProvider(id: string): Provider | null
}

/**
 * Simultaneous Argon2id password checks allowed for login. Beyond this bound
 * a request answers `429` immediately, so an unauthenticated burst cannot tie
 * up the process' CPU and memory.
 */
export const DEFAULT_ADMIN_LOGIN_MAX_CONCURRENT_VERIFICATIONS = 4

export interface AdminAuthOptions {
  readonly database: Database
  readonly registry: AdminProviderSource
  readonly config: AdminLoginConfig
  /** ISO-8601 clock; injectable for deterministic expiry tests. */
  readonly now?: () => string
  /** Absolute session lifetime; defaults to `ADMIN_SESSION_TTL_MS`. */
  readonly ttlMs?: number
  readonly generateSessionId?: () => string
  readonly verifyPassword?: (password: string, hash: string) => Promise<boolean>
  readonly accountRateLimiter?: LoginRateLimiter
  readonly clientRateLimiter?: LoginRateLimiter
  /** Simultaneous password checks; defaults to the exported constant. */
  readonly maxConcurrentVerifications?: number
}

export interface AdminLoginInput {
  readonly username: string
  readonly password: string
  /** Coarse client key for the address-based bound (the remote address). */
  readonly clientKey: string
  /** Current cookie session, rotated out when login succeeds. */
  readonly currentSessionId?: string
}

export interface AuthenticatedAdminSession {
  readonly provider: Provider
  readonly expiresAt: string
}

export type AdminLoginOutcome =
  | {
      readonly kind: 'authenticated'
      readonly sessionId: string
      readonly provider: Provider
      readonly expiresAt: string
      readonly maxAgeSeconds: number
    }
  | { readonly kind: 'invalid_credentials' }
  | {
      readonly kind: 'rate_limited'
      readonly retryAfterSeconds: number
      readonly scope: 'account' | 'client'
    }
  | { readonly kind: 'unavailable' }

interface AdminSessionRow {
  readonly session_hash: string
  readonly provider_id: string
  readonly auth_fingerprint: string
  readonly created_at: string
  readonly expires_at: string
  readonly revoked_at: string | null
}

/**
 * Resolves the configured administrator to a provider, verifies credentials
 * and manages opaque sessions. Every failure mode is a typed outcome so the
 * HTTP layer can keep unknown users and wrong passwords indistinguishable.
 */
export class AdminAuth {
  private readonly database: Database
  private readonly registry: AdminProviderSource
  private readonly config: AdminLoginConfig
  private readonly now: () => string
  private readonly ttlMs: number
  private readonly generateSessionId: () => string
  private readonly verifyPassword: (password: string, hash: string) => Promise<boolean>
  private readonly accountRateLimiter: LoginRateLimiter
  private readonly clientRateLimiter: LoginRateLimiter
  private readonly maxConcurrentVerifications: number
  private inFlight = 0

  constructor(options: AdminAuthOptions) {
    this.database = options.database
    this.registry = options.registry
    this.config = options.config
    this.now = options.now ?? (() => new Date().toISOString())
    this.ttlMs = options.ttlMs ?? ADMIN_SESSION_TTL_MS
    this.generateSessionId = options.generateSessionId ?? generateAdminSessionId
    this.verifyPassword = options.verifyPassword ?? verifyArgon2idPassword
    this.maxConcurrentVerifications =
      options.maxConcurrentVerifications ?? DEFAULT_ADMIN_LOGIN_MAX_CONCURRENT_VERIFICATIONS
    if (
      !Number.isSafeInteger(this.maxConcurrentVerifications) ||
      this.maxConcurrentVerifications < 1
    ) {
      throw new Error('maxConcurrentVerifications must be a positive integer')
    }
    const nowMs = (): number => Date.parse(this.now())
    this.accountRateLimiter =
      options.accountRateLimiter ??
      new LoginRateLimiter({ maxFailures: DEFAULT_ADMIN_LOGIN_MAX_FAILURES, now: nowMs })
    this.clientRateLimiter =
      options.clientRateLimiter ??
      new LoginRateLimiter({ maxFailures: DEFAULT_ADMIN_LOGIN_MAX_CLIENT_FAILURES, now: nowMs })
  }

  /** Why login is unavailable, or `null` when the configuration is usable. */
  get unavailableReason(): string | null {
    return this.config.status === 'configured' ? null : this.config.reason
  }

  /** True when this instance has a configured administrator to authenticate. */
  get isConfigured(): boolean {
    return this.config.status === 'configured'
  }

  /**
   * Verifies credentials and issues a fresh session. Provider existence is
   * checked on every attempt so a provider removed after deployment makes
   * login unavailable instead of authenticating against a stale id.
   */
  async login(input: AdminLoginInput): Promise<AdminLoginOutcome> {
    if (this.config.status !== 'configured') {
      return { kind: 'unavailable' }
    }
    const provider = this.registry.getProvider(this.config.providerId)
    if (provider === null) {
      return { kind: 'unavailable' }
    }

    if (this.inFlight >= this.maxConcurrentVerifications) {
      // Refuse before doing any work: an unauthenticated burst must not start
      // an unbounded number of memory-hard password checks.
      return { kind: 'rate_limited', retryAfterSeconds: 1, scope: 'client' }
    }

    // Reserve the failure budget before the slow verification. The check and
    // the append are one synchronous step, so overlapping requests cannot all
    // pass the bound before any of them records a failure.
    const accountKey = createHash('sha256')
      .update(input.username.trim().toLowerCase(), 'utf8')
      .digest('hex')
    const accountReservation = this.accountRateLimiter.tryReserve(accountKey)
    if ('retryAfterSeconds' in accountReservation) {
      return {
        kind: 'rate_limited',
        retryAfterSeconds: accountReservation.retryAfterSeconds,
        scope: 'account',
      }
    }
    const clientReservation = this.clientRateLimiter.tryReserve(input.clientKey)
    if ('retryAfterSeconds' in clientReservation) {
      // The request never reached verification, so it must not spend the
      // account's failure budget.
      this.accountRateLimiter.release(accountKey, accountReservation.token)
      return {
        kind: 'rate_limited',
        retryAfterSeconds: clientReservation.retryAfterSeconds,
        scope: 'client',
      }
    }

    this.inFlight += 1
    try {
      const usernameMatches =
        input.username.length <= MAX_ADMIN_USERNAME_LENGTH &&
        constantTimeEquals(input.username.trim(), this.config.username)
      const candidatePassword =
        input.password.length <= MAX_ADMIN_PASSWORD_LENGTH ? input.password : ''
      const passwordMatches = await this.verifyPassword(candidatePassword, this.config.passwordHash)

      if (!usernameMatches || !passwordMatches) {
        // Both reservations already count this as a failure.
        return { kind: 'invalid_credentials' }
      }

      this.accountRateLimiter.reset(accountKey)
      this.clientRateLimiter.reset(input.clientKey)

      // Session fixation defence: never adopt the identifier the browser
      // presented. Retire that session and mint a new unpredictable one.
      if (input.currentSessionId !== undefined) {
        this.logout(input.currentSessionId)
      }

      const createdAt = this.now()
      const nowMs = Date.parse(createdAt)
      const expiresAt = new Date(nowMs + this.ttlMs).toISOString()
      const sessionId = this.generateSessionId()
      const sessionHash = hashAdminSessionId(sessionId)

      // Housekeeping: expired rows are useless and bounded storage is cheap.
      this.database.query('DELETE FROM admin_sessions WHERE expires_at <= ?').run(createdAt)
      this.database
        .query(
          `INSERT INTO admin_sessions
             (session_hash, provider_id, auth_fingerprint, created_at, expires_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(sessionHash, provider.id, this.fingerprint(), createdAt, expiresAt)

      return {
        kind: 'authenticated',
        sessionId,
        provider,
        expiresAt,
        maxAgeSeconds: Math.max(1, Math.floor(this.ttlMs / 1_000)),
      }
    } finally {
      this.inFlight -= 1
    }
  }

  /**
   * Resolves an opaque cookie identifier to its live session, or `null` when it
   * is unknown, revoked, expired or bound to a rotated configuration.
   */
  resolveSession(sessionId: string): AuthenticatedAdminSession | null {
    if (sessionId === '' || sessionId.length > MAX_ADMIN_SESSION_ID_LENGTH) {
      return null
    }
    const row = this.database
      .query<AdminSessionRow, [string]>(
        `SELECT session_hash, provider_id, auth_fingerprint, created_at, expires_at, revoked_at
           FROM admin_sessions WHERE session_hash = ?`,
      )
      .get(hashAdminSessionId(sessionId))
    if (row === null || row.revoked_at !== null) {
      return null
    }
    if (Date.parse(row.expires_at) <= Date.parse(this.now())) {
      return null
    }
    if (row.auth_fingerprint !== this.fingerprint()) {
      return null
    }
    const provider = this.registry.getProvider(row.provider_id)
    if (provider === null) {
      return null
    }
    return { provider, expiresAt: row.expires_at }
  }

  /** Revokes the session if it exists; repeated logout is a no-op. */
  logout(sessionId: string | null): void {
    if (sessionId === null || sessionId === '' || sessionId.length > MAX_ADMIN_SESSION_ID_LENGTH) {
      return
    }
    this.database
      .query(
        'UPDATE admin_sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL',
      )
      .run(this.now(), hashAdminSessionId(sessionId))
  }

  private fingerprint(): string {
    if (this.config.status !== 'configured') {
      // Unreachable: callers check the configuration first. Keep the method
      // total without exposing a partial fingerprint.
      return createHash('sha256').update('unconfigured', 'utf8').digest('hex')
    }
    return adminAuthFingerprint({
      username: this.config.username,
      passwordHash: this.config.passwordHash,
      providerId: this.config.providerId,
    })
  }
}
