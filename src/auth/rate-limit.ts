// In-memory login failure limiter (issue #88).
//
// A single-process server can bound password guessing without an external
// store. The administrator account is limited tightly and the client address
// more loosely, so one source cannot spend the whole account budget and a
// distributed source still hits the client bound. The limiter records failures
// only; a successful login clears both keys. This is deliberately not a
// general API rate limiter (bearer-token traffic is unchanged).

/** Failures allowed per administrator account within the window. */
export const DEFAULT_ADMIN_LOGIN_MAX_FAILURES = 5

/** Failures allowed per client address within the window. */
export const DEFAULT_ADMIN_LOGIN_MAX_CLIENT_FAILURES = 20

/** Sliding window for both bounds. */
export const DEFAULT_ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000

/** Maximum tracked keys before the oldest entry is evicted. */
export const DEFAULT_ADMIN_LOGIN_MAX_KEYS = 10_000

export interface LoginRateLimiterOptions {
  /** Failures allowed per key within the window. */
  readonly maxFailures?: number
  readonly windowMs?: number
  readonly maxKeys?: number
  /** Millisecond clock; injectable for deterministic tests. */
  readonly now?: () => number
}

/**
 * Sliding-window failure counter. `retryAfterSeconds` answers how long the
 * caller should wait before trying the same key again.
 */
export class LoginRateLimiter {
  private readonly maxFailures: number
  private readonly windowMs: number
  private readonly maxKeys: number
  private readonly now: () => number
  private readonly failures = new Map<string, number[]>()

  constructor(options: LoginRateLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? DEFAULT_ADMIN_LOGIN_MAX_FAILURES
    this.windowMs = options.windowMs ?? DEFAULT_ADMIN_LOGIN_WINDOW_MS
    this.maxKeys = options.maxKeys ?? DEFAULT_ADMIN_LOGIN_MAX_KEYS
    this.now = options.now ?? (() => Date.now())

    if (!Number.isSafeInteger(this.maxFailures) || this.maxFailures < 1) {
      throw new Error('maxFailures must be a positive integer')
    }
    if (!Number.isSafeInteger(this.windowMs) || this.windowMs < 1) {
      throw new Error('windowMs must be a positive integer')
    }
    if (!Number.isSafeInteger(this.maxKeys) || this.maxKeys < 1) {
      throw new Error('maxKeys must be a positive integer')
    }
  }

  private recent(key: string): readonly number[] {
    const now = this.now()
    const windowStart = now - this.windowMs
    const recorded = this.failures.get(key)
    if (recorded === undefined) {
      return []
    }
    const recent = recorded.filter((at) => at > windowStart)
    if (recent.length === 0) {
      this.failures.delete(key)
    } else if (recent.length !== recorded.length) {
      this.failures.set(key, recent)
    }
    return recent
  }

  /** Seconds until the key may try again, or `null` when it is not limited. */
  retryAfterSeconds(key: string): number | null {
    const recent = this.recent(key)
    if (recent.length < this.maxFailures) {
      return null
    }
    const oldest = recent[0]
    if (oldest === undefined) {
      return null
    }
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1_000))
  }

  recordFailure(key: string): void {
    this.append(key, this.now())
  }

  /**
   * Atomically checks the bound and reserves one attempt. The check and the
   * append happen in one synchronous step, so requests that overlap the slow
   * password verification cannot all pass the bound before any failure is
   * recorded.
   */
  tryReserve(key: string): { readonly retryAfterSeconds: number } | { readonly token: number } {
    const retry = this.retryAfterSeconds(key)
    if (retry !== null) {
      return { retryAfterSeconds: retry }
    }
    return { token: this.append(key, this.now()) }
  }

  /**
   * Gives back one reserved attempt, for example when a later bound rejects
   * the same request. Successful logins use `reset` instead.
   */
  release(key: string, token: number): void {
    const recorded = this.failures.get(key)
    if (recorded === undefined) {
      return
    }
    const index = recorded.lastIndexOf(token)
    if (index < 0) {
      return
    }
    const remaining = [...recorded]
    remaining.splice(index, 1)
    if (remaining.length === 0) {
      this.failures.delete(key)
    } else {
      this.failures.set(key, remaining)
    }
  }

  /** Appends one entry and bounds the number of tracked keys. */
  private append(key: string, at: number): number {
    this.failures.set(key, [...this.recent(key), at])
    while (this.failures.size > this.maxKeys) {
      const oldestKey = this.failures.keys().next().value
      if (oldestKey === undefined || oldestKey === key) {
        break
      }
      this.failures.delete(oldestKey)
    }
    return at
  }

  /** Clears a key after a successful login. */
  reset(key: string): void {
    this.failures.delete(key)
  }
}
