// Durable publication-delivery outbox (issue #120).
//
// A publication event (#116) is the immutable delivery payload; this module
// stores one bounded job per `(event, subscription)` pair and owns every SQL
// operation on it. Enqueue and claim are transactional and idempotent, and an
// attempt lease survives a process restart only as a durable recovery marker:
// a new process claims an expired lease and retries, which makes delivery
// at-least-once without a second permanent record.
//
// The store never performs a network request and never stores a callback URL,
// response body, client address, token or signing secret. It returns only
// sanitized failure categories and timestamps to the status view.

import type { Database } from 'bun:sqlite'

import type { PublicationEvent } from '../registry/types'
import type { StoredPublicationEvent } from '../registry/store'

import type { WebhookDeliveryResult } from './delivery'
import { SubscriptionStore } from './store'

/** Product status of one durable delivery job. A leased job stays `pending`. */
export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number]

/** Sanitized reasons a failed job is terminal. */
export const WEBHOOK_DELIVERY_TERMINAL_REASONS = [
  'max_attempts',
  'max_age',
  'non_retryable',
  'subscription_ineligible',
  'event_missing',
] as const
export type WebhookDeliveryTerminalReason = (typeof WEBHOOK_DELIVERY_TERMINAL_REASONS)[number]

/** Bounds of the outbox, the retry budget and the in-process dispatcher. */
export interface WebhookOutboxLimits {
  /** Claimed attempts before a failed job becomes terminal. */
  readonly maxAttempts: number
  /** Age after which a job is no longer claimed and fails terminally. */
  readonly maxAgeMs: number
  /** Exponential-backoff base delay. */
  readonly baseBackoffMs: number
  /** Upper bound of the exponential delay before jitter. */
  readonly maxBackoffMs: number
  /** How long one claimed attempt may stay leased before recovery. */
  readonly leaseTtlMs: number
  /** Maximum pending (not terminal) rows the outbox may hold. */
  readonly maxPendingEntries: number
  /** How long a delivered or failed row is kept for the status view. */
  readonly retentionMs: number
  /** Idle poll interval of the in-process dispatcher. */
  readonly pollIntervalMs: number
  /** Claimed jobs per dispatch tick. */
  readonly batchSize: number
  /** Concurrent outbound attempts per dispatch tick. */
  readonly dispatchConcurrency: number
}

export type WebhookOutboxLimitOverrides = Partial<WebhookOutboxLimits>

export const DEFAULT_WEBHOOK_OUTBOX_MAX_ATTEMPTS = 13
export const DEFAULT_WEBHOOK_OUTBOX_MAX_AGE_MS = 60 * 60 * 1_000
export const DEFAULT_WEBHOOK_OUTBOX_BASE_BACKOFF_MS = 2_000
export const DEFAULT_WEBHOOK_OUTBOX_MAX_BACKOFF_MS = 15 * 60 * 1_000
export const DEFAULT_WEBHOOK_OUTBOX_LEASE_TTL_MS = 30 * 1_000
export const DEFAULT_WEBHOOK_OUTBOX_MAX_PENDING_ENTRIES = 10_000
export const DEFAULT_WEBHOOK_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
export const DEFAULT_WEBHOOK_OUTBOX_POLL_INTERVAL_MS = 500
export const DEFAULT_WEBHOOK_OUTBOX_BATCH_SIZE = 20
export const DEFAULT_WEBHOOK_OUTBOX_DISPATCH_CONCURRENCY = 4
export const DEFAULT_WEBHOOK_OUTBOX_STATUS_LIMIT = 20
export const MAX_WEBHOOK_OUTBOX_STATUS_LIMIT = 100

/**
 * Exponential-backoff ceiling for one claim number, before the 50–100 % jitter.
 * The outbox bound validation and the dispatcher share this one formula.
 */
export function webhookBackoffCeilingMs(
  attempts: number,
  limits: Pick<WebhookOutboxLimits, 'baseBackoffMs' | 'maxBackoffMs'>,
): number {
  const exponent = Math.max(0, attempts - 1)
  return Math.min(limits.maxBackoffMs, limits.baseBackoffMs * 2 ** exponent)
}

