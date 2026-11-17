// The product guide is repository-owned Markdown bundled into the web build.
//
// Page convention for adding a guide:
//   1. add a short Markdown file under `docs/guides/<slug>.md`;
//   2. register it below with a lowercase, hyphen-separated slug, a title and a
//      one-sentence description;
//   3. start the document body at `##` — the registered title is the page's
//      single `h1`, and headings inside the document keep their own level.
//
// This registry is the single source of truth for the page set: the guide index
// cards, their order and the article sidebar all derive from it, so adding a
// page never means editing a separate navigation list.
//
// `?raw` is resolved by Vite at build time, so the built application carries
// the page with its assets and never fetches Markdown from a filesystem path, a
// remote host or the API.

import apiIntegrationMarkdown from '../../docs/guides/api-integration.md?raw'
import captureExplorerMarkdown from '../../docs/guides/capture-explorer.md?raw'
import credentialSchemasMarkdown from '../../docs/guides/credential-schemas.md?raw'
import credentialValidationMarkdown from '../../docs/guides/credential-validation.md?raw'
import introductionMarkdown from '../../docs/guides/introduction.md?raw'
import publicationEventsMarkdown from '../../docs/guides/publication-events.md?raw'
import rulebookAuthoringMarkdown from '../../docs/guides/rulebook-authoring.md?raw'

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
  {
    slug: 'capture-explorer',
    title: 'Capture explorer',
    description:
      'What the mock-backed capture explorer shows, how a capture is correlated with a rulebook version, and where the verified boundary ends.',
    markdown: captureExplorerMarkdown,
  },
  {
    slug: 'api-integration',
    title: 'API integration',
    description:
      'How to read the public API, choose a write credential and use the generated OpenAPI reference.',
    markdown: apiIntegrationMarkdown,
  },
  {
    slug: 'publication-events',
    title: 'Publication events',
    description:
      'Follow published rulebook versions through the public event feed and signed webhook notifications.',
    markdown: publicationEventsMarkdown,
  },
  {
    slug: 'credential-validation',
    title: 'Credential validation',
    description:
      'Validate a credential against a pinned rulebook version in the playground, and read its structural evidence without over-claiming.',
    markdown: credentialValidationMarkdown,
  },
  {
    slug: 'rulebook-authoring',
    title: 'Rulebook authoring',
    description:
      'Take a rulebook from a signed-in draft through validation, readiness and immutable publication.',
    markdown: rulebookAuthoringMarkdown,
  },
  {
    slug: 'credential-schemas',
    title: 'Credential schemas',
    description:
      'Attach an external schema URL or register a schema hosted by AttestBook, and read its integrity pins in rulebook detail.',
    markdown: credentialSchemasMarkdown,
  },
]

/** Resolves a URL slug to exactly one bundled document, never a file path. */
export function findGuide(slug: string): GuideDocument | null {
  return GUIDE_DOCUMENTS.find((document) => document.slug === slug) ?? null
}
