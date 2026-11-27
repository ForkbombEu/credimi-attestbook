import { readFileSync } from 'node:fs'

import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { EDITOR_TOKEN_FIXTURE, AUTHORITY_TOKEN_FIXTURE } from './fixtures'
import { signInAsAdmin } from './session'

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

async function publishVersion(
  request: APIRequestContext,
  token: string,
  rulebookId: string,
  version: string,
): Promise<void> {
  const response = await request.post(
    `/api/v1/rulebooks/${rulebookId}/versions/${version}/publish`,
    { headers: { authorization: `Bearer ${token}` }, data: {} },
  )
  expect(response.status()).toBe(200)
}

/** Creates a rulebook and publishes its first version, leaving it immutable. */
async function createPublishedRulebook(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<string> {
  const rulebookId = await createRulebook(request, token, content(name))
  await createVersion(request, token, rulebookId, '1.0')
  await publishVersion(request, token, rulebookId, '1.0')
  return rulebookId
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

    await signInAsAdmin(page)
    await page.goto(`/rulebooks/${rulebookId}/edit`)
    await expect(page.getByRole('heading', { name: `Edit ${name} draft`, level: 1 })).toBeVisible()

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
    await expect(page.getByText('This rulebook is published.', { exact: true })).toBeVisible()

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
    const nextVersion = page.getByRole('region', { name: 'Create a new version', exact: true })
    await expect(nextVersion).toBeVisible()
    await nextVersion.getByLabel('New version label').fill('2.0')
    await nextVersion.getByRole('button', { name: 'Create new version' }).click()
    await expect(page.getByText(/Draft version 2\.0 created/)).toBeVisible()
    await expect(page.getByLabel('Name')).toBeEnabled()
    await expect(page.getByText('This rulebook is published.', { exact: true })).toHaveCount(0)

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

test.describe('next version from a published rulebook', () => {
  test('offers Create new version only to the owning administrator and protects the write', async ({
    page,
  }) => {
    const token = providerToken()
    const rulebookId = await createPublishedRulebook(
      page.request,
      token,
      `Published Rulebook ${Date.now()}`,
    )

    // Anonymous visitors see no authoring action on the detail page.
    await page.goto(`/rulebooks/${rulebookId}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Create new version' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Edit draft' })).toHaveCount(0)

    // The version-create write itself stays session- and provider-authorized.
    const anonymous = await page.request.post(`/api/v1/rulebooks/${rulebookId}/versions`, {
      data: { version: '2.0' },
    })
    expect(anonymous.status()).toBe(401)
    const otherProvider = await page.request.post(`/api/v1/rulebooks/${rulebookId}/versions`, {
      headers: {
        authorization: `Bearer ${readFileSync(AUTHORITY_TOKEN_FIXTURE, 'utf8').trim()}`,
      },
      data: { version: '2.0' },
    })
    expect(otherProvider.status()).toBe(403)

    // The owning administrator gets the action, and it opens the next-version flow.
    await signInAsAdmin(page)
    await page.goto(`/rulebooks/${rulebookId}`)
    const action = page.getByRole('link', { name: 'Create new version' })
    await expect(action).toBeVisible()
    await expect(action).toHaveAttribute('href', new RegExp(`/rulebooks/${rulebookId}/edit$`))
    await action.click()

    await expect(
      page.getByRole('heading', { name: /^Create a new version of /, level: 1 }),
    ).toBeVisible()
    await expect(
      page.getByRole('region', { name: 'Create a new version', exact: true }),
    ).toBeVisible()
    await expect(page.getByText('This rulebook is published.', { exact: true })).toBeVisible()
  })

  test('reopens a published rulebook, updates a schema reference and publishes a new version', async ({
    page,
  }) => {
    const token = providerToken()
    const name = `New version Rulebook ${Date.now()}`
    const rulebookId = await createPublishedRulebook(page.request, token, name)

    const original = await page.request.get(`/api/v1/rulebooks/${rulebookId}/versions/1.0/content`)
    expect(original.ok()).toBe(true)
    const originalBytes = await original.text()
    const originalDigest = original.headers()['content-digest']
    expect(originalDigest).toBeTruthy()

    await signInAsAdmin(page)
    await page.goto(`/rulebooks/${rulebookId}`)
    await page.getByRole('link', { name: 'Create new version' }).click()

    const createPanel = page.getByRole('region', { name: 'Create a new version', exact: true })
    await expect(createPanel).toBeVisible()
    await createPanel.getByLabel('New version label').fill('1.1.0')
    await createPanel.getByRole('button', { name: 'Create new version' }).click()

    await expect(page.getByRole('heading', { name: `Edit ${name} draft`, level: 1 })).toBeVisible()
    await expect(page.getByLabel('Name')).toBeEnabled()
    await expect(page.getByText(/Draft version 1\.1\.0 created/)).toBeVisible()

    // Replace the attestation's schema reference through the existing controls.
    await page
      .getByRole('button', {
        name: 'Edit schema for Person Identification Data (dc+sd-jwt)',
      })
      .click()
    await page.getByRole('radio', { name: /Use existing external URL/ }).check()
    await page.getByLabel('Schema URL').fill('https://issuer.example.org/schemas/pid-1.1')
    await page
      .getByRole('button', {
        name: 'Insert external reference for Person Identification Data (dc+sd-jwt)',
      })
      .click()
    await expect(page.getByText('External schema reference added to the draft.')).toBeVisible()
    await page.getByRole('button', { name: 'Save draft' }).click()
    await expect(page.getByText(/Draft saved at/)).toBeVisible()

    const lifecycle = page.getByRole('region', { name: 'Draft lifecycle and publication' })
    await lifecycle.getByRole('button', { name: 'Refresh' }).click()
    await expect(lifecycle.getByText(/Draft version 1\.1\.0 refreshed/)).toBeVisible()
    await lifecycle.getByRole('button', { name: 'Check readiness' }).click()
    await expect(
      lifecycle.getByText('Ready to publish: every blocking check passed.'),
    ).toBeVisible()
    await lifecycle.getByRole('button', { name: 'Publish' }).click()
    await expect(lifecycle.getByText(/is now published and immutable/)).toBeVisible()

    // Publishing closes the editable copy and offers the next version again.
    await expect(
      page.getByRole('region', { name: 'Create a new version', exact: true }),
    ).toBeVisible()

    await page.goto(`/rulebooks/${rulebookId}`)
    const history = page.getByRole('region', { name: 'Version history' })
    const historicalRow = history.locator('tbody tr').filter({ hasText: 'Historical' })
    await expect(historicalRow).toContainText('1.0')
    await expect(
      historicalRow.getByRole('link', { name: 'Export version 1.0 snapshot' }),
    ).toBeVisible()
    const publishedRow = history.locator('tbody tr').filter({ hasText: 'Published' })
    await expect(publishedRow).toContainText('1.1.0')
    await expect(publishedRow).toContainText('Latest')

    // The previously published artifact keeps its exact bytes and digest.
    const exported = await page.request.get(`/api/v1/rulebooks/${rulebookId}/versions/1.0/content`)
    expect(await exported.text()).toBe(originalBytes)
    expect(exported.headers()['content-digest']).toBe(originalDigest)
  })

  test('rejects a duplicate version label without changing the published artifact', async ({
    page,
  }) => {
    const token = providerToken()
    const rulebookId = await createPublishedRulebook(
      page.request,
      token,
      `Conflict Rulebook ${Date.now()}`,
    )
    const original = await page.request.get(`/api/v1/rulebooks/${rulebookId}/versions/1.0/content`)
    const originalBytes = await original.text()
    const originalDigest = original.headers()['content-digest']

    await signInAsAdmin(page)
    await page.goto(`/rulebooks/${rulebookId}/edit`)
    const panel = page.getByRole('region', { name: 'Create a new version', exact: true })
    await panel.getByLabel('New version label').fill('1.0')
    await panel.getByRole('button', { name: 'Create new version' }).click()

    const alert = panel.getByRole('alert')
    await expect(alert).toContainText('The new version was not created')
    await expect(alert).toContainText('already exists')
    await expect(
      page.getByRole('heading', { name: /^Create a new version of /, level: 1 }),
    ).toBeVisible()
    await expect(page.getByLabel('Name')).toBeDisabled()

    const exported = await page.request.get(`/api/v1/rulebooks/${rulebookId}/versions/1.0/content`)
    expect(await exported.text()).toBe(originalBytes)
    expect(exported.headers()['content-digest']).toBe(originalDigest)
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