/** Resolves and validates the outbox bounds; every value is a positive integer. */
export function resolveWebhookOutboxLimits(
  overrides: WebhookOutboxLimitOverrides = {},
): WebhookOutboxLimits {
  const limits: WebhookOutboxLimits = {
    maxAttempts: overrides.maxAttempts ?? DEFAULT_WEBHOOK_OUTBOX_MAX_ATTEMPTS,
    maxAgeMs: overrides.maxAgeMs ?? DEFAULT_WEBHOOK_OUTBOX_MAX_AGE_MS,
    baseBackoffMs: overrides.baseBackoffMs ?? DEFAULT_WEBHOOK_OUTBOX_BASE_BACKOFF_MS,
    maxBackoffMs: overrides.maxBackoffMs ?? DEFAULT_WEBHOOK_OUTBOX_MAX_BACKOFF_MS,
    leaseTtlMs: overrides.leaseTtlMs ?? DEFAULT_WEBHOOK_OUTBOX_LEASE_TTL_MS,
    maxPendingEntries: overrides.maxPendingEntries ?? DEFAULT_WEBHOOK_OUTBOX_MAX_PENDING_ENTRIES,
    retentionMs: overrides.retentionMs ?? DEFAULT_WEBHOOK_OUTBOX_RETENTION_MS,
    pollIntervalMs: overrides.pollIntervalMs ?? DEFAULT_WEBHOOK_OUTBOX_POLL_INTERVAL_MS,
    batchSize: overrides.batchSize ?? DEFAULT_WEBHOOK_OUTBOX_BATCH_SIZE,
    dispatchConcurrency:
      overrides.dispatchConcurrency ?? DEFAULT_WEBHOOK_OUTBOX_DISPATCH_CONCURRENCY,
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`webhook outbox ${name} must be a positive integer`)
    }
  }
  if (limits.maxBackoffMs < limits.baseBackoffMs) {
    throw new RangeError('webhook outbox maxBackoffMs must not be below baseBackoffMs')
  }
  // A schedule that spends all its attempts before the age cap would make the
  // documented age bound unreachable and lose a notification after a short
  // outage. Require the minimum-jitter retry window to cover at least a quarter
  // of the age cap. A single-attempt schedule has no window to validate.
  if (limits.maxAttempts > 1) {
    let minimumBackoffMs = 0
    for (let attempt = 1; attempt < limits.maxAttempts; attempt += 1) {
      minimumBackoffMs += Math.min(limits.maxBackoffMs, limits.baseBackoffMs * 2 ** (attempt - 1))
    }
    if (minimumBackoffMs / 2 < limits.maxAgeMs / 4) {
      throw new RangeError('webhook outbox retry schedule cannot reach the configured age cap')
    }
  }
  return limits
}

/** One durable job claimed by a dispatcher attempt. */
export interface WebhookOutboxJob {
  readonly sequence: number
  readonly eventId: string
  readonly subscriptionId: string
  /** Attempt number of this claim, already incremented. */
  readonly attempts: number
  readonly createdAt: string
  readonly nextAttemptAt: string
  /** Attempt start before this claim, restored when an unattempted claim is released. */
  readonly lastAttemptAt: string | null
}

/** Counts of one idempotent enqueue pass. */
export interface WebhookOutboxEnqueueResult {
  readonly inserted: number
  /** Eligible jobs not stored because the bounded outbox was full. */
  readonly dropped: number
}

/** Outcome of recording one attempt. */
export interface WebhookOutboxFailureOutcome {
  readonly status: WebhookDeliveryStatus
  readonly terminalReason: WebhookDeliveryTerminalReason | null
  readonly nextAttemptAt: string | null
  readonly attempts: number
}

/**
 * One sanitized row of the management-token-protected delivery-status view.
 * It never contains a callback URL, a token, a response body or an address.
 */
export interface WebhookDeliveryStatusEntry {
  readonly eventId: string
  readonly status: WebhookDeliveryStatus
  readonly attempts: number
  readonly createdAt: string
  readonly updatedAt: string
  /** Earliest next attempt while pending, `null` once terminal. */
  readonly nextAttemptAt: string | null
  readonly lastAttemptAt: string | null
  readonly lastErrorCategory: string | null
  readonly terminalReason: WebhookDeliveryTerminalReason | null
  readonly deliveredAt: string | null
  readonly failedAt: string | null
}

