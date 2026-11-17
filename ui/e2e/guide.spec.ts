// Browser smoke tests for the public Markdown-based product guide (issue #130)
// and the navigation between the catalog, the guides and the separate Scalar
// API reference at `/docs` (issue #131).
//
// The real production build is served by the real HTTP application (see
// ./server.ts). The guide must render from Markdown bundled into that build,
// survive a reload of a deep link, show an explicit not-found view for an
// unknown slug, and load no third-party asset.

import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const INDEX_HEADING = 'AttestBook product guide'
const INTRODUCTION_HEADING = 'Introduction to AttestBook'
const API_INTEGRATION_HEADING = 'API integration'

function watchRequests(page: Page, baseURL: string | undefined): { external: string[] } {
  const origin = new URL(baseURL ?? 'http://127.0.0.1:4173').origin
  const external: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== origin) {
      external.push(request.url())
    }
  })
  return { external }
}

async function expectNoA11yViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze()
  expect(
    results.violations.map(
      (violation) =>
        `${violation.id}: ${violation.help} (${violation.nodes
          .map((node) => node.target.join(' '))
          .join(', ')})`,
    ),
  ).toEqual([])
}

test('opens the public product guide and follows the introduction link', async ({
  page,
  baseURL,
}) => {
  const { external } = watchRequests(page, baseURL)

  const response = await page.goto('/guide')
  expect(response?.status()).toBe(200)

  await expect(page.getByRole('heading', { name: INDEX_HEADING, level: 1 })).toBeVisible()
  await page.getByRole('link', { name: /Introduction to AttestBook/ }).click()

  await expect(page).toHaveURL(/\/guide\/introduction$/)
  await expect(page.getByRole('heading', { name: INTRODUCTION_HEADING, level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What AttestBook does' })).toBeVisible()
  await expect(
    page.locator('.guide-article').getByRole('link', { name: 'API reference' }),
  ).toHaveAttribute('href', '/docs')
  await expect(page.locator('.guide-article pre code')).toContainText('/api/v1/rulebooks')

  // The guide is public: no sign-in page and no third-party asset.
  await expect(page).not.toHaveURL(/\/login/)
  expect(external).toEqual([])

  await expectNoA11yViolations(page)
})

test('opens the capture explorer guide and reaches the mock-backed explorer', async ({
  page,
  baseURL,
}) => {
  const { external } = watchRequests(page, baseURL)

  const response = await page.goto('/guide')
  expect(response?.status()).toBe(200)

  await page
    .getByRole('list', { name: 'Product guides' })
    .getByRole('link', { name: /Capture explorer/ })
    .click()

  await expect(page).toHaveURL(/\/guide\/capture-explorer$/)
  await expect(page.getByRole('heading', { name: 'Capture explorer', level: 1 })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Mock-backed evidence is labelled, not implied' }),
  ).toBeVisible()

  // The guide names the mock boundary and links to the explorer it documents.
  const article = page.locator('.guide-article')
  await expect(article).toContainText('Mock-backed')
  await expect(article).toContainText('not implemented and are not claimed')
  await expect(
    article.getByRole('link', { name: 'the capture explorer', exact: true }),
  ).toHaveAttribute('href', '/captures')

  await article.getByRole('link', { name: 'the capture explorer', exact: true }).click()
  await expect(page).toHaveURL(/\/captures$/)
  await expect(page.getByRole('heading', { name: 'Capture explorer', level: 1 })).toBeVisible()
  await expect(page.getByText('Mock-backed explorer')).toBeVisible()

  await expect(page).not.toHaveURL(/\/login/)
  expect(external).toEqual([])
})

test('reads the API integration guide from the index and reaches both references', async ({
  page,
  baseURL,
}) => {
  const { external } = watchRequests(page, baseURL)

  await page.goto('/guide')
  const card = page.getByRole('link', { name: /^API integration/ })
  await expect(card).toHaveAttribute('href', '/guide/api-integration')
  await card.click()

  await expect(page).toHaveURL(/\/guide\/api-integration$/)
  await expect(page.getByRole('heading', { name: API_INTEGRATION_HEADING, level: 1 })).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Provider bearer token for headless clients' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Administrator browser session for UI writes' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Subscription management is a separate credential' }),
  ).toBeVisible()

  const article = page.locator('.guide-article')
  const openapiLinks = article.getByRole('link', { name: 'OpenAPI 3.1 contract' })
  await expect(openapiLinks).toHaveCount(2)
  await expect(openapiLinks.first()).toHaveAttribute('href', '/openapi.json')
  const referenceLinks = article.getByRole('link', { name: 'interactive Scalar reference' })
  await expect(referenceLinks).toHaveCount(2)
  await expect(referenceLinks.first()).toHaveAttribute('href', '/docs')

  // The linked contract is the stable OpenAPI 3.1 document, not an SPA page.
  const openapiResponse = await page.request.get('/openapi.json')
  expect(openapiResponse.status()).toBe(200)
  const openapiDocument = (await openapiResponse.json()) as { openapi?: string }
  expect(openapiDocument.openapi).toMatch(/^3\.1\./)

  await page.reload()
  expect(new URL(page.url()).pathname).toBe('/guide/api-integration')
  await expect(page.getByRole('heading', { name: API_INTEGRATION_HEADING, level: 1 })).toBeVisible()

  // The guide is public and self-contained: no sign-in and no third-party asset.
  await expect(page).not.toHaveURL(/\/login/)
  expect(external).toEqual([])
  await expectNoA11yViolations(page)
})

test('opens the API reference from the guide with a full page load', async ({ page }) => {
  await page.goto('/guide/introduction')
  await expect(page.getByRole('heading', { name: INTRODUCTION_HEADING, level: 1 })).toBeVisible()

  await page.locator('.guide-article').getByRole('link', { name: 'API reference' }).click()

  await page.waitForURL(/\/docs$/)
  await expect(page.getByRole('heading', { name: 'AttestBook product API' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'service' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Rulebook catalog' })).toHaveCount(0)
})

test('keeps a guide deep link after a reload', async ({ page }) => {
  await page.goto('/guide/introduction')
  await expect(page.getByRole('heading', { name: INTRODUCTION_HEADING, level: 1 })).toBeVisible()

  await page.reload()

  expect(new URL(page.url()).pathname).toBe('/guide/introduction')
  await expect(page.getByRole('heading', { name: INTRODUCTION_HEADING, level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'What AttestBook does' })).toBeVisible()
})

test('shows an accessible not-found view for an unknown guide slug', async ({ page }) => {
  await page.goto('/guide/no-such-guide')

  await expect(page.getByRole('heading', { name: 'Guide page not found', level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Back to the product guide' })).toHaveAttribute(
    'href',
    '/guide',
  )
  // The catalog's own heading must not appear in the fallback.
  await expect(page.getByRole('heading', { name: 'Rulebook catalog' })).toHaveCount(0)

  await expectNoA11yViolations(page)
})

test('opens the guide index from the catalog primary navigation', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Rulebook catalog', level: 1 })).toBeVisible()

  const primary = page.getByRole('navigation', { name: 'Primary' })
  await primary.getByRole('link', { name: 'Guides' }).click()

  await expect(page).toHaveURL(/\/guide$/)
  await expect(page.getByRole('heading', { name: INDEX_HEADING, level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: /Introduction to AttestBook/ })).toHaveAttribute(
    'href',
    '/guide/introduction',
  )
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Guides' }),
  ).toHaveAttribute('aria-current', 'page')
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Catalog' }),
  ).toHaveAttribute('href', '/')
  await expect(page).not.toHaveURL(/\/login/)
})

test('shows the current guide page and opens the separate API reference with a way back', async ({
  page,
}) => {
  await page.goto('/guide/introduction')

  const guideNav = page.getByRole('navigation', { name: 'Product guides' })
  await expect(guideNav.getByRole('link', { name: INTRODUCTION_HEADING })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await expect(
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Guides' }),
  ).toHaveAttribute('aria-current', 'page')

  await guideNav.getByRole('link', { name: /Open the API reference/ }).click()

  await page.waitForURL(/\/docs$/)
  await expect(page.getByRole('heading', { name: 'AttestBook product API' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'service' })).toBeVisible()

  // The reference's own documentation chrome keeps the way back to the guides.
  await page
    .getByRole('navigation', { name: 'Documentation' })
    .getByRole('link', { name: 'Guides' })
    .click()
  await page.waitForURL(/\/guide$/)
  await expect(page.getByRole('heading', { name: INDEX_HEADING, level: 1 })).toBeVisible()
})

test('keeps the guide navigation reachable in the wrapped header at 860 px', async ({ page }) => {
  await page.setViewportSize({ width: 860, height: 900 })
  await page.goto('/guide')

  const primary = page.getByRole('navigation', { name: 'Primary' })
  await expect(primary.getByRole('link', { name: 'Guides' })).toBeVisible()
  await expect(primary.getByRole('link', { name: 'API reference' })).toBeVisible()

  // The header wraps into two rows instead of widening the page; the page-level
  // horizontal overflow that remains comes from the pre-existing decorative
  // page-heading motif, so assert the header itself fits the viewport.
  const header = await page.locator('.site-header').boundingBox()
  expect(header).not.toBeNull()
  expect((header?.x ?? 0) + (header?.width ?? 0)).toBeLessThanOrEqual(860)
  const rows = await page
    .locator('.site-header__inner')
    .evaluate((element) => (element as HTMLElement).offsetHeight)
  expect(rows).toBeGreaterThan(56)
})

test('keeps the guide navigation keyboard reachable and the article readable at 390 px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/guide/introduction')

  await expect(page.getByRole('heading', { name: INTRODUCTION_HEADING, level: 1 })).toBeVisible()

  const guideNav = page.getByRole('navigation', { name: 'Product guides' })
  await expect(guideNav).toBeVisible()
  const current = guideNav.getByRole('link', { name: INTRODUCTION_HEADING })
  await expect(current).toHaveAttribute('aria-current', 'page')
  await current.focus()
  await expect(current).toBeFocused()
  await expect(guideNav.getByRole('link', { name: /Open the API reference/ })).toBeVisible()

  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(horizontalOverflow).toBeLessThanOrEqual(1)

  await expectNoA11yViolations(page)
})
