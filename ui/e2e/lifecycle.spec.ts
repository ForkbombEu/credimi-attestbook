import { readFileSync } from 'node:fs'

import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { EDITOR_TOKEN_FIXTURE } from './fixtures'

/**
 * Browser tests for the draft lifecycle and version comparison against the real
 * application (issue #41). Each test creates its own rulebook through the API so
 * the seeded catalog counts used by the other specs stay stable.
 */

function providerToken(): string {
  return readFileSync(EDITOR_TOKEN_FIXTURE, 'utf8').trim()
}

interface RulebookBody {
  readonly name: string
  readonly description: string
  readonly applicableSpec: string
  readonly attestations: readonly {
    readonly name: string
    readonly attestationLoS: string
    readonly bindingType: string
    readonly supportedFormats: readonly string[]
    readonly schemaReferences: readonly {
      readonly formatIdentifier: string
      readonly uri: string
    }[]
  }[]
}

function content(name: string, description = 'Lifecycle browser-test rulebook.'): RulebookBody {
  return {
    name,
    description,
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: 'Person Identification Data',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt'],
        schemaReferences: [
          {
            formatIdentifier: 'dc+sd-jwt',
            uri: 'https://issuer.example.org/schemas/pid',
          },
        ],
      },
    ],
  }
}

async function createRulebook(
  request: APIRequestContext,
  token: string,
  body: RulebookBody,
): Promise<string> {
  const response = await request.post('/api/v1/rulebooks', {
    headers: { authorization: `Bearer ${token}` },
    data: body,
  })
  expect(response.status()).toBe(201)
  return ((await response.json()) as { data: { id: string } }).data.id
}

async function createVersion(
  request: APIRequestContext,
  token: string,
  rulebookId: string,
  version: string,
): Promise<void> {
  const response = await request.post(`/api/v1/rulebooks/${rulebookId}/versions`, {
    headers: { authorization: `Bearer ${token}` },
    data: { version },
  })
  expect(response.status()).toBe(201)
}

async function editDraft(
  request: APIRequestContext,
  token: string,
  rulebookId: string,
  body: RulebookBody,
): Promise<void> {
  const response = await request.put(`/api/v1/rulebooks/${rulebookId}/draft`, {
    headers: { authorization: `Bearer ${token}` },
    data: body,
  })
  expect(response.status()).toBe(200)
}

function lifecyclePanel(page: Page) {
  return page.getByRole('region', { name: 'Draft lifecycle and publication' })
}

test.describe('draft lifecycle against the real API', () => {
  test('freezes, checks readiness, publishes and keeps the artifact immutable', async ({
    page,
  }) => {
    const token = providerToken()
    const name = `Lifecycle Rulebook ${Date.now()}`
    const rulebookId = await createRulebook(page.request, token, content(name))

    await page.goto(`/rulebooks/${rulebookId}/edit`)
    await expect(page.getByRole('heading', { name: `Edit ${name} draft`, level: 1 })).toBeVisible()
    await page.getByLabel('Provider bearer token').fill(token)

    const panel = lifecyclePanel(page)
    await expect(
      panel.getByText('No versions have been frozen for this rulebook yet.'),
    ).toBeVisible()

    await panel.getByLabel('New version label').fill('1.0')
    await panel.getByRole('button', { name: 'Freeze as draft version' }).click()
    await expect(panel.getByText(/Draft version 1.0 frozen/)).toBeVisible()

    await panel.getByRole('button', { name: 'Check readiness' }).click()
    await expect(panel.getByText('Ready to publish: every blocking check passed.')).toBeVisible()
    await panel.getByRole('button', { name: 'Publish' }).click()
    await expect(panel.getByText(/is now published and immutable/)).toBeVisible()
    await expect(page.getByText('This rulebook is published.')).toBeVisible()

    // The published artifact keeps its exact bytes and digest, and the API
    // refuses to refresh or edit it.
    const before = await page.request.get(`/api/v1/rulebooks/${rulebookId}/versions/1.0/content`)
    expect(before.ok()).toBe(true)
    const beforeBytes = await before.text()
    const beforeDigest = before.headers()['content-digest']
    expect(beforeDigest).toBeTruthy()

    const refresh = await page.request.post(
      `/api/v1/rulebooks/${rulebookId}/versions/1.0/refresh`,
      { headers: { authorization: `Bearer ${token}` }, data: {} },
    )
    expect(refresh.status()).toBe(409)
    expect(((await refresh.json()) as { error: { code: string } }).error.code).toBe('immutable')

    const edit = await page.request.put(`/api/v1/rulebooks/${rulebookId}/draft`, {
      headers: { authorization: `Bearer ${token}` },
      data: content('Mutated published rulebook'),
    })
    expect(edit.status()).toBe(409)

    const after = await page.request.get(`/api/v1/rulebooks/${rulebookId}/versions/1.0/content`)
    expect(await after.text()).toBe(beforeBytes)
    expect(after.headers()['content-digest']).toBe(beforeDigest)

    // Creating the next version reopens the working copy for editing.
    await panel.getByLabel('New version label').fill('2.0')
    await panel.getByRole('button', { name: 'Freeze as draft version' }).click()
    await expect(panel.getByText(/Draft version 2.0 frozen/)).toBeVisible()
    await expect(page.getByLabel('Name')).toBeEnabled()
    await expect(page.getByText('This rulebook is published.')).toHaveCount(0)

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

test.describe('version comparison against the real API', () => {
  test('shows deterministic changes and identical content across labels', async ({ page }) => {
    const token = providerToken()
    const name = `Comparison Rulebook ${Date.now()}`
    const rulebookId = await createRulebook(page.request, token, content(name))

    await createVersion(page.request, token, rulebookId, '1.0')
    await editDraft(page.request, token, rulebookId, content(`${name} renamed`))
    await createVersion(page.request, token, rulebookId, '1.1')
    // A further label with the same content as 1.1 must compare as identical.
    await createVersion(page.request, token, rulebookId, '1.2')

    await page.goto(`/rulebooks/${rulebookId}`)
    const panel = page.getByRole('region', { name: 'Compare versions' })
    await expect(panel).toBeVisible()
    await expect(panel.getByLabel('Baseline version')).toHaveValue('1.0')

    // The default compared version is the newest label; compare 1.0 with 1.1
    // explicitly so the changed description is visible.
    await panel.getByLabel('Compared version').selectOption('1.1')
    await panel.getByRole('button', { name: 'Compare' }).click()
    await expect(panel.getByText(/1 change between 1.0 and 1.1/)).toBeVisible()
    const row = panel.getByRole('row', { name: /\/name/ })
    await expect(row).toContainText('changed')
    await expect(row).toContainText(name)
    await expect(row).toContainText(`${name} renamed`)

    await panel.getByLabel('Baseline version').selectOption('1.1')
    await panel.getByLabel('Compared version').selectOption('1.2')
    await panel.getByRole('button', { name: 'Compare' }).click()
    await expect(panel.getByText(/have identical authored content/)).toBeVisible()

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
