// Signed, single-attempt publication webhook delivery (issue #119).
//
// Publishing a rulebook version appends one durable `rulebook.published` event
// (#116). After that publication transaction has committed, this module maps the
// stored event to one bounded JSON notification per delivery-eligible
// subscription (#118: `active` and verified) of the same rulebook, signs the
// exact body and sends exactly one bounded HTTP request. Retries, a durable
// outbox and delivery status are deliberately out of scope (issue #120).
//
// The callback is untrusted. The destination is re-validated and resolved at
// send time under the same public-address policy as verification, the
// connection is pinned to that address, redirects are never followed, and the
// DNS lookup, connection and request share one deadline with a response-size
// cap. A non-2xx answer, a redirect, a timeout or a transport failure is a typed
// delivery failure, never a success. No request happens inside the publication
// transaction: the caller dispatches only after `publishRulebookVersion`
// returns.
//
// Signing secrets are derived from the deployment key with HMAC-SHA-256 and
// the subscription id, so they are stable across restarts, independent per
// subscription and never stored in the database. The plaintext secret is
// returned once by registration and is never written to a listing, an error or
// a log.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import type { Database } from 'bun:sqlite'

import {
  createHttp1Transport,
  isHttp1TransportError,
  type Http1Response,
  type Http1Transport,
} from '../net/http1'
import { PUBLICATION_EVENT_TYPE, type PublicationEvent } from '../registry/types'

import {
  isSubscriptionError,
  subscriptionCallbackUnreachable,
  type SubscriptionCallbackUnreachableReason,
} from './errors'
import { DEFAULT_MAX_CALLBACK_URL_LENGTH } from './limits'
import { SubscriptionStore } from './store'
import type { CallbackHostResolver, ResolvedCallbackTarget } from './verification'
import { resolveSubscriptionCallbackTarget } from './verification'

/** Product shape version of the signed delivery, independent of the event shape. */
export const WEBHOOK_SIGNATURE_VERSION = 'v1'

/** Prefix of every per-subscription webhook verification secret (`attestbook webhook`). */
export const WEBHOOK_SECRET_PREFIX = 'atw_'

/** 256 random-equivalent bits from the HMAC, base64url without padding. */
const WEBHOOK_SECRET_BODY_LENGTH = 43

/** Exact unpadded base64url form of a deployment key of at least 32 bytes. */
const WEBHOOK_SIGNING_KEY_PATTERN = /^[A-Za-z0-9_-]{43,128}$/

/** Canonical domain-separation prefix of the secret derivation. */
const WEBHOOK_SECRET_CONTEXT = 'attestbook.subscription.webhook-secret@1'

/** Canonical domain-separation prefix of the request signing input. */
const WEBHOOK_SIGNING_CONTEXT = 'attestbook.webhook-signing-input@1'

/** Canonical domain-separation prefix of the non-secret deployment-key id. */
const WEBHOOK_KEY_ID_CONTEXT = 'attestbook.webhook-key-id@1'

/** Header carrying the stored event identifier. */
export const WEBHOOK_EVENT_ID_HEADER = 'x-attestbook-event-id'

/** Header repeating the event type (`rulebook.published`). */
export const WEBHOOK_EVENT_TYPE_HEADER = 'x-attestbook-event-type'

/** Header carrying the delivery timestamp used in the signature. */
export const WEBHOOK_TIMESTAMP_HEADER = 'x-attestbook-timestamp'

/** Header carrying `v1=<lowercase hex HMAC-SHA-256>`. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-attestbook-signature'

/** Content type of the notification body. */
export const WEBHOOK_CONTENT_TYPE = 'application/json'

/** Bound on the DNS lookup plus the delivery request. */
export const DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS = 5_000

/** Maximum response body read from a callback after a delivery. */
export const DEFAULT_MAX_WEBHOOK_RESPONSE_BYTES = 8 * 1_024

