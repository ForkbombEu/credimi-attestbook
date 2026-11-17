import { GUIDE_DOCUMENTS } from '../guide'
import { AppLink, DOCS_PATH, GUIDE_PATH, guidePath } from '../router'

/** Which guide navigation entry, if any, is the current page. */
export type GuideNavigationState =
  | { readonly kind: 'index' }
  | { readonly kind: 'page'; readonly slug: string }
  | { readonly kind: 'not-found' }

interface GuideNavigationProps {
  readonly state: GuideNavigationState
  readonly onNavigate: (path: string) => void
}

/**
 * The single navigation source for every guide page. It is derived from the
 * bundled document registry in `guide.ts`, so adding a guide page never means
 * editing a second list: its title, description and position come from the
 * same registry the index and Markdown loader use.
 *
 * The API reference is deliberately a separate destination and is rendered as
 * its own block with a full page load, so the reader can tell the task-focused
 * guides from the generated operation reference (issue #131).
 */
export function GuideNavigation({ state, onNavigate }: GuideNavigationProps) {
  return (
    <nav className="guide-nav" aria-label="Product guides">
      <p className="guide-nav__title">Guides</p>
      <ul className="guide-nav__list">
        <li>
          <AppLink
            className="guide-nav__link"
            href={GUIDE_PATH}
            onNavigate={onNavigate}
            {...(state.kind === 'index' ? { 'aria-current': 'page' as const } : {})}
          >
            Guides overview
          </AppLink>
        </li>
        {GUIDE_DOCUMENTS.map((guide) => (
          <li key={guide.slug}>
            <AppLink
              className="guide-nav__link"
              href={guidePath(guide.slug)}
              onNavigate={onNavigate}
              {...(state.kind === 'page' && state.slug === guide.slug
                ? { 'aria-current': 'page' as const }
                : {})}
            >
              {guide.title}
            </AppLink>
          </li>
        ))}
      </ul>
      <div className="guide-nav__reference">
        <p className="guide-nav__reference-title">API reference</p>
        <p className="guide-nav__reference-detail">
          The generated operations and schemas of the public product API, separate from these
          task-focused guides.
        </p>
        <a className="guide-nav__reference-link" href={DOCS_PATH}>
          Open the API reference
          <span aria-hidden="true"> ↗</span>
        </a>
      </div>
    </nav>
  )
}