export interface WebhookDeliveryStatusPage {
  readonly entries: readonly WebhookDeliveryStatusEntry[]
  readonly total: number
}

interface OutboxRow {
  readonly sequence: number
  readonly event_id: string
  readonly subscription_id: string
  readonly status: string
  readonly attempts: number
  readonly created_at: string
  readonly updated_at: string
  readonly next_attempt_at: string
  readonly last_attempt_at: string | null
  readonly lease_owner: string | null
  readonly lease_expires_at: string | null
  readonly last_error_category: string | null
  readonly terminal_reason: string | null
  readonly delivered_at: string | null
  readonly terminal_at: string | null
}

function toJob(row: OutboxRow): WebhookOutboxJob {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    subscriptionId: row.subscription_id,
    attempts: row.attempts,
    createdAt: row.created_at,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at,
  }
}

function toStatusEntry(row: OutboxRow): WebhookDeliveryStatusEntry {
  const status = row.status as WebhookDeliveryStatus
  return {
    eventId: row.event_id,
    status,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextAttemptAt: status === 'pending' ? row.next_attempt_at : null,
    lastAttemptAt: row.last_attempt_at,
    lastErrorCategory: row.last_error_category,
    terminalReason:
      row.terminal_reason === null ? null : (row.terminal_reason as WebhookDeliveryTerminalReason),
    deliveredAt: row.delivered_at,
    failedAt: row.terminal_at,
  }
}

function toMillis(value: string, name: string): number {
  const millis = Date.parse(value)
  if (!Number.isFinite(millis)) {
    throw new Error(`invalid ${name} timestamp`)
  }
  return millis
}

/**
 * True when a failed single attempt may be retried. A 2xx is success, a 4xx
 * answer, a redirect, a blocked target, an oversized response or an ineligible
 * subscription is terminal, and a transport failure or 5xx answer is transient.
 */
export function isRetryableWebhookDelivery(result: WebhookDeliveryResult): boolean {
  if (result.delivered) {
    return false
  }
  switch (result.reason) {
    case 'timeout':
    case 'dns_failure':
    case 'network_failure':
      return true
    case 'unexpected_status':
      return result.status !== undefined && result.status >= 500
    default:
      return false
  }
}

export class WebhookOutboxStore {
  private readonly subscriptions: SubscriptionStore

  constructor(private readonly database: Database) {
    this.subscriptions = new SubscriptionStore(database)
  }

  /**
   * Inserts one pending job per delivery-eligible subscription that existed
   * when the event was published. The unique `(event_id, subscription_id)` key
   * makes a repeated call a no-op, and the bounded pending count drops excess
   * jobs rather than growing without bound. The caller owns any surrounding
   * transaction.
   */
  private enqueueWithinTransaction(
    event: PublicationEvent,
    keyId: string,
    now: string,
    limits: WebhookOutboxLimits,
  ): WebhookOutboxEnqueueResult {
    const existing = new Set(
      this.database
        .query<{ subscription_id: string }, [string]>(
          'SELECT subscription_id FROM webhook_delivery_outbox WHERE event_id = ?',
        )
        .all(event.id)
        .map((row) => row.subscription_id),
    )
    const eligible = this.subscriptions.listDeliveryEligibleForEvent(
      event.rulebookId,
      keyId,
      event.publishedAt,
    )
    const pending = this.countPending()
    let budget = Math.max(0, limits.maxPendingEntries - pending)
    let inserted = 0
    let dropped = 0

    const insert = this.database.query(
      `INSERT INTO webhook_delivery_outbox (
         event_id, subscription_id, status, attempts, created_at, updated_at, next_attempt_at
       ) VALUES (?, ?, 'pending', 0, ?, ?, ?)`,
    )
    for (const subscription of eligible) {
      if (existing.has(subscription.id)) {
        // Idempotent replay: the durable record already exists.
        continue
      }
      if (budget <= 0) {
        dropped += 1
        continue
      }
      insert.run(event.id, subscription.id, now, now, now)
      inserted += 1
      budget -= 1
    }
    return { inserted, dropped }
  }

  /** Idempotently enqueues one event in its own transaction. */
  enqueueForEvent(
    event: PublicationEvent,
    keyId: string,
    now: string,
    limits: WebhookOutboxLimits,
  ): WebhookOutboxEnqueueResult {
    return this.database.transaction(() =>
      this.enqueueWithinTransaction(event, keyId, now, limits),
    )()
  }

