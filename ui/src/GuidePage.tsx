import { useEffect } from 'react'

import { SiteFooter, SiteHeader, SkipLink } from './components/Layout'
import { GuideMarkdown } from './GuideMarkdown'
import { findGuide, GUIDE_DOCUMENTS } from './guide'
import { AppLink, GUIDE_PATH, guidePath } from './router'

interface GuidePageProps {
  readonly onNavigate: (path: string) => void
}

/** Public index of the bundled product guides. It needs no session. */
export function GuideIndexPage({ onNavigate }: GuidePageProps) {
  useEffect(() => {
    document.title = 'Product guide · AttestBook'
  }, [])

  return (
    <div className="app-shell">
      <SkipLink href="#guide-content">Skip to the product guide</SkipLink>

      <SiteHeader section="Product guide" onNavigate={onNavigate} />

      <main className="page" id="main-content">
        <div className="page-heading">
          <p className="eyebrow">Documentation</p>
          <h1>AttestBook product guide</h1>
          <p className="lede">
            Short, task-focused guides for finding rulebooks, validating credentials and reading the
            public product API. Every page is public and bundled with the application.
          </p>
        </div>

        <div id="guide-content" tabIndex={-1}>
          <ul className="guide-index">
            {GUIDE_DOCUMENTS.map((guide) => (
              <li key={guide.slug}>
                <AppLink
                  className="guide-index__card"
                  href={guidePath(guide.slug)}
                  onNavigate={onNavigate}
                >
                  <span className="guide-index__title">{guide.title}</span>
                  <span className="guide-index__description">{guide.description}</span>
                </AppLink>
              </li>
            ))}
          </ul>
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}

interface GuideEntryPageProps extends GuidePageProps {
  readonly slug: string
}

/**
 * One bundled guide, or an explicit not-found view for a slug that no bundled
 * document answers. A missing page never falls back to the catalog.
 */
export function GuideEntryPage({ slug, onNavigate }: GuideEntryPageProps) {
  const guide = findGuide(slug)

  useEffect(() => {
    document.title =
      guide === null ? 'Guide page not found · AttestBook' : `${guide.title} · AttestBook`
  }, [guide])

  return (
    <div className="app-shell">
      <SkipLink href={guide === null ? '#main-content' : '#guide-content'}>
        Skip to the product guide
      </SkipLink>

      <SiteHeader section="Product guide" onNavigate={onNavigate} />

      <main className="page" id="main-content">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <ol>
            <li>
              <AppLink href={GUIDE_PATH} onNavigate={onNavigate}>
                Product guide
              </AppLink>
            </li>
            <li aria-current="page">{guide === null ? 'Guide page not found' : guide.title}</li>
          </ol>
        </nav>

        {guide === null ? (
          <div className="state-panel state-panel--empty">
            <h1 className="state-title">Guide page not found</h1>
            <p className="state-detail">
              No bundled product guide matches this address. The guide pages are fixed Markdown
              files shipped with the application, so a mistyped or removed slug has no page.
            </p>
            <AppLink className="button button--primary" href={GUIDE_PATH} onNavigate={onNavigate}>
              Back to the product guide
            </AppLink>
          </div>
        ) : (
          <>
            <div className="page-heading">
              <p className="eyebrow">Product guide</p>
              <h1>{guide.title}</h1>
              <p className="lede">{guide.description}</p>
            </div>
            <div id="guide-content" tabIndex={-1}>
              <GuideMarkdown markdown={guide.markdown} onNavigate={onNavigate} />
            </div>
          </>
        )}
      </main>

      <SiteFooter />
    </div>
  )
}
