import type { ReactNode } from 'react'

import { AppLink, CAPTURES_PATH, CATALOG_PATH, PLAYGROUND_PATH } from '../router'

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
}

/**
 * The shared header with the two Phase 1 product views. The long-form section
 * label names the current view; the short navigation labels stay distinct from
 * the breadcrumb links so assistive technology can address each destination.
 */
export function SiteHeader({ section, onNavigate }: SiteHeaderProps) {
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
