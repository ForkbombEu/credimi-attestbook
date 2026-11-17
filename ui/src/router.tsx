// Small client-side router for the standalone UI (issues #36–#38, #90).
//
// The server serves the built entry document for `/`, `/rulebooks/*`,
// `/guide/*`, `/playground`, `/captures/*` and `/login`, so the browser path
// names the view and a deep link (or a reload) still works. The rulebook editor
// is under `/rulebooks/new` and `/rulebooks/<id>/edit`; the product guide is
// under `/guide` and `/guide/<slug>`, where an unknown slug renders the guide's
// own not-found view instead of falling back to the catalog. Any other path
// falls back to the catalog rather than rendering an empty page.

import type { AnchorHTMLAttributes, MouseEvent } from 'react'
import { useCallback, useEffect, useState } from 'react'

export type Route =
  | { readonly name: 'catalog' }
  | { readonly name: 'guide' }
  | { readonly name: 'guide-page'; readonly slug: string }
  | { readonly name: 'playground' }
  | { readonly name: 'captures' }
  | { readonly name: 'capture'; readonly captureId: string }
  | { readonly name: 'rulebook'; readonly rulebookId: string }
  | { readonly name: 'editor'; readonly rulebookId: string }
  | { readonly name: 'editor-new' }
  | { readonly name: 'login' }

export const CATALOG_PATH = '/'
export const GUIDE_PATH = '/guide'
export const PLAYGROUND_PATH = '/playground'
export const CAPTURES_PATH = '/captures'
export const NEW_RULEBOOK_PATH = '/rulebooks/new'
export const LOGIN_PATH = '/login'

/**
 * True when the SPA itself renders `href`; server documents such as `/docs`
 * need a full navigation. Keep this list matched to the routes `parseRoute`
 * recognises and to the index-document routes in `src/app.ts`.
 */
export function isClientRoute(href: string): boolean {
  if (href === '') {
    return false
  }
  let url: URL
  try {
    url = new URL(href, 'http://attestbook.invalid')
  } catch {
    return false
  }
  let path = url.pathname
  while (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1)
  }
  return (
    path === CATALOG_PATH ||
    path === GUIDE_PATH ||
    path.startsWith(`${GUIDE_PATH}/`) ||
    path === PLAYGROUND_PATH ||
    path === CAPTURES_PATH ||
    path.startsWith(`${CAPTURES_PATH}/`) ||
    path.startsWith('/rulebooks/') ||
    path === LOGIN_PATH
  )
}

export function capturePath(captureId: string): string {
  return `${CAPTURES_PATH}/${encodeURIComponent(captureId)}`
}

export function guidePath(slug: string): string {
  return `${GUIDE_PATH}/${encodeURIComponent(slug)}`
}

export function rulebookPath(rulebookId: string): string {
  return `/rulebooks/${encodeURIComponent(rulebookId)}`
}

export function rulebookEditorPath(rulebookId: string): string {
  return `${rulebookPath(rulebookId)}/edit`
}

/** Parses a browser path into one of the known views. */
export function parseRoute(pathname: string): Route {
  let path = pathname
  while (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1)
  }
  if (path === PLAYGROUND_PATH) {
    return { name: 'playground' }
  }
  if (path === CAPTURES_PATH) {
    return { name: 'captures' }
  }
  if (path === NEW_RULEBOOK_PATH) {
    return { name: 'editor-new' }
  }
  if (path === LOGIN_PATH) {
    return { name: 'login' }
  }
  if (path === GUIDE_PATH) {
    return { name: 'guide' }
  }
  // A guide address is a single bundled slug. A missing, malformed or nested
  // one still reaches the guide's not-found view rather than the catalog, so a
  // stale link never looks like the rulebook catalog.
  const guideMatch = /^\/guide\/(.+)$/.exec(path)
  if (guideMatch?.[1] !== undefined) {
    try {
      return { name: 'guide-page', slug: decodeURIComponent(guideMatch[1]) }
    } catch {
      return { name: 'guide-page', slug: guideMatch[1] }
    }
  }
  const captureMatch = /^\/captures\/([^/]+)$/.exec(path)
  if (captureMatch?.[1] !== undefined) {
    try {
      const captureId = decodeURIComponent(captureMatch[1])
      return captureId === '' ? { name: 'captures' } : { name: 'capture', captureId }
    } catch {
      return { name: 'captures' }
    }
  }
  const editorMatch = /^\/rulebooks\/([^/]+)\/edit$/.exec(path)
  if (editorMatch?.[1] !== undefined) {
    try {
      const rulebookId = decodeURIComponent(editorMatch[1])
      return rulebookId === '' ? { name: 'catalog' } : { name: 'editor', rulebookId }
    } catch {
      return { name: 'catalog' }
    }
  }
  const match = /^\/rulebooks\/([^/]+)$/.exec(path)
  if (match?.[1] === undefined) {
    return { name: 'catalog' }
  }
  try {
    const rulebookId = decodeURIComponent(match[1])
    return rulebookId === '' ? { name: 'catalog' } : { name: 'rulebook', rulebookId }
  } catch {
    // A malformed percent-encoding must not crash the application.
    return { name: 'catalog' }
  }
}

export interface RouteState {
  readonly route: Route
  readonly navigate: (path: string) => void
}

/**
 * Reads the current path and re-reads it on browser back/forward. In-page
 * navigation pushes a real history entry, so links, reloads and the browser's
 * back button all address the same views.
 */
export function useRoute(): RouteState {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname))

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback((path: string) => {
    // A target may carry a query string (the login page's `next`), so compare
    // and parse the resolved URL instead of assuming `path` is a bare pathname.
    let url: URL
    try {
      url = new URL(path, window.location.origin)
    } catch {
      return
    }
    if (window.location.pathname === url.pathname && window.location.search === url.search) {
      return
    }
    window.history.pushState({}, '', path)
    setRoute(parseRoute(url.pathname))
    document.documentElement.scrollTop = 0
  }, [])

  return { route, navigate }
}

interface AppLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  readonly href: string
  readonly onNavigate: (path: string) => void
}

/**
 * An ordinary anchor that uses the router for unmodified primary clicks. The
 * native link behaviour (open in a new tab, copy address) still works, and a
 * user who has JavaScript disabled would still request a server-served page.
 */
export function AppLink({ href, onNavigate, onClick, ...rest }: AppLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) {
      return
    }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return
    }
    event.preventDefault()
    onNavigate(href)
  }

  return <a href={href} onClick={handleClick} {...rest} />
}
