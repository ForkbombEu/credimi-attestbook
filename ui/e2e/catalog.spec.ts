import { AxeBuilder } from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.describe('rulebook catalog against the real API', () => {
  test('lists rulebooks with provider, version, status and attestation information', async ({
    page,
  }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'Rulebook catalog' })).toBeVisible()
    const rows = page.locator('tbody tr')
    await expect(rows).toHaveCount(7)

    const pid = page.getByRole('row', { name: /PID Rulebook/ })
    await expect(pid).toContainText('Example Issuer')
    await expect(pid).toContainText('Person Identification Data')
    await expect(pid).toContainText('1.0')
    await expect(pid).toContainText('Published · 2 versions')
    await expect(pid).toContainText('Draft')
    await expect(pid).toContainText('Not tested')
    await expect(pid.getByRole('link', { name: /issuer\.example\.org/ })).toBeVisible()

    const age = page.getByRole('row', { name: /Age Verification Rulebook/ })
    await expect(age).toContainText('Draft')
    await expect(age).toContainText('No versions yet')
    await expect(age).toContainText('Locally authored')
  })

  test('filters by search text, provider and status', async ({ page }) => {
    await page.goto('/')
    const rows = page.locator('tbody tr')
    await expect(rows).toHaveCount(7)

    await page.getByLabel('Search').fill('age')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Age Verification Rulebook')
    await expect(page.getByRole('status')).toContainText('Showing 1 of 7 rulebooks')

    await page.getByLabel('Search').fill('')
    await page.getByLabel('Provider').selectOption({ label: 'Wallet Lab' })
    await expect(rows).toHaveCount(2)
    await expect(page.getByRole('row', { name: /Loyalty Card Rulebook/ })).toBeVisible()

    await page.getByLabel('Provider').selectOption({ label: 'All providers' })
    await page.getByLabel('Status').selectOption({ label: 'Published' })
    await expect(rows).toHaveCount(3)
    await expect(page.getByRole('row', { name: /Health Insurance Card Rulebook/ })).toBeVisible()
    await expect(page.getByRole('row', { name: /PID Rulebook/ })).toHaveCount(0)

    await page.getByLabel('Status').selectOption({ label: 'All statuses' })
    await expect(rows).toHaveCount(7)
  })

  test('shows the filtered empty state and resets it', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('tbody tr')).toHaveCount(7)

    await page.getByLabel('Search').fill('no-such-rulebook')

    await expect(
      page.getByRole('heading', { name: 'No rulebooks match your filters' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Reset search and filters' }).click()
    await expect(page.locator('tbody tr')).toHaveCount(7)
    await expect(page.getByLabel('Search')).toHaveValue('')
  })

  test('shows a loading state while the catalogue request is pending', async ({ page }) => {
    await page.route('**/api/v1/rulebooks?*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      await route.continue()
    })

    await page.goto('/')

    await expect(page.getByRole('status').first()).toContainText('Loading rulebooks…')
    await expect(page.locator('tbody tr')).toHaveCount(7)
  })

  test('shows an API error and retries successfully', async ({ page }) => {
    await page.route('**/api/v1/providers', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'registry_unavailable',
            message: 'The rulebook registry is not configured on this server.',
          },
        }),
      })
    })

    await page.goto('/')

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('The rulebook catalog could not be loaded.')
    await expect(alert).toContainText('The rulebook registry is not configured on this server.')

    await page.unroute('**/api/v1/providers')
    await page.getByRole('button', { name: 'Retry' }).click()

    await expect(page.locator('tbody tr')).toHaveCount(7)
  })

  test('has no detectable accessibility violations', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('tbody tr')).toHaveCount(7)

    const results = await new AxeBuilder({ page }).analyze()
    expect(
      results.violations.map(
        (violation) =>
          `${violation.id}: ${violation.help} (${violation.nodes
            .map((node) => node.target.join(' '))
            .join(', ')})`,
      ),
    ).toEqual([])
  })
})

test.describe('responsive catalog', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('keeps the catalog readable without horizontal scrolling', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Rulebook catalog' })).toBeVisible()
    await expect(page.locator('tbody tr')).toHaveCount(7)

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    expect(hasHorizontalOverflow).toBe(false)

    await expect(page.getByLabel('Search')).toBeVisible()
    await expect(page.getByRole('row', { name: /PID Rulebook/ })).toBeVisible()
  })
})