  /**
   * Restart-safe reconciliation: inserts the missing jobs of a batch of
   * recorded events and advances the durable feed cursor in one transaction.
   * A crash before the commit replays the whole batch, which the unique key
   * deduplicates; a crash after it never duplicates a permanent record.
   */
  reconcileEvents(
    events: readonly StoredPublicationEvent[],
    keyId: string,
    now: string,
    limits: WebhookOutboxLimits,
  ): WebhookOutboxEnqueueResult {
    return this.database.transaction(() => {
      let inserted = 0
      let dropped = 0
      let lastSequence = this.getCursor()
      for (const stored of events) {
        const result = this.enqueueWithinTransaction(stored.event, keyId, now, limits)
        inserted += result.inserted
        dropped += result.dropped
        lastSequence = stored.sequence
      }
      if (lastSequence !== this.getCursor()) {
        this.database
          .query(
            'UPDATE webhook_delivery_outbox_state SET last_event_sequence = ?, updated_at = ? WHERE id = 1',
          )
          .run(lastSequence, now)
      }
      return { inserted, dropped }
    })()
  }

  getCursor(): number {
    const row = this.database
      .query<{ last_event_sequence: number }, []>(
        'SELECT last_event_sequence FROM webhook_delivery_outbox_state WHERE id = 1',
      )
      .get()
    return row?.last_event_sequence ?? 0
  }

