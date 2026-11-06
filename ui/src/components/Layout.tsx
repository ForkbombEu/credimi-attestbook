import type { ReactNode } from 'react'

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

export function SiteHeader({ section }: { readonly section: string }) {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <span className="wordmark">
          <span className="wordmark__mark" aria-hidden="true">
            A
          </span>
          AttestBook
        </span>
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
