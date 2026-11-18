// Contextual link from a working view to one bundled product guide.
//
// Help always opens in a new tab: the editor keeps its unsaved working copy and
// the current view never navigates away. The destination is a plain,
// root-relative anchor, so it resolves under the local and deployed origins
// without the client router taking over the new tab. The accessible name says
// that a new tab opens, matching the other external links in the UI.

import type { ReactNode } from 'react'

import type { GuideSlug } from '../guide'
import { guidePath } from '../router'

interface GuideLinkProps {
  /** Registry slug of the guide page; never an arbitrary path. */
  readonly slug: GuideSlug
  readonly children: ReactNode
  readonly className?: string
}

export function GuideLink({ slug, children, className }: GuideLinkProps) {
  return (
    <a className={className} href={guidePath(slug)} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}
