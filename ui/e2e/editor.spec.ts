import { readFileSync } from 'node:fs'

import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { AUTHORITY_TOKEN_FIXTURE, EDITOR_TOKEN_FIXTURE } from './fixtures'

/**
 * Browser tests for the rulebook draft editor against the real application.
 * They use a seeded draft for writes and a published rulebook for the
 * immutability guard, so the shared catalog data stays stable for the other
 * specs.
 */

function providerToken(): string {
  return readFileSync(EDITOR_TOKEN_FIXTURE, 'utf8').trim()
}

function authorityToken(): string {
  return readFileSync(AUTHORITY_TOKEN_FIXTURE, 'utf8').trim()
}

async function rulebookByName(page: Page, name: string): Promise<{ id: string; status: string }> {
  const response = await page.request.get('/api/v1/rulebooks?limit=100')
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as {
    data: readonly { id: string; name: string; publicationStatus: string }[]
  }
  const rulebook = body.data.find((candidate) => candidate.name === name)
  if (rulebook === undefined) {
    throw new Error(`the e2e fixture must seed "${name}"`)
  }
  return { id: rulebook.id, status: rulebook.publicationStatus }
}

async function openDraftEditor(page: Page, name: string): Promise<string> {
  const rulebook = await rulebookByName(page, name)
  await page.goto(`/rulebooks/${rulebook.id}/edit`)
  await expect(page.getByRole('heading', { name: `Edit ${name} draft`, level: 1 })).toBeVisible()
  return rulebook.id
}

async function fillToken(page: Page): Promise<void> {
  await page.getByLabel('Provider bearer token').fill(providerToken())
}

test.describe('rulebook draft editor against the real API', () => {
  test('shows live validation findings while the draft JSON changes', async ({ page }) => {
    await openDraftEditor(page, 'Payment Account Rulebook')

    // The seeded draft has a format but no schema reference yet: the real
    // server reports it as a save-able warning.
    await expect(page.getByText(/[12] warnings? found\./)).toBeVisible()
    await expect(page.getByText('incomplete_attestation').first()).toBeVisible()

    await page.getByLabel('Draft JSON').fill(
      JSON.stringify({
        attestations: [
          {
            name: 'Payment Account',
            attestationLoS: 'iso_18045_high',
            bindingType: 'key',
            supportedFormats: ['dc+sd-jwt'],
            schemaReferences: [
              {
                formatIdentifier: 'mso_mdoc',
                uri: 'https://issuer.example.org/schemas/payment',
              },
            ],
          },
        ],
        schemaReferences: [],
      }),
    )

    await expect(page.getByText(/[12] errors? found\./)).toBeVisible()
    await expect(page.getByRole('cell', { name: /not listed in supportedFormats/ })).toBeVisible()

    await page.getByLabel('Draft JSON').fill('{not-json')
    await expect(page.getByText('The JSON editor does not contain valid JSON.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled()
  })

  test('persists an authorized draft edit and does not change a published snapshot', async ({
    page,
  }) => {
    const draftId = await openDraftEditor(page, 'Payment Account Rulebook')
    const description = `Edited by the browser suite ${Date.now()}`

    await fillToken(page)
    await page.getByLabel('Description').fill(description)
    await expect(page.getByText(/[12] warnings? found\./)).toBeVisible()
    await page.getByRole('button', { name: 'Save draft' }).click()

    await expect(page.getByText(/Draft saved at/)).toBeVisible()
    await page.reload()
    await expect(page.getByLabel('Description')).toHaveValue(description)

    const persisted = await page.request.get(`/api/v1/rulebooks/${draftId}/draft`)
    expect(persisted.ok()).toBe(true)
    expect(((await persisted.json()) as { data: { description: string } }).data.description).toBe(
      description,
    )

    // Editing a working copy that has a published version must leave the
    // published snapshot bytes and digest exactly as they were.
    const pid = await rulebookByName(page, 'PID Rulebook')
    const before = await page.request.get(`/api/v1/rulebooks/${pid.id}/versions/1.0/content`)
    expect(before.ok()).toBe(true)
    const beforeBytes = await before.text()
    const beforeDigest = before.headers()['content-digest']
    expect(beforeDigest).toBeTruthy()

    const draftResponse = await page.request.get(`/api/v1/rulebooks/${pid.id}/draft`)
    const draft = (await draftResponse.json()) as {
      data: {
        name: string
        description: string
        sourceUrl: string | null
        applicableSpec: string
        attestations: unknown[]
        schemaReferences: unknown[]
      }
    }
    const save = await page.request.put(`/api/v1/rulebooks/${pid.id}/draft`, {
      headers: { authorization: `Bearer ${providerToken()}` },
      data: {
        ...draft.data,
        description: `Working copy changed ${Date.now()}`,
      },
    })
    expect(save.status()).toBe(200)

    const after = await page.request.get(`/api/v1/rulebooks/${pid.id}/versions/1.0/content`)
    expect(after.ok()).toBe(true)
    expect(await after.text()).toBe(beforeBytes)
    expect(after.headers()['content-digest']).toBe(beforeDigest)

    const version = await page.request.get(`/api/v1/rulebooks/${pid.id}/versions/1.0`)
    expect(((await version.json()) as { data: { status: string } }).data.status).toBe('published')
  })

  test('refuses to edit a published rulebook through the API and the UI', async ({ page }) => {
    const published = await rulebookByName(page, 'Mobile Driving Licence Rulebook')
    expect(published.status).toBe('published')

    await page.goto(`/rulebooks/${published.id}/edit`)
    await expect(
      page.getByRole('heading', { name: 'Edit Mobile Driving Licence Rulebook draft', level: 1 }),
    ).toBeVisible()
    await expect(page.getByText('This rulebook is published.')).toBeVisible()
    await expect(page.getByLabel('Name')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled()

    const attempt = await page.request.put(`/api/v1/rulebooks/${published.id}/draft`, {
      headers: { authorization: `Bearer ${authorityToken()}` },
      data: { name: 'Mutated published rulebook', applicableSpec: 'ts11@1.0.1' },
    })
    expect(attempt.status()).toBe(409)
    expect(((await attempt.json()) as { error: { code: string } }).error.code).toBe('immutable')
  })

  test('renders the new-rulebook editor without creating anything', async ({ page }) => {
    const before = await page.request.get('/api/v1/rulebooks?limit=100')
    const beforeTotal = ((await before.json()) as { pagination: { total: number } }).pagination
      .total

    await page.goto('/rulebooks/new')
    await expect(page.getByRole('heading', { name: 'New rulebook draft', level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create draft' })).toBeDisabled()

    const after = await page.request.get('/api/v1/rulebooks?limit=100')
    expect(((await after.json()) as { pagination: { total: number } }).pagination.total).toBe(
      beforeTotal,
    )
  })

  test('has no detectable accessibility violations and fits a narrow viewport', async ({
    page,
  }) => {
    await page.goto('/rulebooks/new')

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
    await page.goto('/rulebooks/new')
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    expect(overflows).toBe(false)
  })
})
