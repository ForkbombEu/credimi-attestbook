// Fake administrator session controllers for component tests (issue #91).
//
// Components take the `SessionController` explicitly, so a test can render an
// authenticated or anonymous session without a provider or a network call.

import type { AdminSession } from '../auth'
import type { SessionController } from '../session'
import type { Provider } from '../types'

export const TEST_PROVIDER: Provider = {
  id: 'provider-1',
  name: 'Example Issuer',
  createdAt: '2026-01-01T00:00:00.000Z',
}

export const TEST_SESSION: AdminSession = {
  provider: TEST_PROVIDER,
  expiresAt: '2026-01-01T08:00:00.000Z',
  csrfToken: 'csrf-token-value',
}

export function fakeSession(overrides: Partial<SessionController> = {}): SessionController {
  return {
    status: 'authenticated',
    session: TEST_SESSION,
    signIn: () => Promise.resolve(TEST_SESSION),
    signOut: () => Promise.resolve(),
    reload: () => undefined,
    ...overrides,
  }
}

export function anonymousSession(overrides: Partial<SessionController> = {}): SessionController {
  return {
    status: 'anonymous',
    session: null,
    signIn: () => Promise.resolve(TEST_SESSION),
    signOut: () => Promise.resolve(),
    reload: () => undefined,
    ...overrides,
  }
}
