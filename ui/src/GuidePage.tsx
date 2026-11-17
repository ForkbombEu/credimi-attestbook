import { useEffect } from 'react'

import { GuideNavigation } from './components/GuideNavigation'
import { SiteFooter, SiteHeader, SkipLink } from './components/Layout'
import { GuideMarkdown } from './GuideMarkdown'
import { findGuide, GUIDE_DOCUMENTS } from './guide'
import { AppLink, CATALOG_PATH, DOCS_PATH, GUIDE_PATH, guidePath } from './router'

interface GuidePageProps {
  readonly onNavigate: (path: string) => void
}

/**
 * The documentation landing page: the bundled guides as navigation cards, with
 * a separate panel for the standalone API reference. The page list is derived
 * from `GUIDE_DOCUMENTS`, so a later guide-only change adds one registry entry
 * and appears here without touching this component.
 */
export function GuideIndexPage({ onNavigate }: GuidePageProps) {
  useEffect(() => {
    document.title = 'Product guide · AttestBook'
  }, [])

  return (
    <div className="app-shell">
      <SkipLink href="#guide-content">Skip to the product guide</SkipLink>

      <SiteHeader section="Product guide" onNavigate={onNavigate} />

      <main className="page" id="main-content">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <ol>
            <li>
              <AppLink href={CATALOG_PATH} onNavigate={onNavigate}>
                Catalog
              </AppLink>
            </li>
            <li aria-current="page">Guides</li>
          </ol>
        </nav>

        <div className="guide-landing">
          <div className="guide-landing__main">
            <div className="page-heading">
              <p className="eyebrow">Documentation</p>
              <h1>AttestBook product guide</h1>
              <p className="lede">
                Short, task-focused guides for finding rulebooks, validating credentials and reading
                the public product API. Every page is public and bundled with the application.
              </p>
            </div>

            <div id="guide-content" tabIndex={-1}>
              <h2 className="guide-section-title" id="guide-pages">
                Product guides
              </h2>
              <ul className="guide-index" aria-labelledby="guide-pages">
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
          </div>

          <aside className="guide-landing__aside" aria-labelledby="guide-api-reference">
            <div className="guide-reference">
              <p className="eyebrow">Reference</p>
              <h2 id="guide-api-reference">API reference</h2>
              <p className="guide-reference__detail">
                Every operation and schema of the public product API, rendered from the canonical
                OpenAPI contract. It is a separate reference page, not part of this guide.
              </p>
              <a className="button button--primary" href={DOCS_PATH}>
                Open the API reference
                <span aria-hidden="true"> ↗</span>
              </a>
            </div>
          </aside>
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
 * document answers. The sidebar is the article navigation: it lists every
 * registered page, marks the current one with `aria-current`, and keeps the
 * separate API reference one full page load away. A missing page never falls
 * back to the catalog.
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
        <div className="guide-layout">
          <aside className="guide-sidebar">
            <GuideNavigation
              state={guide === null ? { kind: 'not-found' } : { kind: 'page', slug: guide.slug }}
              onNavigate={onNavigate}
            />
          </aside>

          <div className="guide-content">
            <nav className="breadcrumb" aria-label="Breadcrumb">
              <ol>
                <li>
                  <AppLink href={CATALOG_PATH} onNavigate={onNavigate}>
                    Catalog
                  </AppLink>
                </li>
                <li>
                  <AppLink href={GUIDE_PATH} onNavigate={onNavigate}>
                    Guides
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
                <AppLink
                  className="button button--primary"
                  href={GUIDE_PATH}
                  onNavigate={onNavigate}
                >
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
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
