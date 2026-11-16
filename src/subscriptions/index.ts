// Public surface of the anonymous webhook-subscription module (#117, #118).
//
// See docs/api.md §3.15 and docs/security.md for the registration, management,
// callback-URL, verification and abuse-control rules. Registration and
// management perform no outbound request; only an explicit, management-token
// authenticated verification initiation contacts the callback endpoint, and
// nothing is delivered by this slice.

export { SubscriptionService, MAX_SUBSCRIPTION_ID_LENGTH } from './service'

export {
  DEFAULT_CHALLENGE_TTL_MS,
  DEFAULT_MAX_CALLBACK_URL_LENGTH,
  DEFAULT_MAX_RATE_LIMIT_KEYS,
  DEFAULT_MAX_SUBSCRIPTIONS_PER_RULEBOOK,
  DEFAULT_MAX_VERIFICATION_RESPONSE_BYTES,
  DEFAULT_REGISTRATIONS_PER_CLIENT,
  DEFAULT_REGISTRATION_WINDOW_MS,
  DEFAULT_SUBSCRIPTION_LIMITS,
  DEFAULT_VERIFICATIONS_PER_SUBSCRIPTION,
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  DEFAULT_VERIFICATION_WINDOW_MS,
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
  subscriptionCallbackUnreachable,
  subscriptionConflict,
  subscriptionNotFound,
  subscriptionRateLimited,
  subscriptionUnauthorized,
  subscriptionVerificationFailed,
  SubscriptionError,
  type SubscriptionCallbackUnreachableReason,
  type SubscriptionErrorCode,
  type SubscriptionVerificationFailureReason,
} from './errors'

export { parseSubscriptionCallbackUrl, type CallbackUrlOptions } from './url'

export {
  createSubscriptionVerificationTransport,
  generateSubscriptionChallenge,
  hashSubscriptionChallenge,
  isSubscriptionChallengeHash,
  resolveSubscriptionCallbackTarget,
  subscriptionChallengeMatches,
  validateSubscriptionVerificationResponse,
  MAX_SUBSCRIPTION_CHALLENGE_LENGTH,
  SUBSCRIPTION_CHALLENGE_LENGTH,
  SUBSCRIPTION_CHALLENGE_PREFIX,
  SUBSCRIPTION_VERIFICATION_TYPE,
  systemCallbackHostResolver,
  type CallbackHostAddress,
  type CallbackHostResolver,
  type ResolveCallbackTargetOptions,
  type ResolvedCallbackTarget,
  type VerificationAcknowledgementOptions,
} from './verification'

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
