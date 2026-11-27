// Browser smoke tests for the public interactive API reference (issue #126).
//
// The real production build is served by the real HTTP application (see
// ./server.ts). The reference must render from the same-origin contract, fetch
// no third-party asset, and survive a reload of `/docs`.

import { expect, test, type Page } from '@playwright/test'

const REFERENCE_TITLE = 'AttestBook product API'
const RULEBOOKS_OPERATION = '/api/v1/rulebooks'

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

test('serves the product API reference from /docs without third-party assets', async ({
  page,
  baseURL,
}) => {
  const { external } = watchRequests(page, baseURL)
  const contract = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/openapi.json',
  )

  const response = await page.goto('/docs')
  expect(response?.status()).toBe(200)
  expect((await contract).ok()).toBe(true)
  await page.waitForLoadState('networkidle')

  await expect(page.getByRole('heading', { name: REFERENCE_TITLE })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'service' })).toBeVisible()

  // The reference is a separate document with its own way back into the
  // product: the Catalog and the Guides stay one click away (issue #131).
  const documentation = page.getByRole('navigation', { name: 'Documentation' })
  await expect(documentation.getByRole('link', { name: 'Catalog' })).toHaveAttribute('href', '/')
  await expect(documentation.getByRole('link', { name: 'Guides' })).toHaveAttribute(
    'href',
    '/guide',
  )
  await expect(documentation.getByRole('link', { name: 'API reference' })).toHaveAttribute(
    'aria-current',
    'page',
  )

  // Expand the rulebooks group and assert one real generated operation.
  await page.getByText('rulebooks', { exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'List rulebooks' })).toBeVisible()
  await expect(page.getByText(RULEBOOKS_OPERATION, { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Query Parameters' })).toBeVisible()
  // The generated document's security schemes are rendered by the reference.
  await expect(page.getByText('Authentication').first()).toBeVisible()

  expect(external).toEqual([])
})

test('leaves the Scalar reference styling untouched', async ({ page }) => {
  await page.goto('/docs')
  await expect(page.getByRole('heading', { name: REFERENCE_TITLE })).toBeVisible()

  const result = await page.evaluate(() => {
    const sectionHeadings = Array.from(document.querySelectorAll('#docs-root .section-header h2'))
    return {
      brandStylesheet: document.querySelector('link[href^="/brand/style.css"]') !== null,
      sectionCount: sectionHeadings.length,
      sectionAfter: sectionHeadings.map((heading) => getComputedStyle(heading, '::after').content),
    }
  })

  // The SPA brand stylesheet would override Scalar's layered base styles (and
  // add a colon to Scalar's section headers), so the docs entry must not load it.
  expect(result.brandStylesheet).toBe(false)
  expect(result.sectionCount).toBeGreaterThan(0)
  for (const after of result.sectionAfter) {
    expect(['none', 'normal']).toContain(after)
  }
})

test('keeps the Scalar sidebar below the sticky documentation header', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/docs')
  await expect(page.getByRole('heading', { name: REFERENCE_TITLE })).toBeVisible()

  const chrome = page.locator('.docs-chrome')
  const sidebar = page.locator('#docs-root aside').first()
  const chromeBefore = await chrome.boundingBox()
  const sidebarBefore = await sidebar.boundingBox()
  expect(chromeBefore).not.toBeNull()
  expect(sidebarBefore).not.toBeNull()
  // Scalar's sidebar fits the viewport below the header; its footer (theme
  // toggle and Scalar credit) is not pushed below the fold.
  expect((sidebarBefore?.y ?? 0) + (sidebarBefore?.height ?? 0)).toBeLessThanOrEqual(1000 + 1)

  await page.evaluate(() => window.scrollTo(0, 1500))
  await expect
    .poll(async () => {
      const box = await sidebar.boundingBox()
      return box === null ? 0 : Math.round(box.y)
    })
    .toBeGreaterThanOrEqual(Math.floor((chromeBefore?.y ?? 0) + (chromeBefore?.height ?? 0)) - 1)

  const search = sidebar.getByRole('button').first()
  const searchBox = await search.boundingBox()
  const chromeAfter = await chrome.boundingBox()
  expect(searchBox).not.toBeNull()
  expect(chromeAfter).not.toBeNull()
  expect(searchBox?.y ?? 0).toBeGreaterThanOrEqual(
    (chromeAfter?.y ?? 0) + (chromeAfter?.height ?? 0) - 1,
  )
})

test('keeps the reference and its documentation header usable at 390 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/docs')
  await expect(page.getByRole('heading', { name: REFERENCE_TITLE })).toBeVisible()

  const documentation = page.getByRole('navigation', { name: 'Documentation' })
  await expect(documentation.getByRole('link', { name: 'Catalog' })).toBeVisible()
  await expect(documentation.getByRole('link', { name: 'Guides' })).toBeVisible()
  await expect(documentation.getByRole('link', { name: 'API reference' })).toBeVisible()

  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )
  expect(horizontalOverflow).toBeLessThanOrEqual(1)
})

test('keeps the reference on /docs after a reload', async ({ page }) => {
  await page.goto('/docs')
  await expect(page.getByRole('heading', { name: REFERENCE_TITLE })).toBeVisible()

  const contract = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/openapi.json',
  )
  await page.reload()

  expect((await contract).ok()).toBe(true)
  expect(new URL(page.url()).pathname).toBe('/docs')
  await expect(page.getByRole('heading', { name: REFERENCE_TITLE })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'service' })).toBeVisible()
})

test('returns from the reference to the product guides', async ({ page }) => {
  await page.goto('/docs')
  await expect(page.getByRole('heading', { name: REFERENCE_TITLE })).toBeVisible()

  await page
    .getByRole('navigation', { name: 'Documentation' })
    .getByRole('link', { name: 'Guides' })
    .click()

  await expect(page).toHaveURL(/\/guide$/)
  await expect(
    page.getByRole('heading', { name: 'AttestBook product guide', level: 1 }),
  ).toBeVisible()
})
