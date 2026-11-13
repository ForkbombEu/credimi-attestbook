// Shared browser sign-in helper for the e2e specs (issue #91).
//
// The editor, lifecycle and capture writes now use the administrator browser
// session, so a spec that exercises a protected action signs in through the
// real `/login` form first. Each Playwright test gets a fresh browser context,
// hence a fresh anonymous session.

import { expect, type Page } from '@playwright/test'

import { E2E_ADMIN_PASSWORD, E2E_ADMIN_USERNAME } from './fixtures'

export async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Username').fill(E2E_ADMIN_USERNAME)
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible()
}
