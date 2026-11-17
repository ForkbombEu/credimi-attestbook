import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { GuideMarkdown } from './GuideMarkdown'
import { GuideEntryPage, GuideIndexPage } from './GuidePage'
import { findGuide, GUIDE_DOCUMENTS } from './guide'
import { parseInline, parseMarkdown, safeLinkHref } from './markdown'
import { isClientRoute } from './router'
import { expectNoA11yViolations } from './test/a11y'

afterEach(() => {
  window.history.replaceState({}, '', '/')
})

function guideLinks(markdown: string): string[] {
  const hrefs: string[] = []
  const collect = (text: string): void => {
    for (const token of parseInline(text)) {
      if (token.type === 'link') {
        hrefs.push(token.href)
      }
    }
  }
  for (const block of parseMarkdown(markdown)) {
    if (block.type === 'heading' || block.type === 'paragraph') {
      collect(block.text)
    } else if (block.type === 'list') {
      block.items.forEach(collect)
    }
  }
  return hrefs
}

describe('bundled guide registry', () => {
  test('registers unique, URL-safe slugs with a title and description', () => {
    expect(GUIDE_DOCUMENTS.length).toBeGreaterThan(0)
    const slugs = GUIDE_DOCUMENTS.map((guide) => guide.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const guide of GUIDE_DOCUMENTS) {
      expect(guide.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(guide.title.trim()).not.toBe('')
      expect(guide.description.trim()).not.toBe('')
      expect(guide.markdown.trim()).not.toBe('')
      // The registered title is the page h1; the document body starts at h2.
      expect(guide.markdown).not.toMatch(/^# /m)
    }
  })

  test('resolves only a registered slug and never treats it as a file path', () => {
    expect(findGuide('introduction')).not.toBeNull()
    expect(findGuide('capture-explorer')).not.toBeNull()
    expect(findGuide('api-integration')).not.toBeNull()
    expect(findGuide('../../package.json')).toBeNull()
    expect(findGuide('/etc/passwd')).toBeNull()
    expect(findGuide('introduction.md')).toBeNull()
    expect(findGuide('')).toBeNull()
  })
})

describe('Markdown parsing', () => {
  test('parses headings, paragraphs, lists and fenced code blocks', () => {
    const blocks = parseMarkdown(
      [
        'Opening paragraph.',
        '',
        '## A section',
        '',
        '- first item',
        '  continued on the next line',
        '- second item',
        '',
        '1. ordered one',
        '2. ordered two',
        '',
        '```ts',
        'const ready = true',
        '```',
        '',
        'Closing paragraph.',
      ].join('\n'),
    )

    expect(blocks).toEqual([
      { type: 'paragraph', text: 'Opening paragraph.' },
      { type: 'heading', level: 2, text: 'A section' },
      {
        type: 'list',
        ordered: false,
        items: ['first item continued on the next line', 'second item'],
      },
      { type: 'list', ordered: true, items: ['ordered one', 'ordered two'] },
      { type: 'code', language: 'ts', code: 'const ready = true' },
      { type: 'paragraph', text: 'Closing paragraph.' },
    ])
  })

  test('joins wrapped paragraph lines and closes an unterminated fence at the end', () => {
    expect(parseMarkdown('one line\nstill the same paragraph\n\n## Last')).toEqual([
      { type: 'paragraph', text: 'one line still the same paragraph' },
      { type: 'heading', level: 2, text: 'Last' },
    ])
    expect(parseMarkdown('```bash\nbun run build')).toEqual([
      { type: 'code', language: 'bash', code: 'bun run build' },
    ])
  })

  test('parses inline code, emphasis, strong text and links', () => {
    expect(parseInline('See `bun run build` and the **catalog** with *care*.')).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'code', text: 'bun run build' },
      { type: 'text', text: ' and the ' },
      { type: 'strong', text: 'catalog' },
      { type: 'text', text: ' with ' },
      { type: 'emphasis', text: 'care' },
      { type: 'text', text: '.' },
    ])
    expect(parseInline('Read the [API reference](/docs) next.')).toEqual([
      { type: 'text', text: 'Read the ' },
      { type: 'link', text: 'API reference', href: '/docs' },
      { type: 'text', text: ' next.' },
    ])
  })

  test('accepts only safe link destinations', () => {
    expect(safeLinkHref('/guide/introduction')).toBe('/guide/introduction')
    expect(safeLinkHref('#what-attestbook-does')).toBe('#what-attestbook-does')
    expect(safeLinkHref('https://example.org/docs')).toBe('https://example.org/docs')
    expect(safeLinkHref('HTTP://example.org')).toBe('HTTP://example.org')
    expect(safeLinkHref('mailto:developers@example.org')).toBe('mailto:developers@example.org')

    for (const unsafe of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//example.org/docs',
      '/\\example.org',
      'https://example.org/a b',
      '',
      '   ',
    ]) {
      expect(safeLinkHref(unsafe), unsafe).toBeNull()
    }
  })

  test('keeps an unsafe link destination as literal text', () => {
    expect(parseInline('[run](javascript:alert(1))')).toEqual([
      { type: 'text', text: '[run](javascript:alert(1))' },
    ])
  })
})

