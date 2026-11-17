// The product guide is repository-owned Markdown bundled into the web build.
//
// Page convention for adding a guide:
//   1. add a short Markdown file under `docs/guides/<slug>.md`;
//   2. register it below with a lowercase, hyphen-separated slug, a title and a
//      one-sentence description;
//   3. start the document body at `##` — the registered title is the page's
//      single `h1`, and headings inside the document keep their own level.
//
// `?raw` is resolved by Vite at build time, so the built application carries
// the page with its assets and never fetches Markdown from a filesystem path, a
// remote host or the API.

import introductionMarkdown from '../../docs/guides/introduction.md?raw'

export interface GuideDocument {
  readonly slug: string
  readonly title: string
  readonly description: string
  readonly markdown: string
}

export const GUIDE_DOCUMENTS: readonly GuideDocument[] = [
  {
    slug: 'introduction',
    title: 'Introduction to AttestBook',
    description:
      'What AttestBook does, how to find and validate rulebooks, and where the product API contract lives.',
    markdown: introductionMarkdown,
  },
]

/** Resolves a URL slug to exactly one bundled document, never a file path. */
export function findGuide(slug: string): GuideDocument | null {
  return GUIDE_DOCUMENTS.find((document) => document.slug === slug) ?? null
}