/** Global in-flight deliveries across every publication event. */
export const DEFAULT_WEBHOOK_DELIVERY_CONCURRENCY = 4

/** Hard bound on queued delivery attempts across every publication event. */
export const DEFAULT_MAX_PENDING_WEBHOOK_DELIVERIES = 10_000

/** Hard bound on one JSON notification body. */
export const MAX_WEBHOOK_NOTIFICATION_BYTES = 16 * 1_024

/** Typed, safe reasons a single delivery attempt did not succeed. */
export type WebhookDeliveryFailureReason =
  | 'blocked_target'
  | 'dns_failure'
  | 'network_failure'
  | 'redirect_not_followed'
  | 'response_too_large'
  | 'subscription_not_eligible'
  | 'timeout'
  | 'unexpected_status'

/** Result of one delivery attempt. It never carries a secret or callback URL. */
export interface WebhookDeliveryResult {
  readonly subscriptionId: string
  readonly delivered: boolean
  /** HTTP status when the callback answered at all. */
  readonly status?: number
  /** Stable failure category for a failed attempt. */
  readonly reason?: WebhookDeliveryFailureReason
}

/** Options of the injectable one-attempt delivery component. */
export interface WebhookDeliveryOptions {
  readonly database: Database
  /**
   * Deployment-configured persistence key for secret derivation and request
   * signing. `null` disables delivery entirely; a missing key must never fall
   * back to a generated or committed secret.
   */
  readonly signingKey: Buffer | null
  /** Clock used for the delivery timestamp; injectable for fixed-vector tests. */
  readonly now?: () => string
  /** Test-only loopback HTTP opt-in, matching callback registration. */
  readonly allowLoopbackHttp?: boolean
  /** Maximum stored callback URL length; defaults to the registration bound. */
  readonly maxCallbackUrlLength?: number
  /** Injectable resolver; tests use a fake and never resolve a real host. */
  readonly resolveCallbackHostname?: CallbackHostResolver
  /** Injectable transport; tests use an offline fake. */
  readonly transport?: Http1Transport
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  /** Global in-flight delivery limit across every event. */
  readonly maxConcurrency?: number
  /** Hard bound on the in-memory dispatch queue; excess attempts are dropped. */
  readonly maxPendingDeliveries?: number
  /** Optional observer of each completed attempt, used by tests and #120. */
  readonly onResult?: (result: WebhookDeliveryResult) => void
}

/**
 * Parses `SUBSCRIPTION_WEBHOOK_SIGNING_KEY`. An absent key disables delivery
 * safely; a malformed key fails at startup instead of deriving predictable
 * secrets. The error names the variable but never echoes its value.
 */
export function parseWebhookSigningKey(value: string | undefined): Buffer | null {
  const raw = value?.trim() ?? ''
  if (raw === '') {
    return null
  }
  const message =
    'invalid SUBSCRIPTION_WEBHOOK_SIGNING_KEY: expected unpadded base64url of at least 32 bytes'
  if (!WEBHOOK_SIGNING_KEY_PATTERN.test(raw)) {
    throw new Error(message)
  }
  const key = Buffer.from(raw, 'base64url')
  if (key.byteLength < 32) {
    throw new Error(message)
  }
  return key
}

function assertSigningKey(signingKey: Buffer): void {
  if (signingKey.byteLength < 32) {
    throw new Error('the webhook signing key must be at least 32 bytes')
  }
}

/**
 * Non-secret fingerprint of the deployment key, stored with each subscription
 * so delivery can tell whether that row was registered under the current key.
 * It is a truncated HMAC, not the key or the derived secret, so it cannot be
 * reversed into signing material.
 */
export function webhookSigningKeyId(signingKey: Buffer): string {
  assertSigningKey(signingKey)
  return createHmac('sha256', signingKey)
    .update(WEBHOOK_KEY_ID_CONTEXT, 'utf8')
    .digest('hex')
    .slice(0, 32)
}