describe('GuideMarkdown', () => {
  test('renders headings, lists, code and links without injecting raw HTML', async () => {
    const onNavigate = vi.fn()
    const { container } = render(
      <GuideMarkdown
        markdown={[
          '## Section',
          '',
          'Read the [catalog](/) and the [external reference](https://example.org/api).',
          '',
          '- one',
          '- two',
          '',
          '```bash',
          'curl http://127.0.0.1:3000/health',
          '```',
          '',
          '<script>window.injected = true</script>',
          '',
          '[unsafe](javascript:alert(1))',
        ].join('\n')}
        onNavigate={onNavigate}
      />,
    )

    expect(screen.getByRole('heading', { level: 2, name: 'Section' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(container.querySelector('pre code.language-bash')).toHaveTextContent(
      'curl http://127.0.0.1:3000/health',
    )

    const catalog = screen.getByRole('link', { name: 'catalog' })
    expect(catalog).toHaveAttribute('href', '/')
    await userEvent.setup().click(catalog)
    expect(onNavigate).toHaveBeenCalledWith('/')

    const external = screen.getByRole('link', { name: 'external reference' })
    expect(external).toHaveAttribute('href', 'https://example.org/api')
    expect(external).toHaveAttribute('target', '_blank')
    expect(external).toHaveAttribute('rel', 'noopener noreferrer')

    // Embedded HTML and a script-protocol link stay inert text.
    expect(container.querySelector('script')).toBeNull()
    expect(container).toHaveTextContent('<script>window.injected = true</script>')
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(container).toHaveTextContent('[unsafe](javascript:alert(1))')
  })

  test('lets the browser load a server document such as /docs', async () => {
    const onNavigate = vi.fn()
    render(<GuideMarkdown markdown="Read the [API reference](/docs)." onNavigate={onNavigate} />)

    const reference = screen.getByRole('link', { name: 'API reference' })
    expect(reference).toHaveAttribute('href', '/docs')
    expect(reference).not.toHaveAttribute('target')

    await userEvent.setup().click(reference)
    expect(onNavigate).not.toHaveBeenCalled()
  })
})

describe('product guide views', () => {
  test('the index links to every bundled guide without a session', async () => {
    const onNavigate = vi.fn()
    render(<GuideIndexPage onNavigate={onNavigate} />)

    expect(
      screen.getByRole('heading', { level: 1, name: 'AttestBook product guide' }),
    ).toBeVisible()
    const link = screen.getByRole('link', { name: /Introduction to AttestBook/ })
    expect(link).toHaveAttribute('href', '/guide/introduction')
    expect(link).toHaveTextContent('What AttestBook does')
    expect(document.title).toBe('Product guide · AttestBook')

    await userEvent.setup().click(link)
    expect(onNavigate).toHaveBeenCalledWith('/guide/introduction')
  })

  test('renders a bundled guide page with its title, body headings and code', () => {
    const { container } = render(<GuideEntryPage slug="introduction" onNavigate={vi.fn()} />)

    expect(
      screen.getByRole('heading', { level: 1, name: 'Introduction to AttestBook' }),
    ).toBeVisible()
    expect(screen.getByRole('heading', { level: 2, name: 'What AttestBook does' })).toBeVisible()
    const article = container.querySelector('.guide-article')
    expect(article).not.toBeNull()
    expect(
      within(article as HTMLElement).getByRole('link', { name: 'Validation playground' }),
    ).toHaveAttribute('href', '/playground')
    expect(container.querySelector('.guide-article pre code')).toHaveTextContent(
      'api/v1/rulebooks?limit=10',
    )
    expect(document.title).toBe('Introduction to AttestBook · AttestBook')
  })

  test('renders the capture explorer guide with its mock boundary and /captures link', () => {
    const { container } = render(<GuideEntryPage slug="capture-explorer" onNavigate={vi.fn()} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Capture explorer' })).toBeVisible()
    const article = container.querySelector('.guide-article')
    expect(article).not.toBeNull()
    const content = article as HTMLElement
    expect(within(content).getByRole('link', { name: 'the capture explorer' })).toHaveAttribute(
      'href',
      '/captures',
    )
    expect(content).toHaveTextContent(/mock-backed/i)
    expect(content).toHaveTextContent(/not implemented and are not claimed/i)
    expect(content).toHaveTextContent(/no live capture-issuer or capture-verifier connector/i)
    expect(document.title).toBe('Capture explorer · AttestBook')
  })

  test('every root-relative guide link resolves to a served route or document', () => {
    const serverDocuments = new Set(['/docs', '/openapi.json'])
    for (const guide of GUIDE_DOCUMENTS) {
      for (const href of guideLinks(guide.markdown)) {
        if (!href.startsWith('/')) {
          continue
        }
        expect(
          isClientRoute(href) || serverDocuments.has(href),
          `${guide.slug}: ${href} is not a served route`,
        ).toBe(true)
      }
    }
  })

  test('renders the API integration guide with both write credentials and references', async () => {
    const onNavigate = vi.fn()
    const { container } = render(<GuideEntryPage slug="api-integration" onNavigate={onNavigate} />)

    expect(screen.getByRole('heading', { level: 1, name: 'API integration' })).toBeVisible()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Public reads need no credential' }),
    ).toBeVisible()
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: 'Provider bearer token for headless clients',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: 'Administrator browser session for UI writes',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Subscription management is a separate credential',
      }),
    ).toBeVisible()
    expect(document.title).toBe('API integration · AttestBook')

    const article = container.querySelector('.guide-article')
    expect(article).not.toBeNull()
    const openapiLinks = within(article as HTMLElement).getAllByRole('link', {
      name: 'OpenAPI 3.1 contract',
    })
    expect(openapiLinks).toHaveLength(2)
    for (const link of openapiLinks) {
      expect(link).toHaveAttribute('href', '/openapi.json')
    }
    const referenceLinks = within(article as HTMLElement).getAllByRole('link', {
      name: 'interactive Scalar reference',
    })
    expect(referenceLinks).toHaveLength(2)
    for (const link of referenceLinks) {
      expect(link).toHaveAttribute('href', '/docs')
    }

    // A generated reference is a server document, so it gets a full page load
    // instead of the in-app router (which would fall back to the catalog).
    await userEvent.setup().click(openapiLinks[0]!)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  test('links the publication-events guide from the guide index', () => {
    render(<GuideIndexPage onNavigate={vi.fn()} />)

    const list = screen.getByRole('list', { name: 'Product guides' })
    expect(within(list).getByRole('link', { name: /Publication events/ })).toHaveAttribute(
      'href',
      '/guide/publication-events',
    )
  })

  test('renders the publication-events guide with its public contract references', () => {
    const { container } = render(<GuideEntryPage slug="publication-events" onNavigate={vi.fn()} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Publication events' })).toBeVisible()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Discover publications from the event feed' }),
    ).toBeVisible()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Prove control of the callback' }),
    ).toBeVisible()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Verify a signed delivery' }),
    ).toBeVisible()
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Reconcile with the pinned published version',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Treat delivery as at-least-once' }),
    ).toBeVisible()
    expect(document.title).toBe('Publication events · AttestBook')

    const article = container.querySelector('.guide-article')
    expect(article).not.toBeNull()
    expect(article).toHaveTextContent('/api/v1/rulebooks/{rulebookId}/events')
    expect(article).toHaveTextContent('X-AttestBook-Signature')
    expect(article).toHaveTextContent('attestbook.webhook-signing-input@1')
    expect(article).toHaveTextContent('/versions/{version}/export')

    // Every reference leaves the guide for the server-rendered /docs document.
    const references = within(article as HTMLElement).getAllByRole('link', {
      name: 'API reference',
    })
    expect(references.length).toBeGreaterThanOrEqual(2)
    for (const reference of references) {
      expect(reference).toHaveAttribute('href', '/docs')
      expect(reference).not.toHaveAttribute('target')
    }

    const nav = screen.getByRole('navigation', { name: 'Product guides' })
    expect(within(nav).getByRole('link', { name: 'Publication events' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  test('the publication-events guide has no detectable accessibility violations', async () => {
    const { container } = render(<GuideEntryPage slug="publication-events" onNavigate={vi.fn()} />)

    await expectNoA11yViolations(container)
  })

  test('renders the credential validation guide with its no-over-claim warnings', () => {
    const { container } = render(
      <GuideEntryPage slug="credential-validation" onNavigate={vi.fn()} />,
    )

    expect(screen.getByRole('heading', { level: 1, name: 'Credential validation' })).toBeVisible()
    expect(screen.getByRole('heading', { level: 2, name: 'Run the validation' })).toBeVisible()
    expect(
      screen.getByRole('heading', { level: 2, name: 'What this evidence does not establish' }),
    ).toBeVisible()

    const article = container.querySelector('.guide-article') as HTMLElement
    expect(within(article).getByRole('link', { name: 'Validation playground' })).toHaveAttribute(
      'href',
      '/playground',
    )
    expect(
      within(article).getByText(/does not establish complete wallet or EUDI compliance/),
    ).toBeVisible()
    for (const statusLabel of ['Not tested', 'Inconclusive']) {
      const labels = within(article).getAllByText(statusLabel, { selector: 'strong' })
      expect(labels.length).toBeGreaterThan(0)
      expect(labels[0]).toBeVisible()
    }
    for (const dimension of [
      'Cryptographic verification',
      'Issuer trust',
      'Protocol conformance',
      'End-to-end interoperability',
    ]) {
      expect(within(article).getAllByText(dimension, { exact: true }).length).toBeGreaterThan(0)
    }
    expect(document.title).toBe('Credential validation · AttestBook')
  })

  test('shows an explicit not-found view for an unknown slug instead of the catalog', async () => {
    const onNavigate = vi.fn()
    render(<GuideEntryPage slug="no-such-guide" onNavigate={onNavigate} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Guide page not found' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Rulebook catalog' })).toBeNull()
    expect(document.title).toBe('Guide page not found · AttestBook')

    const back = screen.getByRole('link', { name: 'Back to the product guide' })
    expect(back).toHaveAttribute('href', '/guide')
    await userEvent.setup().click(back)
    expect(onNavigate).toHaveBeenCalledWith('/guide')
  })

  test('the guide index has no detectable accessibility violations', async () => {
    const { container } = render(<GuideIndexPage onNavigate={vi.fn()} />)

    await expectNoA11yViolations(container)
  })

  test('a guide page has no detectable accessibility violations', async () => {
    const { container } = render(<GuideEntryPage slug="introduction" onNavigate={vi.fn()} />)

    await expectNoA11yViolations(container)
  })

  test('the guide not-found view has no detectable accessibility violations', async () => {
    const { container } = render(<GuideEntryPage slug="missing" onNavigate={vi.fn()} />)

    await expectNoA11yViolations(container)
  })

  test('the index lists the Introduction page first', () => {
    render(<GuideIndexPage onNavigate={vi.fn()} />)

    const list = screen.getByRole('list', { name: 'Product guides' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(GUIDE_DOCUMENTS.length)
    expect(items[0]).toHaveTextContent('Introduction to AttestBook')
  })

  test('the index links to the capture explorer guide', async () => {
    const onNavigate = vi.fn()
    render(<GuideIndexPage onNavigate={onNavigate} />)

    const list = screen.getByRole('list', { name: 'Product guides' })
    const link = within(list).getByRole('link', { name: /Capture explorer/ })
    expect(link).toHaveAttribute('href', '/guide/capture-explorer')

    await userEvent.setup().click(link)
    expect(onNavigate).toHaveBeenCalledWith('/guide/capture-explorer')
  })
})

describe('credential validation guide links', () => {
  test('links to the playground and the API documents', () => {
    const markdown = findGuide('credential-validation')?.markdown ?? ''

    expect(markdown).toContain('](/playground)')
    expect(markdown).toContain('](/docs)')
    expect(markdown).toContain('](/openapi.json)')
  })
})

describe('guide navigation', () => {
  test('the landing page links back to the catalog and out to the separate API reference', () => {
    render(<GuideIndexPage onNavigate={vi.fn()} />)

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(breadcrumb).getByRole('link', { name: 'Catalog' })).toHaveAttribute('href', '/')
    expect(within(breadcrumb).getByText('Guides')).toHaveAttribute('aria-current', 'page')

    expect(screen.getByRole('link', { name: /Open the API reference/ })).toHaveAttribute(
      'href',
      '/docs',
    )
  })

  test('renders the guide cards in registry order from one source of truth', () => {
    render(<GuideIndexPage onNavigate={vi.fn()} />)

    const list = screen.getByRole('list', { name: 'Product guides' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(GUIDE_DOCUMENTS.length)
    items.forEach((item, index) => {
      expect(item).toHaveTextContent(GUIDE_DOCUMENTS[index]!.title)
    })
  })

  test('a guide page lists every registered page and marks the current one', () => {
    render(<GuideEntryPage slug="introduction" onNavigate={vi.fn()} />)

    const nav = screen.getByRole('navigation', { name: 'Product guides' })
    expect(within(nav).getByRole('link', { name: 'Guides overview' })).toHaveAttribute(
      'href',
      '/guide',
    )
    const pageLinks = GUIDE_DOCUMENTS.map((guide) =>
      within(nav).getByRole('link', { name: guide.title }),
    )
    pageLinks.forEach((link, index) => {
      expect(link).toHaveAttribute('href', `/guide/${GUIDE_DOCUMENTS[index]!.slug}`)
    })
    expect(pageLinks[0]).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: /Open the API reference/ })).toHaveAttribute(
      'href',
      '/docs',
    )
    expect(within(nav).getByRole('link', { name: /Open the API reference/ })).not.toHaveAttribute(
      'aria-current',
    )
  })

  test('the article navigation returns to the catalog and the guide index', () => {
    render(<GuideEntryPage slug="introduction" onNavigate={vi.fn()} />)

    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(breadcrumb).getByRole('link', { name: 'Catalog' })).toHaveAttribute('href', '/')
    expect(within(breadcrumb).getByRole('link', { name: 'Guides' })).toHaveAttribute(
      'href',
      '/guide',
    )
    expect(within(breadcrumb).getByText('Introduction to AttestBook')).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  test('the API reference link leaves the guide for the separate /docs document', async () => {
    const onNavigate = vi.fn()
    render(<GuideEntryPage slug="introduction" onNavigate={onNavigate} />)

    const link = within(screen.getByRole('navigation', { name: 'Product guides' })).getByRole(
      'link',
      { name: /Open the API reference/ },
    )
    expect(link).toHaveAttribute('href', '/docs')

    await userEvent.setup().click(link)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  test('an unknown guide page keeps the navigation but marks no page current', () => {
    render(<GuideEntryPage slug="missing" onNavigate={vi.fn()} />)

    const nav = screen.getByRole('navigation', { name: 'Product guides' })
    expect(within(nav).getByRole('link', { name: 'Guides overview' })).toBeVisible()
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(0)
  })
})
