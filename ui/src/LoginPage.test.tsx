import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { AdminSession, AuthApi } from './auth'
import { AuthApiError } from './auth'
import { LoginPage } from './LoginPage'
import { SessionProvider } from './session'
import { expectNoA11yViolations } from './test/a11y'

const PROVIDER = {
  id: 'provider-admin',
  name: 'E2E Administrator',
  createdAt: '2026-01-01T00:00:00.000Z',
}
const SESSION: AdminSession = {
  provider: PROVIDER,
  expiresAt: '2026-07-01T08:00:00.000Z',
  csrfToken: 'csrf-token-value',
}

function fakeApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    getSession: vi.fn(async () => null),
    login: vi.fn(async () => SESSION),
    logout: vi.fn(async () => undefined),
    ...overrides,
  }
}

function renderLogin(
  api: AuthApi,
  options: { readonly nextPath?: string | null } = {},
): { readonly navigate: ReturnType<typeof vi.fn> } {
  const navigate = vi.fn()
  render(
    <SessionProvider api={api}>
      <LoginPage onNavigate={navigate} nextPath={options.nextPath ?? null} />
    </SessionProvider>,
  )
  return { navigate }
}

afterEach(() => {
  window.history.replaceState({}, '', '/')
})

describe('LoginPage anonymous form', () => {
  test('asks only for a username and password and never for a bearer token', async () => {
    const api = fakeApi()
    renderLogin(api)

    expect(await screen.findByLabelText('Username')).toBeVisible()
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')

    const inputs = Array.from(document.querySelectorAll('input'))
    expect(inputs).toHaveLength(2)
    expect(inputs.map((input) => input.name)).toEqual(['username', 'password'])
    expect(inputs.some((input) => /token/i.test(input.name))).toBe(false)
    expect(api.login).not.toHaveBeenCalled()
  })

  test('reports missing fields without sending a request', async () => {
    const user = userEvent.setup()
    const api = fakeApi()
    renderLogin(api)

    await user.click(await screen.findByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('Enter your username.')).toBeVisible()
    expect(screen.getByText('Enter your password.')).toBeVisible()
    expect(api.login).not.toHaveBeenCalled()
  })

  test('shows a working state while the request is pending', async () => {
    const user = userEvent.setup()
    let resolveLogin: (session: AdminSession) => void = () => undefined
    const api = fakeApi({
      login: () =>
        new Promise<AdminSession>((resolve) => {
          resolveLogin = resolve
        }),
    })
    const { navigate } = renderLogin(api)

    await user.type(await screen.findByLabelText('Username'), 'admin')
    await user.type(screen.getByLabelText('Password'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    const button = await screen.findByRole('button', { name: 'Signing in…' })
    expect(button).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Verifying your credentials…')
    expect(navigate).not.toHaveBeenCalled()

    act(() => resolveLogin(SESSION))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
  })

  test('surfaces the API safe message for rejected credentials', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      login: async () => {
        throw new AuthApiError('Invalid username or password.', 401)
      },
    })
    const { navigate } = renderLogin(api)

    await user.type(await screen.findByLabelText('Username'), 'admin')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password.')
    expect(navigate).not.toHaveBeenCalled()
  })

  test('returns to a safe intended destination and drops an off-site target', async () => {
    const user = userEvent.setup()
    const api = fakeApi()
    const first = renderLogin(api, { nextPath: '/playground' })

    await user.type(await screen.findByLabelText('Username'), 'admin')
    await user.type(screen.getByLabelText('Password'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(first.navigate).toHaveBeenCalledWith('/playground'))
    expect(api.login).toHaveBeenCalledWith({ username: 'admin', password: 'secret' })
  })

  test('does not follow an off-site next target', async () => {
    const user = userEvent.setup()
    const api = fakeApi()
    const { navigate } = renderLogin(api, { nextPath: 'https://evil.example/steal' })

    await user.type(await screen.findByLabelText('Username'), 'admin')
    await user.type(screen.getByLabelText('Password'), 'secret')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
  })

  test('has no detectable accessibility violations', async () => {
    renderLogin(fakeApi())

    await screen.findByLabelText('Username')
    await expectNoA11yViolations(document.body)
  })
})

describe('LoginPage authenticated state', () => {
  test('shows the provider identity and can continue to the intended view', async () => {
    renderLogin(fakeApi({ getSession: async () => SESSION }), { nextPath: '/playground' })

    const card = await screen.findByRole('region', { name: 'Signed in' })
    expect(within(card).getByText(/You are signed in as/)).toHaveTextContent('E2E Administrator')
    expect(within(card).getByRole('link', { name: 'Continue' })).toHaveAttribute(
      'href',
      '/playground',
    )
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
  })

  test('logs out and returns to the anonymous form', async () => {
    const user = userEvent.setup()
    const logout = vi.fn(async () => undefined)
    renderLogin(fakeApi({ getSession: async () => SESSION, logout }))

    const card = await screen.findByRole('region', { name: 'Signed in' })
    await user.click(within(card).getByRole('button', { name: 'Log out' }))

    expect(await screen.findByLabelText('Username')).toBeVisible()
    expect(logout).toHaveBeenCalledTimes(1)
    expect(logout).toHaveBeenCalledWith('csrf-token-value')
  })

  test('keeps the session and reports a failed sign-out', async () => {
    const user = userEvent.setup()
    renderLogin(
      fakeApi({
        getSession: async () => SESSION,
        logout: async () => {
          throw new Error('network down')
        },
      }),
    )

    const card = await screen.findByRole('region', { name: 'Signed in' })
    await user.click(within(card).getByRole('button', { name: 'Log out' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-out failed. Try again.')
    expect(screen.getByRole('region', { name: 'Signed in' })).toBeVisible()
  })
})