/**
 * Derives the subscriber's webhook verification secret. HMAC-SHA-256 with the
 * deployment key makes it deterministic (the same subscription id yields the
 * same secret after a restart), independent per subscription and impossible to
 * recover from the public subscription id alone. Nothing is stored, so a
 * database leak yields no usable signing material.
 */
export function deriveSubscriptionWebhookSecret(
  signingKey: Buffer,
  subscriptionId: string,
): string {
  assertSigningKey(signingKey)
  const derived = createHmac('sha256', signingKey)
    .update(`${WEBHOOK_SECRET_CONTEXT}\n`, 'utf8')
    .update(subscriptionId, 'utf8')
    .digest('base64url')
  return `${WEBHOOK_SECRET_PREFIX}${derived}`
}

/** True when a value has the exact shape of a derived webhook secret. */
export function isSubscriptionWebhookSecret(value: string): boolean {
  if (!value.startsWith(WEBHOOK_SECRET_PREFIX)) {
    return false
  }
  const body = value.slice(WEBHOOK_SECRET_PREFIX.length)
  return body.length === WEBHOOK_SECRET_BODY_LENGTH && /^[A-Za-z0-9_-]+$/.test(body)
}

/**
 * The exact notification body. It is the stored event projection, so the
 * subscriber can correlate the notification with `GET .../events`: the stable
 * event id, the event type, the rulebook, the exact frozen version label, the
 * immutable snapshot digest and the publication timestamp. No draft content,
 * provider identity, credential or audit metadata enters the body.
 */