  listEventsAfter(sequence: number, limit: number): readonly StoredPublicationEvent[] {
    return this.database
      .query<
        {
          sequence: number
          id: string
          format: PublicationEvent['format']
          event_type: PublicationEvent['type']
          rulebook_id: string
          version: string
          content_digest: string
          published_at: string
        },
        [number, number]
      >(
        `SELECT sequence, id, format, event_type, rulebook_id, version,
                content_digest, published_at
         FROM publication_events
         WHERE sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(sequence, limit)
      .map((row) => ({
        sequence: row.sequence,
        event: {
          id: row.id,
          format: row.format,
          type: row.event_type,
          rulebookId: row.rulebook_id,
          version: row.version,
          contentDigest: row.content_digest,
          publishedAt: row.published_at,
        },
      }))
  }

  findEventById(eventId: string): PublicationEvent | null {
    const row = this.database
      .query<
        {
          id: string
          format: PublicationEvent['format']
          event_type: PublicationEvent['type']
          rulebook_id: string
          version: string
          content_digest: string
          published_at: string
        },
        [string]
      >(
        `SELECT id, format, event_type, rulebook_id, version, content_digest, published_at
         FROM publication_events WHERE id = ?`,
      )
      .get(eventId)
    if (row === null) {
      return null
    }
    return {
      id: row.id,
      format: row.format,
      type: row.event_type,
      rulebookId: row.rulebook_id,
      version: row.version,
      contentDigest: row.content_digest,
      publishedAt: row.published_at,
    }
  }

  countPending(): number {
    return (
      this.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM webhook_delivery_outbox WHERE status = 'pending'",
        )
        .get()?.count ?? 0
    )
  }

  /**
   * Atomically leases up to `limits.batchSize` due pending jobs in one
   * `UPDATE ... RETURNING`. The attempt counter is incremented at claim time,
   * so a crash mid-attempt still spends an attempt; a second dispatcher cannot
   * claim the same lease while it is unexpired.
   */
  claimDue(now: string, limits: WebhookOutboxLimits, owner: string): readonly WebhookOutboxJob[] {
    const nowMs = toMillis(now, 'now')
    const ageCutoff = new Date(nowMs - limits.maxAgeMs).toISOString()
    const leaseExpiresAt = new Date(nowMs + limits.leaseTtlMs).toISOString()
    // The previous attempt start is not available from RETURNING (SQLite returns
    // the new row), so read the candidates and update them under one immediate
    // transaction. A released claim can then restore the exact prior value.
    return this.database
      .transaction(() => {
        const candidates = this.database
          .query<
            { sequence: number; last_attempt_at: string | null },
            [string, string, string, number, number]
          >(
            `SELECT sequence, last_attempt_at FROM webhook_delivery_outbox
             WHERE status = 'pending'
               AND next_attempt_at <= ?
               AND created_at > ?
               AND (lease_owner IS NULL OR lease_expires_at <= ?)
               AND attempts < ?
             ORDER BY next_attempt_at, sequence
             LIMIT ?`,
          )
          .all(now, ageCutoff, now, limits.maxAttempts, limits.batchSize)
        if (candidates.length === 0) {
          return []
        }
        const previousAttempt = new Map(
          candidates.map((candidate) => [candidate.sequence, candidate.last_attempt_at]),
        )
        return this.database
          .query<
            OutboxRow,
            [string, string, string, string, string, string, string, number, number, string]
          >(
            `UPDATE webhook_delivery_outbox
             SET lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1,
                 last_attempt_at = ?, updated_at = ?
             WHERE sequence IN (
               SELECT sequence FROM webhook_delivery_outbox
               WHERE status = 'pending'
                 AND next_attempt_at <= ?
                 AND created_at > ?
                 AND (lease_owner IS NULL OR lease_expires_at <= ?)
                 AND attempts < ?
               ORDER BY next_attempt_at, sequence
               LIMIT ?
             )
               AND status = 'pending'
               AND (lease_owner IS NULL OR lease_expires_at <= ?)
             RETURNING *`,
          )
          .all(
            owner,
            leaseExpiresAt,
            now,
            now,
            now,
            ageCutoff,
            now,
            limits.maxAttempts,
            limits.batchSize,
            now,
          )
          .map((row) => ({
            ...toJob(row),
            lastAttemptAt: previousAttempt.get(row.sequence) ?? null,
          }))
      })
      .immediate()
  }

  /** True when a pending job is currently claimable, used to drain tests. */
  hasClaimable(now: string, limits: WebhookOutboxLimits): boolean {
    const nowMs = toMillis(now, 'now')
    const ageCutoff = new Date(nowMs - limits.maxAgeMs).toISOString()
    const row = this.database
      .query<{ present: number }, [string, string, string, number]>(
        `SELECT 1 AS present FROM webhook_delivery_outbox
         WHERE status = 'pending'
           AND next_attempt_at <= ?
           AND created_at > ?
           AND (lease_owner IS NULL OR lease_expires_at <= ?)
           AND attempts < ?
         LIMIT 1`,
      )
      .get(now, ageCutoff, now, limits.maxAttempts)
    return row !== null
  }

  /**
   * Releases one claimed lease that was never attempted (shutdown): it clears
   * the lease, gives back the attempt `claimDue` counted and restores the
   * previous attempt instant, so a restart cannot spend an unsent attempt.
   */
  releaseLease(job: WebhookOutboxJob, owner: string, now: string): boolean {
    return (
      this.database
        .query(
          `UPDATE webhook_delivery_outbox
           SET lease_owner = NULL, lease_expires_at = NULL,
               attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
               last_attempt_at = ?, updated_at = ?
           WHERE sequence = ? AND status = 'pending' AND lease_owner = ?`,
        )
        .run(job.lastAttemptAt, now, job.sequence, owner).changes > 0
    )
  }

  /** Clears a lease whose holder did not record an outcome in time. */
  recoverExpiredLeases(now: string): number {
    return this.database
      .query(
        `UPDATE webhook_delivery_outbox
         SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE status = 'pending' AND lease_owner IS NOT NULL AND lease_expires_at <= ?`,
      )
      .run(now, now).changes
  }

  /**
   * Marks pending jobs terminally failed when they cannot make progress: all
   * attempts were already spent by crashed claims, or the age bound is
   * exhausted. A live lease is left alone until it expires.
   */
  expireAged(now: string, limits: WebhookOutboxLimits): number {
    const attemptsExhausted = this.database
      .query(
        `UPDATE webhook_delivery_outbox
         SET status = 'failed', terminal_at = ?, terminal_reason = 'max_attempts',
             updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
         WHERE status = 'pending'
           AND attempts >= ?
           AND (lease_owner IS NULL OR lease_expires_at <= ?)`,
      )
      .run(now, now, limits.maxAttempts, now).changes
    const cutoff = new Date(toMillis(now, 'now') - limits.maxAgeMs).toISOString()
    const ageExhausted = this.database
      .query(
        `UPDATE webhook_delivery_outbox
         SET status = 'failed', terminal_at = ?, terminal_reason = 'max_age',
             updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
         WHERE status = 'pending'
           AND created_at <= ?
           AND (lease_owner IS NULL OR lease_expires_at <= ?)`,
      )
      .run(now, now, cutoff, now).changes
    return attemptsExhausted + ageExhausted
  }

  /** Records a successful attempt, only while the caller still holds the lease. */
  markDelivered(sequence: number, owner: string, now: string): boolean {
    return (
      this.database
        .query(
          `UPDATE webhook_delivery_outbox
           SET status = 'delivered', delivered_at = ?, lease_owner = NULL,
               lease_expires_at = NULL, last_error_category = NULL, updated_at = ?
           WHERE sequence = ? AND status = 'pending' AND lease_owner = ?`,
        )
        .run(now, now, sequence, owner).changes > 0
    )
  }

  /** The publication event referenced by a job vanished (should not happen). */
  markEventMissing(sequence: number, owner: string, now: string): boolean {
    return (
      this.database
        .query(
          `UPDATE webhook_delivery_outbox
           SET status = 'failed', terminal_at = ?, terminal_reason = 'event_missing',
               lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE sequence = ? AND status = 'pending' AND lease_owner = ?`,
        )
        .run(now, now, sequence, owner).changes > 0
    )
  }

  /**
   * Records a failed attempt. A non-retryable failure, an exhausted attempt
   * budget or an exhausted age budget makes the job terminal; otherwise it
   * stays pending with the caller-computed next-attempt instant.
   */
  markFailed(
    job: WebhookOutboxJob,
    owner: string,
    now: string,
    category: string,
    retryable: boolean,
    nextAttemptAt: string,
    limits: WebhookOutboxLimits,
  ): WebhookOutboxFailureOutcome {
    const ageExceeded =
      toMillis(now, 'now') - toMillis(job.createdAt, 'created_at') >= limits.maxAgeMs
    let terminalReason: WebhookDeliveryTerminalReason | null = null
    if (!retryable) {
      terminalReason =
        category === 'subscription_not_eligible' ? 'subscription_ineligible' : 'non_retryable'
    } else if (job.attempts >= limits.maxAttempts) {
      terminalReason = 'max_attempts'
    } else if (ageExceeded) {
      terminalReason = 'max_age'
    }

    if (terminalReason !== null) {
      this.database
        .query(
          `UPDATE webhook_delivery_outbox
           SET status = 'failed', terminal_at = ?, terminal_reason = ?,
               last_error_category = ?, lease_owner = NULL, lease_expires_at = NULL,
               updated_at = ?
           WHERE sequence = ? AND status = 'pending' AND lease_owner = ?`,
        )
        .run(now, terminalReason, category, now, job.sequence, owner)
      return { status: 'failed', terminalReason, nextAttemptAt: null, attempts: job.attempts }
    }

    this.database
      .query(
        `UPDATE webhook_delivery_outbox
         SET next_attempt_at = ?, last_error_category = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE sequence = ? AND status = 'pending' AND lease_owner = ?`,
      )
      .run(nextAttemptAt, category, now, job.sequence, owner)
    return { status: 'pending', terminalReason: null, nextAttemptAt, attempts: job.attempts }
  }

  /** Deletes terminal rows older than the status-view retention bound. */
  prune(now: string, limits: WebhookOutboxLimits): number {
    const cutoff = new Date(toMillis(now, 'now') - limits.retentionMs).toISOString()
    return this.database
      .query("DELETE FROM webhook_delivery_outbox WHERE status <> 'pending' AND updated_at < ?")
      .run(cutoff).changes
  }

  /** Bounded, sanitized delivery history of exactly one subscription. */
  listStatusForSubscription(
    subscriptionId: string,
    limit: number,
    offset: number,
  ): WebhookDeliveryStatusPage {
    const entries = this.database
      .query<OutboxRow, [string, number, number]>(
        `SELECT * FROM webhook_delivery_outbox
         WHERE subscription_id = ?
         ORDER BY sequence DESC
         LIMIT ? OFFSET ?`,
      )
      .all(subscriptionId, limit, offset)
      .map(toStatusEntry)
    const total =
      this.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM webhook_delivery_outbox WHERE subscription_id = ?',
        )
        .get(subscriptionId)?.count ?? 0
    return { entries, total }
  }
}
