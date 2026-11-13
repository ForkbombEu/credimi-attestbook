import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

async function pidDetail(page: Page): Promise<string> {
  await page.goto('/')
  const link = page.getByRole('link', { name: 'PID Rulebook' })
  const href = await link.getAttribute('href')
  expect(href).not.toBeNull()
  return href!
}

test.describe('rulebook detail against the real API', () => {
  test('opens from the catalog and shows metadata, attestations, references and provenance', async ({
    page,
  }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'PID Rulebook' }).click()

    await expect(page).toHaveURL(/\/rulebooks\/[0-9a-f-]+$/)
    await expect(page.getByRole('heading', { name: 'PID Rulebook', level: 1 })).toBeVisible()

    const metadata = page.getByRole('region', { name: 'Rulebook metadata' })
    await expect(metadata).toContainText('Example Issuer')
    await expect(metadata).toContainText('Draft')
    await expect(metadata).toContainText('ts11@1.0.1')

    const attestations = page.getByRole('region', { name: 'Attestation types' })
    await expect(attestations).toContainText('Person Identification Data')
    await expect(attestations).toContainText('iso_18045_high')
    await expect(attestations).toContainText('cryptographic')
    await expect(attestations).toContainText('dc+sd-jwt')

    const references = page.getByRole('region', { name: 'Schema references' })
    await expect(
      references.getByRole('link', { name: /https:\/\/issuer\.example\.org\/schemas\/pid/ }),
    ).toHaveAttribute('href', 'https://issuer.example.org/schemas/pid')
    await expect(references).toContainText('sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=')

    const provenance = page.getByRole('region', { name: 'Source provenance' })
    await expect(
      provenance.getByRole('link', { name: /https:\/\/issuer\.example\.org\/rulebooks\/pid/ }),
    ).toHaveAttribute('href', 'https://issuer.example.org/rulebooks/pid')
    await expect(provenance).toContainText('Registered')
    await expect(provenance).toContainText('Last updated')
  })

  test('shows version history newest first with statuses, digests and exports', async ({
    page,
  }) => {
    await page.goto(await pidDetail(page))

    const versions = page.getByRole('region', { name: 'Version history' })
    await expect(versions).toContainText('1.1')
    await expect(versions).toContainText('1.0')
    await expect(versions).toContainText('Draft')
    await expect(versions).toContainText('Published')
    await expect(versions).toContainText('Latest')
    await expect(versions).toContainText('Not published')

    const exportLink = versions.getByRole('link', { name: 'Export version 1.0 snapshot' })
    await expect(exportLink).toHaveAttribute('href', /\/versions\/1\.0\/content$/)
    await expect(exportLink).toHaveAttribute('download', /rulebook-.*-1\.0\.json/)
  })

  test('marks unsupported standards evaluations explicitly', async ({ page }) => {
    await page.goto(await pidDetail(page))

    const compatibility = page.getByRole('region', { name: 'Standards compatibility' })
    await expect(compatibility).toContainText('Rulebook-level compatibility: not tested.')
    await expect(compatibility).toContainText('Cryptographic verification')
    await expect(compatibility).toContainText('Issuer and trust-policy validation')
    await expect(compatibility).toContainText('Protocol conformance')
    await expect(compatibility).toContainText('End-to-end interoperability')
    await expect(compatibility).toContainText('No rulebook-level compatibility result is recorded.')
    await expect(compatibility.getByText('Not tested', { exact: true })).toHaveCount(3)
    await expect(compatibility.getByText('Not applicable', { exact: true })).toHaveCount(2)
  })

  test('keeps a deep-linked detail page after a reload and returns to the catalog', async ({
    page,
  }) => {
    const detailUrl = await pidDetail(page)
    await page.goto(detailUrl)
    await expect(page.getByRole('heading', { name: 'PID Rulebook', level: 1 })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { name: 'PID Rulebook', level: 1 })).toBeVisible()

    await page.getByRole('link', { name: 'Rulebook catalog' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('heading', { name: 'Rulebook catalog', level: 1 })).toBeVisible()
  })

  test('shows the not-found state for an unknown rulebook', async ({ page }) => {
    await page.goto('/rulebooks/00000000-0000-4000-8000-000000000000')

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('Rulebook not found')
    await expect(alert).toContainText('No rulebook matches this address.')

    await page.getByRole('button', { name: 'Back to the catalog' }).click()
    await expect(page).toHaveURL('/')
    await expect(page.getByRole('heading', { name: 'Rulebook catalog', level: 1 })).toBeVisible()
  })

  test('shows a loading state and an API error that retries successfully', async ({ page }) => {
    const detailUrl = await pidDetail(page)

    await page.route('**/api/v1/rulebooks/*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350))
      await route.continue()
    })
    await page.goto(detailUrl)
    await expect(page.getByRole('status').first()).toContainText('Loading rulebook…')
    await expect(page.getByRole('heading', { name: 'PID Rulebook', level: 1 })).toBeVisible()
    await page.unroute('**/api/v1/rulebooks/*')

    await page.route('**/api/v1/rulebooks/*', async (route) => {
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
    await page.goto(detailUrl)

    const alert = page.getByRole('alert')
    await expect(alert).toContainText('The rulebook could not be loaded.')
    await expect(alert).toContainText('The rulebook registry is not configured on this server.')

    await page.unroute('**/api/v1/rulebooks/*')
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByRole('heading', { name: 'PID Rulebook', level: 1 })).toBeVisible()
  })

  test('distinguishes hosted and external schema references and fetches hosted bytes anonymously', async ({
    page,
    request,
  }) => {
    await page.goto(await pidDetail(page))

    const references = page.getByRole('region', { name: 'Schema references' })
    await expect(references.getByText('Hosted by AttestBook').first()).toBeVisible()
    await expect(references.getByText('External URL').first()).toBeVisible()
    await expect(references.getByText('application/schema+json').first()).toBeVisible()

    const externalLink = references.getByRole('link', {
      name: /https:\/\/issuer\.example\.org\/schemas\/pid/,
    })
    await expect(externalLink.first()).toHaveAttribute(
      'href',
      'https://issuer.example.org/schemas/pid',
    )

    const download = references
      .getByRole('link', { name: /Download the JSON Schema 2020-12 document for mso_mdoc/ })
      .first()
    const href = await download.getAttribute('href')
    expect(href).not.toBeNull()
    expect(href).toMatch(/\/api\/v1\/schema-documents\/[^/]+\/content$/)
    expect(await download.getAttribute('download')).toMatch(/^attestbook-json-schema-.*\.json$/)

    const response = await request.get(href!)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('application/schema+json')
    expect(response.headers()['content-digest']).toMatch(/^sha-256=:/)
    expect(response.headers()['cache-control']).toContain('immutable')
    expect(await response.json()).toMatchObject({ type: 'object', required: ['family_name'] })
  })

  test('inspects a previously published version with hosted and external references', async ({
    page,
  }) => {
    await page.goto(await pidDetail(page))

    await page.getByRole('button', { name: 'Inspect references for version 1.0' }).click()

    const panel = page.locator('.version-references')
    await expect(
      panel.getByRole('heading', { name: 'Schema references in version 1.0' }),
    ).toBeVisible()
    await expect(panel.getByText(/Exact frozen version/)).toBeVisible()
    await expect(panel.getByText('Hosted by AttestBook').first()).toBeVisible()
    await expect(panel.getByText('External URL').first()).toBeVisible()
    await expect(
      panel
        .getByRole('link', { name: /Download the JSON Schema 2020-12 document for mso_mdoc/ })
        .first(),
    ).toHaveAttribute('href', /\/api\/v1\/schema-documents\/[^/]+\/content$/)
  })

  test('has no detectable accessibility violations', async ({ page }) => {
    await page.goto(await pidDetail(page))
    await expect(page.getByRole('heading', { name: 'PID Rulebook', level: 1 })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Version history' })).toBeVisible()

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

test('keeps every badge label inside its pill', async ({ page }) => {
  await page.goto(await pidDetail(page))
  await expect(page.locator('.badge').first()).toBeVisible()

  const overflowing = await page
    .locator('.badge')
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.scrollHeight > element.clientHeight + 1)
        .map((element) => element.textContent),
    )
  expect(overflowing).toEqual([])
})

test.describe('responsive rulebook detail', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('keeps the detail readable without horizontal scrolling', async ({ page }) => {
    await page.goto(await pidDetail(page))
    await expect(page.getByRole('heading', { name: 'PID Rulebook', level: 1 })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Version history' })).toBeVisible()

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    expect(hasHorizontalOverflow).toBe(false)
  })
})
