import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import type { AdminSession, AuthApi } from './auth'
import { SessionProvider, useSession } from './session'

const PROVIDER = {
  id: 'provider-admin',
  name: 'E2E Administrator',
  createdAt: '2026-01-01T00:00:00.000Z',
}
const SESSION: AdminSession = {
  provider: PROVIDER,
  expiresAt: '2026-01-01T08:00:00.000Z',
  csrfToken: 'csrf-token-value',
}

function fakeApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    getSession: async () => null,
    login: async () => SESSION,
    logout: async () => undefined,
    ...overrides,
  }
}

function Probe() {
  const session = useSession()
  return (
    <div>
      <p data-testid="status">{session.status}</p>
      <p data-testid="provider">{session.session?.provider.name ?? 'none'}</p>
      <button
        type="button"
        onClick={() => {
          void session.signIn('admin', 'secret')
        }}
      >
        Sign in
      </button>
      <button
        type="button"
        onClick={() => {
          void session.signOut()
        }}
      >
        Sign out
      </button>
    </div>
  )
}

describe('SessionProvider', () => {
  test('restores an authenticated session from GET /api/v1/auth/me', async () => {
    render(
      <SessionProvider api={fakeApi({ getSession: async () => SESSION })}>
        <Probe />
      </SessionProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    expect(screen.getByTestId('provider')).toHaveTextContent('E2E Administrator')
  })

  test('settles on the anonymous state for a 401 session or a failed request', async () => {
    const { unmount } = render(
      <SessionProvider api={fakeApi({ getSession: async () => null })}>
        <Probe />
      </SessionProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'))
    unmount()

    render(
      <SessionProvider
        api={fakeApi({
          getSession: async () => {
            throw new Error('session endpoint unavailable')
          },
        })}
      >
        <Probe />
      </SessionProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'))
  })

  test('signs in, then signs out through the API', async () => {
    const user = userEvent.setup()
    const logout = vi.fn(async () => undefined)
    render(
      <SessionProvider api={fakeApi({ logout })}>
        <Probe />
      </SessionProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'))

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    expect(screen.getByTestId('provider')).toHaveTextContent('E2E Administrator')

    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'))
    expect(logout).toHaveBeenCalledTimes(1)
    expect(logout).toHaveBeenCalledWith('csrf-token-value')
    expect(screen.getByTestId('provider')).toHaveTextContent('none')
  })

  test('a slower initial session read cannot overwrite a newer sign-in', async () => {
    const user = userEvent.setup()
    let resolveSession: (session: AdminSession | null) => void = () => undefined
    const api = fakeApi({
      getSession: () =>
        new Promise<AdminSession | null>((resolve) => {
          resolveSession = resolve
        }),
    })
    render(
      <SessionProvider api={api}>
        <Probe />
      </SessionProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))

    act(() => resolveSession(null))

    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
    expect(screen.getByTestId('provider')).toHaveTextContent('E2E Administrator')
  })
})
