// Public surface of the anonymous webhook-subscription module (issue #117).
//
// See docs/api.md §3.15 and docs/security.md for the registration, management,
// callback-URL and abuse-control rules. This module stores subscriptions only;
// it performs no outbound request and delivers no event. Callback verification
// and delivery are separate later slices.

export { SubscriptionService, MAX_SUBSCRIPTION_ID_LENGTH } from './service'

export {
  DEFAULT_MAX_CALLBACK_URL_LENGTH,
  DEFAULT_MAX_RATE_LIMIT_KEYS,
  DEFAULT_MAX_SUBSCRIPTIONS_PER_RULEBOOK,
  DEFAULT_REGISTRATIONS_PER_CLIENT,
  DEFAULT_REGISTRATION_WINDOW_MS,
  DEFAULT_SUBSCRIPTION_LIMITS,
  resolveSubscriptionLimits,
} from './limits'

export {
  generateSubscriptionManagementToken,
  hashSubscriptionManagementToken,
  isSubscriptionManagementTokenHash,
  subscriptionManagementTokenMatches,
  MAX_SUBSCRIPTION_MANAGEMENT_TOKEN_LENGTH,
  SUBSCRIPTION_MANAGEMENT_TOKEN_LENGTH,
  SUBSCRIPTION_MANAGEMENT_TOKEN_PREFIX,
} from './token'

export {
  normalizeSubscriptionClientKey,
  SubscriptionRegistrationLimiter,
  type RegistrationQuotaExceeded,
  type RegistrationReservation,
  type ReservedRegistration,
  type SubscriptionRegistrationLimiterOptions,
} from './rate-limit'

export {
  isSubscriptionError,
  subscriptionConflict,
  subscriptionNotFound,
  subscriptionRateLimited,
  subscriptionUnauthorized,
  SubscriptionError,
  type SubscriptionErrorCode,
} from './errors'

export { parseSubscriptionCallbackUrl, type CallbackUrlOptions } from './url'

export {
  SUBSCRIPTION_STATES,
  type RegisterSubscriptionInput,
  type RegisteredSubscription,
  type Subscription,
  type SubscriptionLimitOverrides,
  type SubscriptionLimits,
  type SubscriptionRecord,
  type SubscriptionRulebook,
  type SubscriptionRulebookSource,
  type SubscriptionServiceOptions,
  type SubscriptionState,
  type SubscriptionVersion,
} from './types'
