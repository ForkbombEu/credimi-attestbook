// Durable, in-process publication-delivery dispatcher (issue #120).
//
// Publishing a rulebook version records a `rulebook.published` event (#116) and
// then calls `enqueuePublicationEvent`, which writes one bounded outbox row per
// delivery-eligible subscription (#119) and returns without any network call.
// The dispatcher claims due rows with a lease, invokes the one-attempt signed
// deliverer exactly once per claim, and persists either success or a typed
// failure. Failed transient attempts are retried with bounded exponential
// backoff and jitter until the attempt or age cap makes them terminal.
//
// Everything the dispatcher needs to resume lives in SQLite: a crash after the
// publication transaction but before the enqueue is reconciled from the
// immutable event feed, an expired attempt lease is reclaimed, and the unique
// (event, subscription) key is the single permanent record. Delivery is
// therefore at-least-once; a subscriber deduplicates by event id and reconciles
// a missed notification through the public event feed.
//
// The dispatcher is one in-process timer, not a broker or a second service, and
// it owns no callback URL, token, response body or client address. The product
// is a single-writer SQLite deployment (docs/architecture.md §10), so one
// dispatcher runs per database; the lease still makes an accidental concurrent
// claim safe.

import { randomUUID } from 'node:crypto'

import type { Database } from 'bun:sqlite'

import type { Http1Transport } from '../net/http1'
import { PUBLICATION_EVENT_TYPE, type PublicationEvent } from '../registry/types'

import { WebhookDeliveryService, type WebhookDeliveryOptions } from './delivery'
import {
  isRetryableWebhookDelivery,
  resolveWebhookOutboxLimits,
  WebhookOutboxStore,
  type WebhookDeliveryStatusPage,
  type WebhookOutboxEnqueueResult,
  type WebhookOutboxJob,
  type WebhookOutboxLimitOverrides,
  type WebhookOutboxLimits,
} from './outbox'
import type { WebhookDeliveryResult } from './delivery'

/** Options of the durable publication-delivery dispatcher. */
export interface WebhookOutboxDispatcherOptions {
  readonly database: Database
  /** Deployment key; `null` disables delivery and every enqueue is a no-op. */
  readonly signingKey: Buffer | null
  /** Clock used for timestamps and retry scheduling; injectable for tests. */
  readonly now?: () => string
  /** Injectable jitter source in `[0, 1)`; defaults to `Math.random`. */
  readonly random?: () => number
  /** Test-only loopback HTTP opt-in, matching callback registration. */
  readonly allowLoopbackHttp?: boolean
  /** Injectable resolver; tests use a fake and never resolve a real host. */
  readonly resolveCallbackHostname?: WebhookDeliveryOptions['resolveCallbackHostname']
  /** Injectable transport; tests use an offline fake. */
  readonly transport?: Http1Transport
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxCallbackUrlLength?: number
  readonly limits?: WebhookOutboxLimitOverrides
}

/**
 * Exponential-backoff ceiling for one claim number, before the 50–100 % jitter.
 * It is exported so the default retry window can be tested without a timer.
 */
export function webhookBackoffCeilingMs(attempts: number, limits: WebhookOutboxLimits): number {
  const exponent = Math.max(0, attempts - 1)
  return Math.min(limits.maxBackoffMs, limits.baseBackoffMs * 2 ** exponent)
}

/** Exponential delay with 50–100 % jitter; `attempts` is the claim number. */
function jitteredBackoffMs(
  attempts: number,
  limits: WebhookOutboxLimits,
  random: () => number,
): number {
  const ceiling = webhookBackoffCeilingMs(attempts, limits)
  const randomValue = Math.min(Math.max(random(), 0), 1 - Number.EPSILON)
  const factor = 0.5 + randomValue * 0.5
  return Math.max(1, Math.round(ceiling * factor))
}

export class WebhookOutboxDispatcher {
  private readonly store: WebhookOutboxStore
  private readonly delivery: WebhookDeliveryService
  private readonly now: () => string
  private readonly random: () => number
  private readonly limits: WebhookOutboxLimits
  private readonly owner = randomUUID()
  private timer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<void> = Promise.resolve()
  private running = false
  private disposed = false

