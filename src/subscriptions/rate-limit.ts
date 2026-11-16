// In-process registration quota for anonymous webhook subscriptions (issue
// #117).
//
// A subscription can be created without a login, so the per-client quota is a
// product abuse control, not an identity system. It counts successful
// registrations in a sliding window keyed by the request's socket address. It
// deliberately does not trust `X-Forwarded-For` or any other client-supplied
// forwarding header; behind a reverse proxy every client therefore shares the
// proxy's address, which is documented as a limitation.
//
// The quota is in memory and resets when the process restarts. The durable
// per-rulebook bound is enforced separately against SQLite.

import type { SubscriptionLimits } from './types'

/** One reserved registration slot. */
export interface ReservedRegistration {
  readonly token: number
}

/** The client is over its quota until `retryAfterSeconds` have elapsed. */
export interface RegistrationQuotaExceeded {
  readonly retryAfterSeconds: number
}

export type RegistrationReservation = ReservedRegistration | RegistrationQuotaExceeded

export interface SubscriptionRegistrationLimiterOptions {
  readonly maxRegistrations: number
  readonly windowMs: number
  readonly maxKeys: number
  /** Millisecond clock; injectable for deterministic tests. */
  readonly now?: () => number
}

/** Normalizes a client key to a bounded, non-secret lookup value. */
export function normalizeSubscriptionClientKey(clientKey: string): string {
  const normalized = clientKey.trim().slice(0, 128).toLowerCase()
  return normalized === '' ? 'unknown' : normalized
}

export class SubscriptionRegistrationLimiter {
  private readonly maxRegistrations: number
  private readonly windowMs: number
  private readonly maxKeys: number
  private readonly now: () => number
  private readonly registrations = new Map<string, number[]>()

  constructor(options: SubscriptionRegistrationLimiterOptions) {
    this.maxRegistrations = options.maxRegistrations
    this.windowMs = options.windowMs
    this.maxKeys = options.maxKeys
    this.now = options.now ?? (() => Date.now())

    for (const [name, value] of [
      ['maxRegistrations', this.maxRegistrations],
      ['windowMs', this.windowMs],
      ['maxKeys', this.maxKeys],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`)
      }
    }
  }

  /** Builds the limiter from the shared subscription bounds. */
  static fromLimits(
    limits: SubscriptionLimits,
    now?: () => number,
  ): SubscriptionRegistrationLimiter {
    return new SubscriptionRegistrationLimiter({
      maxRegistrations: limits.registrationsPerClient,
      windowMs: limits.registrationWindowMs,
      maxKeys: limits.maxRateLimitKeys,
      ...(now === undefined ? {} : { now }),
    })
  }

  private recent(key: string): readonly number[] {
    const now = this.now()
    const windowStart = now - this.windowMs
    const recorded = this.registrations.get(key)
    if (recorded === undefined) {
      return []
    }
    const recent = recorded.filter((at) => at > windowStart)
    if (recent.length === 0) {
      this.registrations.delete(key)
    } else if (recent.length !== recorded.length) {
      this.registrations.set(key, recent)
    }
    return recent
  }

  /** Seconds until the key may register again, or `null` when it is not capped. */
  retryAfterSeconds(key: string): number | null {
    const recent = this.recent(key)
    if (recent.length < this.maxRegistrations) {
      return null
    }
    const oldest = recent[0]
    if (oldest === undefined) {
      return null
    }
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1_000))
  }

  /**
   * Atomically checks the quota and reserves one successful-registration slot.
   * The check and the append happen in one synchronous step, so overlapping
   * requests cannot all pass the bound before any of them is counted.
   */
  tryReserve(clientKey: string): RegistrationReservation {
    const key = normalizeSubscriptionClientKey(clientKey)
    const retry = this.retryAfterSeconds(key)
    if (retry !== null) {
      return { retryAfterSeconds: retry }
    }
    return { token: this.append(key, this.now()) }
  }

  /** Gives back a reservation when the registration was not stored. */
  release(clientKey: string, token: number): void {
    const key = normalizeSubscriptionClientKey(clientKey)
    const recorded = this.registrations.get(key)
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
      this.registrations.delete(key)
    } else {
      this.registrations.set(key, remaining)
    }
  }

  private append(key: string, at: number): number {
    this.registrations.set(key, [...this.recent(key), at])
    while (this.registrations.size > this.maxKeys) {
      const oldestKey = this.registrations.keys().next().value
      if (oldestKey === undefined || oldestKey === key) {
        break
      }
      this.registrations.delete(oldestKey)
    }
    return at
  }
}
