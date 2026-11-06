import { readFileSync } from 'node:fs'

import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { PID_CREDENTIAL_FIXTURE } from './fixtures'

function pidCredential(): string {
  return readFileSync(PID_CREDENTIAL_FIXTURE, 'utf8').trim()
}

async function openPlayground(page: Page): Promise<void> {
  await page.goto('/playground')
  await expect(page.getByRole('heading', { name: 'Credential playground', level: 1 })).toBeVisible()
  await expect(page.getByLabel('Rulebook', { exact: true })).toBeVisible()
}

async function chooseRequest(
  page: Page,
  rulebook: string,
  version: string,
  attestation: string,
): Promise<void> {
  await page.getByLabel('Rulebook', { exact: true }).selectOption({ label: rulebook })
  await expect(page.getByLabel('Rulebook version')).toBeEnabled()
  await page.getByLabel('Rulebook version').selectOption(version)
  await page.getByLabel('Attestation type').selectOption({ label: attestation })
}

async function runValidation(page: Page, credential: string): Promise<void> {
  await page.getByLabel('Credential', { exact: true }).fill(credential)
  await page.getByRole('button', { name: 'Run validation' }).click()
  await expect(page.getByRole('heading', { name: 'Overall result' })).toBeVisible()
}

test.describe('credential playground against the real validation API', () => {
  test('validates a credential, exposes untested dimensions and exports the result', async ({
    page,
  }) => {
    const credential = pidCredential()
    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))

    await openPlayground(page)
    await chooseRequest(page, 'Validator Sandbox Rulebook', '1.0', 'Sandbox Credential')
    await runValidation(page, credential)

    const overall = page.getByRole('region', { name: 'Overall result' })
    await expect(overall.getByText('Not tested', { exact: true })).toBeVisible()
    await expect(overall).toContainText('This is a structural, non-cryptographic result.')
    await expect(overall).toContainText('Sandbox Credential')

    const notice = page.getByText('Untested dimensions are not passes.')
    await expect(notice).toBeVisible()
    await expect(
      page.getByText(
        '3 of 6 applicable dimensions did not execute, and 2 dimensions are not applicable to a single credential artifact.',
      ),
    ).toBeVisible()

    const dimensions = page.getByRole('region', { name: 'Validation dimensions' })
    await expect(
      dimensions.getByRole('rowheader', { name: 'Cryptographic verification' }),
    ).toBeVisible()
    await expect(dimensions.getByRole('rowheader', { name: 'Credential parsing' })).toBeVisible()
    await expect(
      dimensions.getByRole('rowheader', { name: 'End-to-end interoperability' }),
    ).toBeVisible()
    await expect(dimensions.getByText('Not executed').first()).toBeVisible()
    await expect(dimensions.getByText('Not applicable').first()).toBeVisible()
    await expect(dimensions.getByText('Not tested', { exact: true })).toHaveCount(3)

    // The API flattens every error/warning finding, including the explicit
    // "not verified" warnings of the unexecuted dimensions.
    const violations = page.getByRole('region', { name: 'Violations' })
    await expect(violations).toContainText('signature_not_verified')
    await expect(violations).toContainText('schema_document_not_supplied')
    await expect(violations).toContainText('/credential')

    const limitations = page.getByRole('region', { name: 'Limitations of this result' })
    await expect(limitations).toContainText('signature_not_verified')
    await expect(limitations).toContainText('trust_not_evaluated')

    // The credential was posted to the validation API and never placed in a
    // URL; the run is the real API, not a client-side mock.
    expect(requests.some((url) => url.endsWith('/api/v1/credentials/validate'))).toBe(true)
    for (const url of requests) {
      expect(url).not.toContain(credential.slice(0, 40))
    }

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export result (JSON)' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/^attestbook-validation-.+\.json$/)
    const path = await download.path()
    expect(path).not.toBeNull()
    const exportedText = readFileSync(path, 'utf8')
    const exported = JSON.parse(exportedText) as {
      overallStatus: string
      dimensions: unknown[]
      violations: unknown[]
    }
    expect(exported.overallStatus).toBe('NOT_TESTED')
    expect(exported.dimensions).toHaveLength(8)
    expect(exportedText).not.toContain(credential)
  })

  test('inspects individual violations when a validation dimension fails', async ({ page }) => {
    await openPlayground(page)
    await chooseRequest(page, 'Mobile Driving Licence Rulebook', '2.0', 'Mobile Driving Licence')
    await runValidation(page, pidCredential())

    const overall = page.getByRole('region', { name: 'Overall result' })
    await expect(overall.getByText('Failed', { exact: true })).toBeVisible()
    await expect(overall).toContainText(
      'This credential is not valid for the pinned rulebook version.',
    )

    const violations = page.getByRole('region', { name: 'Violations' })
    await expect(violations).toContainText('format_not_supported_by_rulebook')
    await expect(violations).toContainText(
      'The selected attestation type does not support the "dc+sd-jwt" credential format.',
    )
    await expect(violations).toContainText('format is one of mso_mdoc')
    await expect(violations).toContainText('/credential')

    const dimensions = page.getByRole('region', { name: 'Validation dimensions' })
    await expect(
      dimensions.getByRole('row', { name: /Attestation-specific constraints/ }),
    ).toContainText('Failed')
  })

  test('surfaces an API error without leaking the credential and retries successfully', async ({
    page,
  }) => {
    const credential = pidCredential()
    await openPlayground(page)
    await chooseRequest(page, 'Validator Sandbox Rulebook', '1.0', 'Sandbox Credential')
    await page.getByLabel('Credential', { exact: true }).fill(credential)

    await page.route('**/api/v1/credentials/validate', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'validation_unavailable',
            message: 'Credential validation is not configured on this server.',
          },
        }),
      })
    })

    await page.getByRole('button', { name: 'Run validation' }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('The validation request failed.')
    await expect(alert).toContainText('Credential validation is not configured on this server.')
    await expect(alert).not.toContainText(credential)
    await expect(page.getByLabel('Credential', { exact: true })).toHaveValue(credential)

    await page.unroute('**/api/v1/credentials/validate')
    await alert.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByRole('heading', { name: 'Overall result' })).toBeVisible()
  })

  test('validates a credential uploaded from a file', async ({ page }) => {
    await openPlayground(page)
    await chooseRequest(page, 'Validator Sandbox Rulebook', '1.0', 'Sandbox Credential')

    await page.getByLabel('Upload a credential file').setInputFiles(PID_CREDENTIAL_FIXTURE)
    await expect(page.getByLabel('Credential', { exact: true })).toHaveValue(pidCredential())

    await page.getByRole('button', { name: 'Run validation' }).click()
    await expect(page.getByRole('heading', { name: 'Overall result' })).toBeVisible()
    await expect(page.getByText('Untested dimensions are not passes.')).toBeVisible()
  })

  test('rejects an incomplete request in the browser without calling the API', async ({ page }) => {
    const validationRequests: string[] = []
    page.on('request', (request) => {
      if (request.url().endsWith('/api/v1/credentials/validate')) {
        validationRequests.push(request.url())
      }
    })

    await openPlayground(page)
    await page.getByRole('button', { name: 'Run validation' }).click()

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('Check the request before running validation')
    await expect(alert).toContainText('Select a rulebook.')
    await expect(alert).toContainText('Select a rulebook version.')
    await expect(alert).toContainText('Select an attestation type.')
    await expect(alert).toContainText('Paste or upload a credential.')
    expect(validationRequests).toHaveLength(0)
  })

  test('has no detectable accessibility violations on the form and the result', async ({
    page,
  }) => {
    await openPlayground(page)
    await chooseRequest(page, 'Validator Sandbox Rulebook', '1.0', 'Sandbox Credential')
    await runValidation(page, pidCredential())

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

test.describe('responsive credential playground', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('keeps the form and result readable without horizontal scrolling', async ({ page }) => {
    await openPlayground(page)
    await chooseRequest(page, 'Validator Sandbox Rulebook', '1.0', 'Sandbox Credential')
    await runValidation(page, pidCredential())

    await expect(page.getByRole('region', { name: 'Validation dimensions' })).toBeVisible()

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    expect(hasHorizontalOverflow).toBe(false)
  })
})
