// Small client-side router for the standalone UI (issue #37).
//
// The server serves the built entry document for `/` and `/rulebooks/*`, so the
// browser path names the view and a deep link (or a reload) still works. Only
// the two Phase 1 routes exist; any other path falls back to the catalog rather
// than rendering an empty page.

import type { AnchorHTMLAttributes, MouseEvent } from 'react'
import { useCallback, useEffect, useState } from 'react'

export type Route =
  { readonly name: 'catalog' } | { readonly name: 'rulebook'; readonly rulebookId: string }

export const CATALOG_PATH = '/'

export function rulebookPath(rulebookId: string): string {
  return `/rulebooks/${encodeURIComponent(rulebookId)}`
}

/** Parses a browser path into one of the known views. */
export function parseRoute(pathname: string): Route {
  let path = pathname
  while (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1)
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
    if (window.location.pathname === path) {
      return
    }
    window.history.pushState({}, '', path)
    setRoute(parseRoute(path))
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
