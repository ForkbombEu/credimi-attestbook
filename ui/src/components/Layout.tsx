import { useState, type ReactNode } from 'react'

import { currentPath, loginPath } from '../auth'
import { AppLink, CAPTURES_PATH, CATALOG_PATH, PLAYGROUND_PATH } from '../router'
import { useSession } from '../session'

const CREDIMI_URL = 'https://credimi.io'

export function SkipLink({
  href,
  children,
}: {
  readonly href: string
  readonly children: ReactNode
}) {
  return (
    <a className="skip-link" href={href}>
      {children}
    </a>
  )
}

/**
 * The fixed Credimi Extras banner (DESIGN.md §13). The top strip sits above the
 * topbar; the footer strip closes the indigo footer. Only the trailing word or
 * wordmark is a link.
 */
function CredimiExtrasBanner({ variant }: { readonly variant?: 'footer' }) {
  const footer = variant === 'footer'
  const content = (
    <p>
      {footer ? null : (
        <img
          className="credimi-banner__mark"
          src="/brand/logos/credimi_logo.svg"
          alt=""
          width={16}
          height={16}
        />
      )}
      This app is part of <strong>Credimi Extras</strong>. Automate all your EUDI testing with{' '}
      {footer ? (
        <a href={CREDIMI_URL} target="_blank" rel="noopener noreferrer">
          <img
            className="credimi-banner__wordmark"
            src="/brand/logos/credimi_logo-transp_white.svg"
            alt="Credimi"
            width={77}
            height={16}
          />
        </a>
      ) : (
        <a href={CREDIMI_URL} target="_blank" rel="noopener noreferrer">
          Credimi
        </a>
      )}
    </p>
  )

  if (footer) {
    return <div className="credimi-banner credimi-banner--footer">{content}</div>
  }
  return (
    <aside className="credimi-banner" aria-label="Credimi Extras">
      {content}
    </aside>
  )
}

interface SiteHeaderProps {
  readonly section: string
  readonly onNavigate: (path: string) => void
  /** The login page hides the anonymous sign-in link that would target itself. */
  readonly showLoginLink?: boolean
}

/**
 * Session controls in the shared topbar (issue #90). An anonymous visitor gets
 * a sign-in link that preserves the current path; an authenticated
 * administrator sees the provider identity and a sign-out action. The session
 * endpoint is authoritative, so a missing or expired cookie renders anonymous
 * instead of claiming an identity.
 */
function SessionControls({
  onNavigate,
  showLoginLink,
}: {
  readonly onNavigate: (path: string) => void
  readonly showLoginLink: boolean
}) {
  const session = useSession()
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  if (session.status === 'loading') {
    // The login page renders its own session status in the card; elsewhere the
    // topbar says what it is waiting for.
    return showLoginLink ? (
      <div className="site-session" role="group" aria-label="Administrator session">
        <span className="site-session__status">Checking session…</span>
      </div>
    ) : null
  }

  if (session.status === 'authenticated' && session.session !== null) {
    const providerName = session.session.provider.name
    const handleSignOut = async () => {
      if (signingOut) {
        return
      }
      setSignOutError(null)
      setSigningOut(true)
      try {
        await session.signOut()
      } catch {
        setSignOutError('Sign-out failed.')
      } finally {
        setSigningOut(false)
      }
    }

    return (
      <div className="site-session" role="group" aria-label="Administrator session">
        <span className="site-session__identity" title={`Signed in as ${providerName}`}>
          <span className="site-session__label">Signed in:</span>
          <span className="site-session__provider">{providerName}</span>
        </span>
        <button
          className="button button--ghost button--small"
          type="button"
          disabled={signingOut}
          onClick={() => {
            void handleSignOut()
          }}
        >
          {signingOut ? 'Signing out…' : 'Log out'}
        </button>
        {signOutError === null ? null : (
          <span className="site-session__error" role="alert">
            {signOutError}
          </span>
        )}
      </div>
    )
  }

  if (!showLoginLink) {
    return null
  }

  return (
    <div className="site-session" role="group" aria-label="Administrator session">
      <AppLink
        className="button button--ghost button--small"
        href={loginPath(currentPath())}
        onNavigate={onNavigate}
      >
        Log in
      </AppLink>
    </div>
  )
}

/**
 * The shared header with the product views. The long-form section label names
 * the current view; the short navigation labels stay distinct from the
 * breadcrumb links so assistive technology can address each destination.
 */
export function SiteHeader({ section, onNavigate, showLoginLink = true }: SiteHeaderProps) {
  return (
    <>
      <CredimiExtrasBanner />
      <header className="site-header">
        <div className="site-header__inner">
          <span className="wordmark">
            <img
              className="wordmark__logo"
              src="/brand/logos/credimi_logo-transp.svg"
              alt="Credimi"
              width={106}
              height={22}
            />
            <span className="wordmark__divider" aria-hidden="true" />
            <span className="wordmark__product">AttestBook</span>
          </span>
          <nav className="site-nav" aria-label="Primary">
            <AppLink
              href={CATALOG_PATH}
              onNavigate={onNavigate}
              {...(section === 'Rulebook catalog' || section === 'Rulebook detail'
                ? { 'aria-current': 'page' as const }
                : {})}
            >
              Catalog
            </AppLink>
            <AppLink
              href={PLAYGROUND_PATH}
              onNavigate={onNavigate}
              {...(section === 'Credential playground' ? { 'aria-current': 'page' as const } : {})}
            >
              Validation playground
            </AppLink>
            <AppLink
              href={CAPTURES_PATH}
              onNavigate={onNavigate}
              {...(section === 'Capture explorer' || section === 'Capture detail'
                ? { 'aria-current': 'page' as const }
                : {})}
            >
              Capture explorer
            </AppLink>
          </nav>
          <SessionControls onNavigate={onNavigate} showLoginLink={showLoginLink} />
          <span className="site-header__section">{section}</span>
        </div>
      </header>
    </>
  )
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p>
          Structural credential validation runs per credential against a pinned rulebook version.
          AttestBook does not test or claim trust, interoperability or standards conformance.
        </p>
      </div>
      <CredimiExtrasBanner variant="footer" />
    </footer>
  )
}
