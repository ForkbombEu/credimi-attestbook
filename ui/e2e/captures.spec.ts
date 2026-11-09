import { readFileSync } from 'node:fs'

import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { EDITOR_TOKEN_FIXTURE, PID_CREDENTIAL_FIXTURE } from './fixtures'

function pidCredential(): string {
  return readFileSync(PID_CREDENTIAL_FIXTURE, 'utf8').trim()
}

function providerToken(): string {
  return readFileSync(EDITOR_TOKEN_FIXTURE, 'utf8').trim()
}

async function openExplorer(page: Page): Promise<void> {
  await page.goto('/captures')
  await expect(page.getByRole('heading', { name: 'Capture explorer', level: 1 })).toBeVisible()
  await expect(page.getByText('Mock-backed explorer')).toBeVisible()
}

async function openCapture(page: Page, captureId: string): Promise<void> {
  await page.goto(`/captures/${captureId}`)
  await expect(page.getByRole('heading', { level: 1, name: captureId })).toBeVisible()
}

async function choosePinnedVersion(page: Page): Promise<void> {
  await page.getByLabel('Rulebook', { exact: true }).selectOption({
    label: 'Validator Sandbox Rulebook',
  })
  await expect(page.getByLabel('Rulebook version')).toBeEnabled()
  await page.getByLabel('Rulebook version').selectOption('1.0')
  await page.getByLabel('Attestation type').selectOption({ label: 'Sandbox Credential' })
}

async function correlateRealCredential(page: Page, token: string = providerToken()): Promise<void> {
  await choosePinnedVersion(page)
  await page.getByLabel('Provider token').fill(token)
  await page.getByRole('button', { name: 'Run validation' }).click()
  await expect(page.getByRole('heading', { name: 'Overall result' })).toBeVisible()
}

test.describe('capture explorer', () => {
  test('lists the mock-backed captures and shows explicit evidence state', async ({ page }) => {
    await openExplorer(page)

    await expect(page.locator('tbody tr')).toHaveCount(8)
    await expect(page.getByRole('link', { name: 'e2e-issued-credential-capture' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'mock-capture-capture-issuer-1' })).toBeVisible()
    await expect(page.getByText('No rulebook binding').first()).toBeVisible()
    await expect(page.getByText('External artifact not fetched').first()).toBeVisible()
    await expect(page.getByText('Mock', { exact: true }).first()).toBeVisible()
  })

  test('shows a redacted JSON projection and never the raw claim values', async ({ page }) => {
    await openCapture(page, 'mock-capture-capture-issuer-3')

    await expect(page.getByText('Mock-backed capture evidence')).toBeVisible()
    const projection = page.getByLabel('Redacted artifact projection')
    await expect(projection).toContainText('[redacted]')
    await expect(projection).toContainText('urn:example:attestbook:mock:pid:1')
    const body = await page.locator('body').innerText()
    expect(body).not.toContain('synthetic-access-token-not-a-secret')
    expect(body).not.toContain('"given_name":"Test"')

    await expect(page.getByText('No rulebook binding')).toBeVisible()
    await expect(page.getByText('Validation not run').first()).toBeVisible()
  })

  test('reports an external artifact reference without offering validation', async ({ page }) => {
    await openCapture(page, 'mock-capture-capture-issuer-1')

    await expect(page.getByText('External artifact not fetched').first()).toBeVisible()
    await expect(
      page.getByRole('link', {
        name: /https:\/\/artifacts\.example\.test\/mock\/issuer-metadata\.json/,
      }),
    ).toBeVisible()
    await expect(
      page.getByText('Credential validation is not available for this evidence'),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Run validation' })).toHaveCount(0)
  })

  test('reports a non-credential artifact type as not validatable', async ({ page }) => {
    await openCapture(page, 'mock-capture-capture-verifier-2')

    await expect(page.getByText('Validation not applicable')).toBeVisible()
    await expect(page.getByText(/this artifact type carries no credential/).first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Run validation' })).toHaveCount(0)
  })

  test('correlates a captured credential with the pinned rulebook and shows the findings', async ({
    page,
  }) => {
    const credential = pidCredential()
    await openCapture(page, 'e2e-issued-credential-capture')

    const body = await page.locator('body').innerText()
    expect(body).not.toContain(credential)
    await expect(page.getByText(/This artifact is opaque \(not JSON\)/)).toBeVisible()

    await correlateRealCredential(page)

    const overall = page.getByRole('region', { name: 'Overall result' })
    await expect(overall).toContainText('Not tested')
    await expect(overall).toContainText('This is a structural, non-cryptographic result.')
    await expect(overall).toContainText('Sandbox Credential')

    await expect(page.getByText('Snapshot digest').first()).toBeVisible()
    await expect(page.getByText('1.0 · published')).toBeVisible()
    await expect(page.getByText(/linked to the pinned rulebook version/)).toBeVisible()
    await expect(page.getByText('Validation recorded')).toBeVisible()
    await expect(page.getByText('credimi-e2e-execution-48')).toBeVisible()
  })

  test('requires a provider token before recording a correlation', async ({ page }) => {
    // Use a capture no other test correlates, so a persisted result from an
    // earlier test in the shared in-memory explorer cannot mask the refusal.
    await openCapture(page, 'mock-capture-capture-issuer-3')
    await choosePinnedVersion(page)
    await page.getByRole('button', { name: 'Run validation' }).click()
    await expect(
      page.getByText('A provider token is required to record a correlation.'),
    ).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Overall result' })).toHaveCount(0)
  })

  test('has no detectable accessibility violations', async ({ page }) => {
    await openExplorer(page)
    await expect(page.locator('tbody tr')).toHaveCount(8)
    const listResults = await new AxeBuilder({ page }).analyze()
    expect(
      listResults.violations.map(
        (violation) =>
          `${violation.id}: ${violation.help} (${violation.nodes
            .map((node) => node.target.join(' '))
            .join(', ')})`,
      ),
    ).toEqual([])

    await openCapture(page, 'e2e-issued-credential-capture')
    await correlateRealCredential(page)
    const detailResults = await new AxeBuilder({ page }).analyze()
    expect(
      detailResults.violations.map(
        (violation) =>
          `${violation.id}: ${violation.help} (${violation.nodes
            .map((node) => node.target.join(' '))
            .join(', ')})`,
      ),
    ).toEqual([])
  })
})

test.describe('responsive capture explorer', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('keeps the capture list and detail readable without horizontal scrolling', async ({
    page,
  }) => {
    await openExplorer(page)
    await expect(page.locator('tbody tr')).toHaveCount(8)
    const listOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    expect(listOverflow).toBe(false)

    await openCapture(page, 'mock-capture-capture-issuer-3')
    await expect(page.getByLabel('Redacted artifact projection')).toBeVisible()
    const detailOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    expect(detailOverflow).toBe(false)
  })
})
