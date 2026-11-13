import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { E2E_ADMIN_PASSWORD, E2E_ADMIN_USERNAME } from './fixtures'

async function signIn(page: Page): Promise<void> {
  await page.getByLabel('Username').fill(E2E_ADMIN_USERNAME)
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test.describe('administrator browser login against the real API', () => {
  test('signs in from /login, survives a reload and logs out to public browsing', async ({
    page,
  }) => {
    await page.goto('/login')

    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByLabel('Username')).toBeVisible()
    await expect(page.getByLabel('Password')).toBeVisible()
    // The browser login never asks for a provider bearer token.
    await expect(page.locator('input[name="token"], input[type="token"]')).toHaveCount(0)

    await signIn(page)

    await expect(page).toHaveURL('/')
    await expect(page.getByRole('heading', { name: 'Rulebook catalog' })).toBeVisible()
    const identity = page.locator('.site-session__provider')
    await expect(identity).toHaveText('Example Issuer')
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible()

    // The session cookie is the only credential the browser holds.
    const storage = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }))
    expect(storage).toEqual({ local: [], session: [] })

    // A reload restores the session from GET /api/v1/auth/me.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Rulebook catalog' })).toBeVisible()
    await expect(identity).toHaveText('Example Issuer')
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible()

    await page.getByRole('button', { name: 'Log out' }).click()
    await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible()
    await expect(identity).toHaveCount(0)

    // The catalogue is still anonymously usable after logout.
    await expect(page.getByRole('heading', { name: 'Rulebook catalog' })).toBeVisible()
    await expect(page.locator('tbody tr')).toHaveCount(7)
  })

  test('returns to a same-origin intended destination after sign-in', async ({ page }) => {
    await page.goto('/login?next=%2Fplayground')

    await signIn(page)

    await expect(page).toHaveURL('/playground')
    await expect(page.getByRole('heading', { name: 'Credential playground' })).toBeVisible()
  })

  test('refuses an off-site next target and stays on this application', async ({ page }) => {
    await page.goto('/login?next=https%3A%2F%2Fevil.example%2Fsteal')

    await signIn(page)

    await expect(page).toHaveURL('/')
    expect(page.url()).not.toContain('evil.example')
  })

  test('shows a working state while the login request is pending', async ({ page }) => {
    await page.route('**/api/v1/auth/login', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350))
      await route.continue()
    })
    await page.goto('/login')

    await signIn(page)

    await expect(page.getByRole('button', { name: 'Signing in…' })).toBeDisabled()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible()
  })

  test('reports rejected credentials with the API safe message', async ({ page }) => {
    await page.goto('/login')

    await page.getByLabel('Username').fill(E2E_ADMIN_USERNAME)
    await page.getByLabel('Password').fill('not-the-password')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page.getByRole('alert')).toHaveText('Invalid username or password.')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })

  test('has no detectable accessibility violations and fits a narrow viewport', async ({
    page,
  }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

    const results = await new AxeBuilder({ page }).analyze()
    expect(
      results.violations.map(
        (violation) =>
          `${violation.id}: ${violation.help} (${violation.nodes
            .map((node) => node.target.join(' '))
            .join(', ')})`,
      ),
    ).toEqual([])

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/login')
    await expect(page.getByLabel('Username')).toBeVisible()

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    expect(hasHorizontalOverflow).toBe(false)
  })
})
