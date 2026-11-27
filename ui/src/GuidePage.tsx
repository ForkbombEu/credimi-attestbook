import { useEffect } from 'react'

import { GuideNavigation } from './components/GuideNavigation'
import { PageHero, SiteFooter, SiteHeader, SkipLink } from './components/Layout'
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

      <main className="page-main" id="main-content">
        <PageHero
          title="AttestBook product guide"
          breadcrumb={
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
          }
        >
          <p>
            Short, task-focused guides for finding rulebooks, validating credentials and reading the
            public product API. Every page is public and bundled with the application.
          </p>
        </PageHero>

        <div className="page">
          <div className="guide-landing">
            <div className="guide-landing__main">
              <div id="guide-content" tabIndex={-1}>
                <h2 className="guide-section-title" id="guide-pages">
                  Product guides
                </h2>
                <ul className="guide-index link-cards" aria-labelledby="guide-pages">
                  {GUIDE_DOCUMENTS.map((guide) => (
                    <li key={guide.slug}>
                      <AppLink
                        className="link-card"
                        href={guidePath(guide.slug)}
                        onNavigate={onNavigate}
                      >
                        <h3>{guide.title}</h3>
                        <p className="guide-index__description">{guide.description}</p>
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
                <a className="btn btn-primary btn-md" href={DOCS_PATH}>
                  Open the API reference
                  <span aria-hidden="true"> ↗</span>
                </a>
              </div>
            </aside>
          </div>
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

      <main className="page-main" id="main-content">
        <PageHero
          title={guide === null ? 'Guide page not found' : guide.title}
          alert={guide === null}
          breadcrumb={
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
          }
        >
          {guide === null ? (
            <>
              <p>
                No bundled product guide matches this address. The guide pages are fixed Markdown
                files shipped with the application, so a mistyped or removed slug has no page.
              </p>
              <p className="hero-actions">
                <AppLink
                  className="btn btn-outline btn-lg"
                  href={GUIDE_PATH}
                  onNavigate={onNavigate}
                >
                  Back to the product guide
                </AppLink>
              </p>
            </>
          ) : (
            <p>{guide.description}</p>
          )}
        </PageHero>

        <div className="page">
          <div className="guide-layout">
            <aside className="guide-sidebar">
              <GuideNavigation
                state={guide === null ? { kind: 'not-found' } : { kind: 'page', slug: guide.slug }}
                onNavigate={onNavigate}
              />
            </aside>

            {guide === null ? null : (
              <div className="guide-content">
                <div id="guide-content" tabIndex={-1}>
                  <GuideMarkdown markdown={guide.markdown} onNavigate={onNavigate} />
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