  constructor(options: WebhookOutboxDispatcherOptions) {
    this.store = new WebhookOutboxStore(options.database)
    this.delivery = new WebhookDeliveryService({
      database: options.database,
      signingKey: options.signingKey,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.allowLoopbackHttp === undefined
        ? {}
        : { allowLoopbackHttp: options.allowLoopbackHttp }),
      ...(options.resolveCallbackHostname === undefined
        ? {}
        : { resolveCallbackHostname: options.resolveCallbackHostname }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: options.maxResponseBytes }),
      ...(options.maxCallbackUrlLength === undefined
        ? {}
        : { maxCallbackUrlLength: options.maxCallbackUrlLength }),
    })
    this.now = options.now ?? (() => new Date().toISOString())
    this.random = options.random ?? Math.random
    this.limits = resolveWebhookOutboxLimits(options.limits)
  }

  /** True when a deployment key is configured and delivery can happen at all. */
  get enabled(): boolean {
    return this.delivery.enabled
  }

  /**
   * Durably enqueues one recorded publication event. This is a bounded SQLite
   * operation and never performs a network request, so it adds no subscriber
   * wait to the publication response. The scheduled dispatch begins after the
   * row exists; a restart recovers it from the outbox.
   */
  enqueuePublicationEvent(event: PublicationEvent): WebhookOutboxEnqueueResult {
    const keyId = this.delivery.keyId
    if (!this.delivery.enabled || keyId === null || event.type !== PUBLICATION_EVENT_TYPE) {
      return { inserted: 0, dropped: 0 }
    }
    const result = this.store.enqueueForEvent(event, keyId, this.now(), this.limits)
    if (result.dropped > 0) {
      // Count-only: no subscriber identity, URL or secret enters the log.
      console.warn(`webhook outbox is full; dropped ${String(result.dropped)} deliveries`)
    }
    void this.enqueueTick()
    return result
  }

  /** Starts the periodic in-process dispatcher. Idempotent. */
  start(): void {
    if (this.running || this.disposed) {
      return
    }
    this.running = true
    void this.enqueueTick()
    this.schedulePoll()
  }

  /** Stops the timer and waits for the current attempt to record its outcome. */
  async stop(): Promise<void> {
    this.running = false
    this.disposed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.chain
  }

  /**
   * Runs one dispatch cycle: recover expired leases, reconcile newly recorded
   * events, claim due jobs and record every attempt. Cycles are serialized
   * inside one dispatcher; two dispatchers rely on the atomic claim.
   */
  tick(): Promise<void> {
    return this.enqueueTick()
  }

  /**
   * Resolves once every currently due job was attempted and recorded. Future
   * retries are not awaited: they remain durable and the poll timer or a later
   * tick owns them. Tests use this to observe a completed dispatch.
   */
  async whenIdle(): Promise<void> {
    for (;;) {
      await this.chain
      if (this.disposed || !this.delivery.enabled) {
        return
      }
      if (!this.store.hasClaimable(this.now(), this.limits)) {
        return
      }
      await this.enqueueTick()
    }
  }

  /** Bounded, sanitized delivery history of exactly one subscription. */
  listDeliveryStatus(
    subscriptionId: string,
    limit: number,
    offset: number,
  ): WebhookDeliveryStatusPage {
    return this.store.listStatusForSubscription(subscriptionId, limit, offset)
  }

  private enqueueTick(): Promise<void> {
    this.chain = this.chain
      .then(() => this.runTick())
      .catch((error: unknown) => {
        // Keep the dispatcher alive after a transient SQLite or transport
        // problem; the durable rows are retried on the next tick.
        console.error('webhook outbox dispatch cycle failed', {
          error: error instanceof Error ? error.name : 'unknown',
        })
      })
    return this.chain
  }

  private schedulePoll(): void {
    if (!this.running || this.disposed) {
      return
    }
    const timer = setTimeout(() => {
      this.timer = null
      void this.enqueueTick().finally(() => {
        this.schedulePoll()
      })
    }, this.limits.pollIntervalMs)
    // The timer must not keep a shutting-down process alive.
    ;(timer as { unref?: () => void }).unref?.()
    this.timer = timer
  }

  private async runTick(): Promise<void> {
    if (this.disposed || !this.delivery.enabled) {
      return
    }
    const now = this.now()
    this.store.recoverExpiredLeases(now)
    this.store.expireAged(now, this.limits)
    this.reconcile(now)

    const claimed = this.store.claimDue(now, this.limits, this.owner)
    if (claimed.length === 0) {
      this.store.prune(now, this.limits)
      return
    }
    await this.processClaimed(claimed)
    this.store.prune(this.now(), this.limits)
  }

  /**
   * Restart-safe catch-up: any recorded event after the durable cursor whose
   * enqueue did not complete (for example a crash between the publication
   * commit and this dispatch) gets its missing rows. Idempotent duplicate keys
   * are ignored, and the cursor moves in the same transaction as the inserts.
   */
  private reconcile(now: string): void {
    const keyId = this.delivery.keyId
    if (keyId === null) {
      return
    }
    // A bounded number of batches per tick keeps one cycle short after a long
    // downtime; the next tick continues from the durable cursor.
    for (let batch = 0; batch < 8; batch += 1) {
      const events = this.store.listEventsAfter(this.store.getCursor(), this.limits.batchSize)
      if (events.length === 0) {
        return
      }
      const result = this.store.reconcileEvents(events, keyId, now, this.limits)
      if (result.dropped > 0) {
        console.warn(`webhook outbox is full; dropped ${String(result.dropped)} deliveries`)
      }
    }
  }

  private async processClaimed(claimed: readonly WebhookOutboxJob[]): Promise<void> {
    let next = 0
    const workerCount = Math.min(this.limits.dispatchConcurrency, claimed.length)
    const workers: Promise<void>[] = []
    for (let worker = 0; worker < workerCount; worker += 1) {
      workers.push(
        (async () => {
          for (;;) {
            const index = next
            next += 1
            const job = claimed[index]
            if (job === undefined) {
              return
            }
            if (this.disposed) {
              // Shutdown: do not start another attempt, and make the remaining
              // claims immediately available to the next process.
              this.store.releaseLease(job.sequence, this.owner, this.now())
              continue
            }
            await this.processOne(job)
          }
        })(),
      )
    }
    await Promise.all(workers)
  }

  private async processOne(job: WebhookOutboxJob): Promise<void> {
    const event = this.store.findEventById(job.eventId)
    if (event === null) {
      this.store.markEventMissing(job.sequence, this.owner, this.now())
      return
    }

    let result: WebhookDeliveryResult
    try {
      result = await this.delivery.attempt(event, job.subscriptionId)
    } catch {
      result = {
        subscriptionId: job.subscriptionId,
        delivered: false,
        reason: 'network_failure',
      }
    }

    const now = this.now()
    if (result.delivered) {
      this.store.markDelivered(job.sequence, this.owner, now)
      return
    }

    const retryable = isRetryableWebhookDelivery(result)
    const nextAttemptAt = new Date(
      Date.parse(now) + jitteredBackoffMs(job.attempts, this.limits, this.random),
    ).toISOString()
    this.store.markFailed(
      job,
      this.owner,
      now,
      result.reason ?? 'network_failure',
      retryable,
      nextAttemptAt,
      this.limits,
    )
  }
}
