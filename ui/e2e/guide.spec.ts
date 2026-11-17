// Browser smoke tests for the public Markdown-based product guide (issue #130).
//
// The real production build is served by the real HTTP application (see
// ./server.ts). The guide must render from Markdown bundled into that build,
// survive a reload of a deep link, show an explicit not-found view for an
// unknown slug, and load no third-party asset.

import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const INDEX_HEADING = 'AttestBook product guide'
const INTRODUCTION_HEADING = 'Introduction to AttestBook'

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
  await expect(page.getByRole('link', { name: 'API reference' })).toHaveAttribute('href', '/docs')
  await expect(page.locator('.guide-article pre code')).toContainText('/api/v1/rulebooks')

  // The guide is public: no sign-in page and no third-party asset.
  await expect(page).not.toHaveURL(/\/login/)
  expect(external).toEqual([])

  await expectNoA11yViolations(page)
})

test('opens the API reference from the guide with a full page load', async ({ page }) => {
  await page.goto('/guide/introduction')
  await expect(page.getByRole('heading', { name: INTRODUCTION_HEADING, level: 1 })).toBeVisible()

  await page.getByRole('link', { name: 'API reference' }).click()

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
