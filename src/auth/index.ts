// Public surface of the administrator browser authentication module (issue #88).
//
// See docs/security.md §2.1 for the session model and docs/api.md §3.11 for the
// HTTP contract. Provider bearer authentication stays in `src/registry/`.

export {
  AdminAuth,
  type AdminAuthOptions,
  type AdminLoginInput,
  type AdminLoginOutcome,
  type AdminProviderSource,
  type AuthenticatedAdminSession,
} from './admin-auth'

export {
  ADMIN_PASSWORD_HASH_ENV,
  ADMIN_PROVIDER_ID_ENV,
  ADMIN_USERNAME_ENV,
  loadAdminLoginConfig,
  type AdminLoginConfig,
  type ConfiguredAdminLogin,
  type DisabledAdminLogin,
  type InvalidAdminLogin,
} from './config'

export {
  isSameOriginRequest,
  requestOrigin,
  requestProtocol,
  requestUsesHttps,
  type RequestOriginContext,
} from './origin'

export {
  MAX_ADMIN_PASSWORD_LENGTH,
  MAX_ADMIN_USERNAME_LENGTH,
  constantTimeEquals,
  isStrongArgon2idHash,
  parseArgon2idHash,
  verifyArgon2idPassword,
  type Argon2idParameters,
} from './password'

export {
  DEFAULT_ADMIN_LOGIN_MAX_CLIENT_FAILURES,
  DEFAULT_ADMIN_LOGIN_MAX_FAILURES,
  DEFAULT_ADMIN_LOGIN_MAX_KEYS,
  DEFAULT_ADMIN_LOGIN_WINDOW_MS,
  LoginRateLimiter,
  type LoginRateLimiterOptions,
} from './rate-limit'

export {
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_ID_BYTES,
  ADMIN_SESSION_TTL_MS,
  MAX_ADMIN_SESSION_ID_LENGTH,
  adminAuthFingerprint,
  generateAdminSessionId,
  hashAdminSessionId,
} from './session'
