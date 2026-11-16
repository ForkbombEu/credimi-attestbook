// Public surface of the anonymous webhook-subscription module (#117, #118,
// #119).
//
// See docs/api.md §3.15 and docs/security.md for the registration, management,
// callback-URL, verification and delivery rules. Registration and management
// perform no outbound request; an explicit, management-token authenticated
// verification initiation performs the handshake, and a publication dispatches
// one signed delivery attempt to each active, verified subscription.

export { SubscriptionService, MAX_SUBSCRIPTION_ID_LENGTH } from './service'

export {
  buildWebhookNotificationBody,
  canonicalWebhookSigningInput,
  DEFAULT_MAX_WEBHOOK_RESPONSE_BYTES,
  DEFAULT_WEBHOOK_DELIVERY_CONCURRENCY,
  DEFAULT_WEBHOOK_DELIVERY_TIMEOUT_MS,
  deriveSubscriptionWebhookSecret,
  isSubscriptionWebhookSecret,
  MAX_WEBHOOK_NOTIFICATION_BYTES,
  parseWebhookSigningKey,
  signWebhookRequest,
  verifyWebhookSignature,
  WEBHOOK_CONTENT_TYPE,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPE_HEADER,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TIMESTAMP_HEADER,
  WebhookDeliveryService,
  type VerifyWebhookSignatureInput,
  type WebhookDeliveryFailureReason,
  type WebhookDeliveryOptions,
  type WebhookDeliveryResult,
} from './delivery'

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
