// Typed subscription failures.
//
// The service throws these instead of generic errors so the HTTP layer maps
// stable codes to stable statuses without inspecting messages. Messages never
// contain a management token, its hash or a raw request payload, and an unknown
// subscription id is indistinguishable from a wrong token.

export type SubscriptionErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'verification_failed'
  | 'callback_unreachable'

/**
 * Typed reasons a callback failed to prove control of its endpoint. They are
 * safe to return to the subscriber and never contain the challenge itself.
 */
export type SubscriptionVerificationFailureReason =
  | 'blocked_target'
  | 'challenge_mismatch'
  | 'expired_challenge'
  | 'invalid_response'
  | 'redirect_not_followed'
  | 'response_too_large'
  | 'unexpected_status'

/** Typed reasons the callback endpoint could not be reached at all. */
export type SubscriptionCallbackUnreachableReason = 'dns_failure' | 'network_failure' | 'timeout'

export class SubscriptionError extends Error {
  readonly code: SubscriptionErrorCode
  /** Seconds until a rate-limited client may retry; only set for `rate_limited`. */
  readonly retryAfterSeconds: number | undefined
  /** Machine-readable verification reason; only set for the verification codes. */
  readonly reason: string | undefined

  constructor(
    code: SubscriptionErrorCode,
    message: string,
    options: { readonly retryAfterSeconds?: number; readonly reason?: string } = {},
  ) {
    super(message)
    this.name = 'SubscriptionError'
    this.code = code
    this.retryAfterSeconds = options.retryAfterSeconds
    this.reason = options.reason
  }
}

export function invalidSubscriptionInput(message: string): SubscriptionError {
  return new SubscriptionError('invalid_input', message)
}

export function subscriptionUnauthorized(
  message = 'A valid subscription management token is required.',
): SubscriptionError {
  return new SubscriptionError('unauthorized', message)
}

export function subscriptionNotFound(
  message = 'The requested subscription does not exist.',
): SubscriptionError {
  return new SubscriptionError('not_found', message)
}

export function subscriptionConflict(message: string): SubscriptionError {
  return new SubscriptionError('conflict', message)
}

export function subscriptionRateLimited(retryAfterSeconds: number): SubscriptionError {
  return new SubscriptionError(
    'rate_limited',
    'Too many subscription registrations from this client. Try again later.',
    { retryAfterSeconds },
  )
}

/**
 * A callback answered, but did not prove control of the endpoint: wrong
 * challenge, wrong shape, wrong status, an expired challenge or a refused
 * target. The record stays `pending` and never becomes delivery eligible.
 */
export function subscriptionVerificationFailed(
  reason: SubscriptionVerificationFailureReason,
  message: string,
): SubscriptionError {
  return new SubscriptionError('verification_failed', message, { reason })
}

/**
 * A callback could not be reached: the hostname did not resolve to a public
 * address, the connection failed or the bounded request timed out. The record
 * stays `pending`.
 */
export function subscriptionCallbackUnreachable(
  reason: SubscriptionCallbackUnreachableReason,
  message: string,
): SubscriptionError {
  return new SubscriptionError('callback_unreachable', message, { reason })
}

export function isSubscriptionError(error: unknown): error is SubscriptionError {
  return error instanceof SubscriptionError
}
