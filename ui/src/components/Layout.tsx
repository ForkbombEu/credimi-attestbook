import type { ReactNode } from 'react'

import { AppLink, CAPTURES_PATH, CATALOG_PATH, PLAYGROUND_PATH } from '../router'

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
    <header className="site-header">
      <div className="site-header__inner">
        <span className="wordmark">
          <span className="wordmark__mark" aria-hidden="true">
            A
          </span>
          AttestBook
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
  )
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>
        Structural credential validation runs per credential against a pinned rulebook version.
        AttestBook does not test or claim trust, interoperability or standards conformance.
      </p>
    </footer>
  )
}