export function buildWebhookNotificationBody(event: PublicationEvent): Uint8Array {
  const body = Buffer.from(
    JSON.stringify({
      id: event.id,
      format: event.format,
      type: event.type,
      rulebookId: event.rulebookId,
      version: event.version,
      contentDigest: event.contentDigest,
      publishedAt: event.publishedAt,
    }),
    'utf8',
  )
  if (body.byteLength > MAX_WEBHOOK_NOTIFICATION_BYTES) {
    throw new Error(
      `publication webhook body exceeds the ${String(MAX_WEBHOOK_NOTIFICATION_BYTES)}-byte bound`,
    )
  }
  return body
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The documented canonical signing input:
 *
 * ```text
 * attestbook.webhook-signing-input@1
 * <X-AttestBook-Timestamp>
 * <X-AttestBook-Event-Id>
 * <lowercase hex SHA-256 of the exact body bytes>
 * ```
 *
 * Lines are separated by a single LF and there is no trailing newline. The
 * timestamp and event id are bounded header values that cannot contain a line
 * break, so the input is unambiguous; the body digest commits to the exact
 * bytes sent, so a verifier computes it over the raw request body.
 */
export function canonicalWebhookSigningInput(
  timestamp: string,
  eventId: string,
  body: Uint8Array,
): string {
  if (!/^[^\r\n]+$/.test(timestamp) || !/^[^\r\n]+$/.test(eventId)) {
    throw new Error('the webhook timestamp and event id must be single-line values')
  }
  return [WEBHOOK_SIGNING_CONTEXT, timestamp, eventId, sha256Hex(body)].join('\n')
}

/** Computes `v1=<hex>` for one request. The caller never logs the secret. */
export function signWebhookRequest(
  secret: string,
  timestamp: string,
  eventId: string,
  body: Uint8Array,
): string {
  const canonical = canonicalWebhookSigningInput(timestamp, eventId, body)
  const signature = createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')
  return `${WEBHOOK_SIGNATURE_VERSION}=${signature}`
}

/** Inputs of a subscriber-side signature check. */
export interface VerifyWebhookSignatureInput {
  readonly secret: string
  readonly timestamp: string
  readonly eventId: string
  readonly body: Uint8Array
  /** The whole header value, including the `v1=` prefix. */
  readonly signature: string
}

const SIGNATURE_PATTERN = new RegExp(`^${WEBHOOK_SIGNATURE_VERSION}=([0-9a-f]{64})$`)

/**
 * Constant-time verification of a delivered request. This is the reference
 * implementation subscribers can mirror, and the fixed test vector in
 * `delivery.test.ts` pins it. A malformed header or a different body returns
 * `false` rather than throwing.
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
  const match = SIGNATURE_PATTERN.exec(input.signature)
  if (match === null) {
    return false
  }
  let expected: string
  try {
    expected = signWebhookRequest(input.secret, input.timestamp, input.eventId, input.body).slice(
      WEBHOOK_SIGNATURE_VERSION.length + 1,
    )
  } catch {
    return false
  }
  const presented = Buffer.from(match[1] ?? '', 'utf8')
  const computed = Buffer.from(expected, 'utf8')
  return presented.length === computed.length && timingSafeEqual(presented, computed)
}

function deliveryFailureFromSubscriptionError(error: unknown): WebhookDeliveryFailureReason | null {
  if (!isSubscriptionError(error)) {
    return null
  }
  if (error.code === 'verification_failed' && error.reason === 'blocked_target') {
    return 'blocked_target'
  }
  if (error.code === 'callback_unreachable') {
    const reason = error.reason as SubscriptionCallbackUnreachableReason | undefined
    if (reason === 'timeout') {
      return 'timeout'
    }
    if (reason === 'dns_failure') {
      return 'dns_failure'
    }
    return 'network_failure'
  }
  return null
}

/** One queued subscription attempt produced by a committed publication. */
interface DeliveryJob {
  readonly event: PublicationEvent
  readonly body: Uint8Array
  readonly subscriptionId: string
}

/** One-attempt delivery component shared by the publication route. */
export class WebhookDeliveryService {
  private readonly store: SubscriptionStore
  private readonly signingKey: Buffer | null
  private readonly keyId: string | null
  private readonly now: () => string
  private readonly allowLoopbackHttp: boolean
  private readonly maxCallbackUrlLength: number
  private readonly resolveCallbackHostname: CallbackHostResolver | undefined
  private readonly transport: Http1Transport
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly maxConcurrency: number
  private readonly maxPendingDeliveries: number
  private readonly onResult: ((result: WebhookDeliveryResult) => void) | undefined
  private readonly queue: DeliveryJob[] = []
  private readonly idleWaiters: (() => void)[] = []
  private inFlight = 0

  constructor(options: WebhookDeliveryOptions) {
    this.store = new SubscriptionStore(options.database)
    this.signingKey = options.signingKey
    this.keyId = this.signingKey === null ? null : webhookSigningKeyId(this.signingKey)
    this.now = options.now ?? (() => new Date().toISOString())
    this.allowLoopbackHttp = options.allowLoopbackHttp ?? false
    this.maxCallbackUrlLength = options.maxCallbackUrlLength ?? DEFAULT_MAX_CALLBACK_URL_LENGTH
    this.resolveCallbackHostname = options.resolveCallbackHostname
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_WEBHOOK_RESPONSE_BYTES
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_WEBHOOK_DELIVERY_CONCURRENCY
    this.maxPendingDeliveries =
      options.maxPendingDeliveries ?? DEFAULT_MAX_PENDING_WEBHOOK_DELIVERIES
    this.onResult = options.onResult
    this.transport = options.transport ?? createHttp1Transport()
    for (const [name, value] of [
      ['timeoutMs', this.timeoutMs],
      ['maxResponseBytes', this.maxResponseBytes],
      ['maxConcurrency', this.maxConcurrency],
      ['maxPendingDeliveries', this.maxPendingDeliveries],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`webhook delivery ${name} must be a positive integer`)
      }
    }
  }

  /** True when a deployment key is configured and delivery can happen at all. */
  get enabled(): boolean {
    return this.signingKey !== null
  }

  /**
   * Enqueues one attempt per delivery-eligible subscription and returns
   * immediately, so the publication response never waits on subscriber
   * callbacks. A global in-flight cap bounds concurrent outbound requests; the
   * in-memory queue is bounded too, and attempts beyond it are dropped with a
   * count-only warning. Nothing is persisted, so queued work is lost on a
   * restart (#120).
   */
  dispatchPublicationEvent(event: PublicationEvent): void {
    const keyId = this.keyId
    if (this.signingKey === null || keyId === null || event.type !== PUBLICATION_EVENT_TYPE) {
      return
    }
    const body = buildWebhookNotificationBody(event)
    const subscriptions = this.store.listDeliveryEligibleByRulebook(event.rulebookId, keyId)
    let dropped = 0
    for (const subscription of subscriptions) {
      if (this.queue.length >= this.maxPendingDeliveries) {
        dropped += 1
        continue
      }
      this.queue.push({ event, body, subscriptionId: subscription.id })
    }
    if (dropped > 0) {
      console.warn(`webhook delivery queue full; dropped ${String(dropped)} attempts`)
    }
    this.pump()
  }

  /** Resolves once no queued attempt remains and no attempt is in flight. */
  whenIdle(): Promise<void> {
    if (this.queue.length === 0 && this.inFlight === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve)
    })
  }

  private pump(): void {
    while (this.inFlight < this.maxConcurrency && this.queue.length > 0) {
      const job = this.queue.shift()
      if (job === undefined) {
        return
      }
      this.inFlight += 1
      void this.runJob(job).finally(() => {
        this.inFlight -= 1
        this.pump()
        this.resolveIdleWaitersIfIdle()
      })
    }
  }

  private async runJob(job: DeliveryJob): Promise<void> {
    let result: WebhookDeliveryResult
    try {
      result = await this.deliverOne(job.event, job.body, job.subscriptionId)
    } catch {
      result = {
        subscriptionId: job.subscriptionId,
        delivered: false,
        reason: 'network_failure',
      }
    }
    try {
      this.onResult?.(result)
    } catch {
      // An observer must not break the dispatcher; results are diagnostics only.
    }
  }

  private resolveIdleWaitersIfIdle(): void {
    if (this.queue.length !== 0 || this.inFlight !== 0) {
      return
    }
    for (const resolve of this.idleWaiters.splice(0)) {
      resolve()
    }
  }

  /**
   * Delivers one stored publication event to every delivery-eligible
   * subscription of its rulebook. Each subscription gets exactly one attempt.
   * A missing deployment key is a safe no-op; per-subscription failures are
   * returned as typed results and never abort the other attempts.
   */
  async deliverPublicationEvent(
    event: PublicationEvent,
  ): Promise<readonly WebhookDeliveryResult[]> {
    const keyId = this.keyId
    if (this.signingKey === null || keyId === null || event.type !== PUBLICATION_EVENT_TYPE) {
      return []
    }
    const body = buildWebhookNotificationBody(event)
    const subscriptions = this.store.listDeliveryEligibleByRulebook(event.rulebookId, keyId)
    if (subscriptions.length === 0) {
      return []
    }

    const results: (WebhookDeliveryResult | undefined)[] = Array.from(
      { length: subscriptions.length },
      (): WebhookDeliveryResult | undefined => undefined,
    )
    let next = 0
    const workerCount = Math.min(this.maxConcurrency, subscriptions.length)
    const workers: Promise<void>[] = []
    for (let worker = 0; worker < workerCount; worker += 1) {
      workers.push(
        (async () => {
          for (;;) {
            const index = next
            next += 1
            if (index >= subscriptions.length) {
              return
            }
            const subscription = subscriptions[index]
            if (subscription === undefined) {
              return
            }
            results[index] = await this.deliverOne(event, body, subscription.id)
          }
        })(),
      )
    }
    await Promise.all(workers)
    return results.filter((result): result is WebhookDeliveryResult => result !== undefined)
  }

  private async deliverOne(
    event: PublicationEvent,
    body: Uint8Array,
    subscriptionId: string,
  ): Promise<WebhookDeliveryResult> {
    // Re-read immediately before the attempt: a subscription revoked after the
    // listing must not be contacted, and a still-pending row is never eligible.
    const record = this.store.get(subscriptionId)
    if (
      record === null ||
      record.state !== 'active' ||
      record.verifiedAt === null ||
      record.webhookKeyId === null ||
      record.webhookKeyId !== this.keyId
    ) {
      return { subscriptionId, delivered: false, reason: 'subscription_not_eligible' }
    }
    const signingKey = this.signingKey
    if (signingKey === null) {
      return { subscriptionId, delivered: false, reason: 'subscription_not_eligible' }
    }

    const timestamp = this.now()
    const secret = deriveSubscriptionWebhookSecret(signingKey, record.id)
    const signature = signWebhookRequest(secret, timestamp, event.id, body)
    // The signed timestamp comes from the injectable wall clock; the attempt
    // budget is measured on the monotonic clock so a fixed test clock cannot
    // freeze the deadline.
    const deadlineMs = performance.now() + this.timeoutMs

    let target: ResolvedCallbackTarget
    try {
      target = await this.resolveTarget(record.callbackUrl, deadlineMs)
    } catch (error) {
      return this.failed(subscriptionId, error)
    }

    let response: Http1Response
    try {
      const remaining = deadlineMs - performance.now()
      if (remaining <= 0) {
        return { subscriptionId, delivered: false, reason: 'timeout' }
      }
      response = await this.transport({
        url: target.url,
        hostname: target.hostname,
        address: target.address,
        family: target.family,
        port: target.port,
        timeoutMs: remaining,
        maxBytes: this.maxResponseBytes,
        method: 'POST',
        body,
        contentType: WEBHOOK_CONTENT_TYPE,
        accept: 'application/json',
        headers: {
          [WEBHOOK_EVENT_ID_HEADER]: event.id,
          [WEBHOOK_EVENT_TYPE_HEADER]: event.type,
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
          [WEBHOOK_SIGNATURE_HEADER]: signature,
        },
      })
    } catch (error) {
      return this.failed(subscriptionId, error)
    }

    if (response.status >= 200 && response.status < 300) {
      return { subscriptionId, delivered: true, status: response.status }
    }
    if (response.status >= 300 && response.status < 400) {
      return {
        subscriptionId,
        delivered: false,
        status: response.status,
        reason: 'redirect_not_followed',
      }
    }
    return {
      subscriptionId,
      delivered: false,
      status: response.status,
      reason: 'unexpected_status',
    }
  }

  private async resolveTarget(
    callbackUrl: string,
    deadlineMs: number,
  ): Promise<ResolvedCallbackTarget> {
    const remaining = deadlineMs - performance.now()
    if (remaining <= 0) {
      throw subscriptionCallbackUnreachable(
        'timeout',
        'The callback delivery request exceeded its time budget.',
      )
    }
    return resolveSubscriptionCallbackTarget(callbackUrl, {
      maxCallbackUrlLength: this.maxCallbackUrlLength,
      allowLoopbackHttp: this.allowLoopbackHttp,
      timeoutMs: remaining,
      ...(this.resolveCallbackHostname === undefined
        ? {}
        : { resolver: this.resolveCallbackHostname }),
    })
  }

  private failed(subscriptionId: string, error: unknown): WebhookDeliveryResult {
    if (isHttp1TransportError(error)) {
      if (error.code === 'timeout') {
        return { subscriptionId, delivered: false, reason: 'timeout' }
      }
      if (error.code === 'response_too_large') {
        return { subscriptionId, delivered: false, reason: 'response_too_large' }
      }
      return { subscriptionId, delivered: false, reason: 'network_failure' }
    }
    const reason = deliveryFailureFromSubscriptionError(error)
    if (reason !== null) {
      return { subscriptionId, delivered: false, reason }
    }
    return { subscriptionId, delivered: false, reason: 'network_failure' }
  }
}
