// Typed subscription failures.
//
// The service throws these instead of generic errors so the HTTP layer maps
// stable codes to stable statuses without inspecting messages. Messages never
// contain a management token, its hash or a raw request payload, and an unknown
// subscription id is indistinguishable from a wrong token.

export type SubscriptionErrorCode =
  'invalid_input' | 'unauthorized' | 'not_found' | 'conflict' | 'rate_limited'

export class SubscriptionError extends Error {
  readonly code: SubscriptionErrorCode
  /** Seconds until a rate-limited client may retry; only set for `rate_limited`. */
  readonly retryAfterSeconds: number | undefined

  constructor(
    code: SubscriptionErrorCode,
    message: string,
    options: { readonly retryAfterSeconds?: number } = {},
  ) {
    super(message)
    this.name = 'SubscriptionError'
    this.code = code
    this.retryAfterSeconds = options.retryAfterSeconds
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

export function isSubscriptionError(error: unknown): error is SubscriptionError {
  return error instanceof SubscriptionError
}
