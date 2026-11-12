import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { AdminSession, AuthApi } from '../auth'
import { SessionProvider } from '../session'
import { expectNoA11yViolations } from '../test/a11y'
import { SiteFooter, SiteHeader } from './Layout'

const noop = () => {}

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
    getSession: async () => null,
    login: async () => SESSION,
    logout: async () => undefined,
    ...overrides,
  }
}

afterEach(() => {
  window.history.replaceState({}, '', '/')
})

describe('Credimi Extras chrome', () => {
  test('renders the top banner before the header and links only the trailing word', () => {
    render(<SiteHeader section="Rulebook catalog" onNavigate={noop} />)

    const strip = screen.getByRole('complementary', { name: 'Credimi Extras' })
    expect(strip.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'This app is part of Credimi Extras. Automate all your EUDI testing with Credimi',
    )

    const links = within(strip).getAllByRole('link')
    expect(links).toHaveLength(1)
    const link = links[0]!
    expect(link).toHaveTextContent('Credimi')
    expect(link).toHaveAttribute('href', 'https://credimi.io')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')

    const header = screen.getByRole('banner')
    expect(strip.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(header).getByRole('img', { name: 'Credimi' })).toHaveAttribute(
      'src',
      '/brand/logos/credimi_logo-transp.svg',
    )
    expect(within(header).getByRole('link', { name: 'Catalog' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  test('renders the footer strip with the wordmark as its only link', () => {
    render(<SiteFooter />)

    const footer = screen.getByRole('contentinfo')
    expect(footer).toHaveTextContent('AttestBook does not test or claim trust')

    const links = within(footer).getAllByRole('link')
    expect(links).toHaveLength(1)
    const link = links[0]!
    expect(link).toHaveAccessibleName('Credimi')
    expect(link).toHaveAttribute('href', 'https://credimi.io')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(within(link).getByRole('img')).toHaveAttribute(
      'src',
      '/brand/logos/credimi_logo-transp_white.svg',
    )
  })

  test('has no detectable accessibility violations', async () => {
    render(
      <>
        <SiteHeader section="Capture explorer" onNavigate={noop} />
        <main />
        <SiteFooter />
      </>,
    )

    await expectNoA11yViolations(document.body)
  })
})

describe('administrator session in the topbar', () => {
  test('links an anonymous visitor to sign in while preserving the current path', async () => {
    window.history.replaceState({}, '', '/playground')
    render(
      <SessionProvider api={fakeApi()}>
        <SiteHeader section="Credential playground" onNavigate={noop} />
      </SessionProvider>,
    )

    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute(
        'href',
        '/login?next=%2Fplayground',
      ),
    )
  })

  test('shows the authenticated provider identity and signs out', async () => {
    const user = userEvent.setup()
    const logout = vi.fn(async () => undefined)
    render(
      <SessionProvider api={fakeApi({ getSession: async () => SESSION, logout })}>
        <SiteHeader section="Rulebook catalog" onNavigate={noop} />
      </SessionProvider>,
    )

    const identity = await screen.findByTitle('Signed in as E2E Administrator')
    expect(identity).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Log out' }))

    await waitFor(() => expect(screen.getByRole('link', { name: 'Log in' })).toBeVisible())
    expect(logout).toHaveBeenCalledTimes(1)
    expect(logout).toHaveBeenCalledWith('csrf-token-value')
    expect(screen.queryByText('E2E Administrator')).not.toBeInTheDocument()
  })

  test('the login page can hide the anonymous sign-in link', async () => {
    render(
      <SessionProvider api={fakeApi()}>
        <SiteHeader section="Administrator login" onNavigate={noop} showLoginLink={false} />
      </SessionProvider>,
    )

    await waitFor(() => expect(screen.queryByText('Checking session…')).not.toBeInTheDocument())
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument()
  })
})
