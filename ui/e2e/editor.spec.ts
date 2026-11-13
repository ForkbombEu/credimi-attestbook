import { readFileSync } from 'node:fs'

import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { AUTHORITY_TOKEN_FIXTURE, EDITOR_TOKEN_FIXTURE } from './fixtures'
import { signInAsAdmin } from './session'

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

/** Creates an editable draft through the provider API, for tests that need a fresh document. */
async function createDraftViaApi(
  page: Page,
  name: string,
  attestations: readonly {
    readonly name: string
    readonly attestationLoS: string
    readonly bindingType: string
    readonly supportedFormats: readonly string[]
    readonly schemaReferences?: readonly {
      readonly formatIdentifier: string
      readonly uri: string
      readonly integrity?: string
    }[]
  }[],
): Promise<string> {
  const response = await page.request.post('/api/v1/rulebooks', {
    headers: { authorization: `Bearer ${providerToken()}` },
    data: { name, applicableSpec: 'ts11@1.0.1', attestations },
  })
  expect(response.status()).toBe(201)
  return ((await response.json()) as { data: { id: string } }).data.id
}

const HOSTED_SCHEMA_PASTE = JSON.stringify(
  {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Payment account schema',
    type: 'object',
    required: ['iban'],
    properties: { iban: { type: 'string' } },
    additionalProperties: false,
  },
  null,
  2,
)

const HOSTED_SCHEMA_FILE = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Age verification schema',
  type: 'object',
  required: ['age_over_18'],
  properties: { age_over_18: { type: 'boolean' } },
})

type DraftReference = {
  readonly formatIdentifier: string
  readonly uri: string
  readonly integrity?: string
}

function schemaReferencesOf(jsonText: string, attestationIndex: number): readonly DraftReference[] {
  const document = JSON.parse(jsonText) as {
    attestations: readonly { schemaReferences?: readonly DraftReference[] }[]
  }
  return document.attestations[attestationIndex]?.schemaReferences ?? []
}

async function addHostedSchema(
  page: Page,
  attestationName: string,
  formatIdentifier: string,
  schemaText: string,
): Promise<void> {
  await page
    .getByRole('button', {
      name: `Add schema for ${attestationName} (${formatIdentifier})`,
    })
    .click()
  await page.getByRole('radio', { name: /Upload\/paste schema to AttestBook/ }).check()
  await page.getByLabel('JSON Schema document').fill(schemaText)
  await expect(page.getByText(/Valid JSON Schema/)).toBeVisible()
  await page
    .getByRole('button', {
      name: `Register and insert schema for ${attestationName} (${formatIdentifier})`,
    })
    .click()
  await expect(page.getByText('Hosted schema registered and added to the draft.')).toBeVisible({
    timeout: 30_000,
  })
}

test.describe('rulebook draft editor against the real API', () => {
  test('shows live validation findings while the draft JSON changes', async ({ page }) => {
    await signInAsAdmin(page)
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

  test('persists an authorized session draft edit and does not change a published snapshot', async ({
    page,
  }) => {
    await signInAsAdmin(page)
    const draftId = await openDraftEditor(page, 'Payment Account Rulebook')
    const description = `Edited by the browser suite ${Date.now()}`

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
    await signInAsAdmin(page)
    const published = await rulebookByName(page, 'Mobile Driving Licence Rulebook')
    expect(published.status).toBe('published')

    await page.goto(`/rulebooks/${published.id}/edit`)
    await expect(
      page.getByRole('heading', { name: 'Edit Mobile Driving Licence Rulebook draft', level: 1 }),
    ).toBeVisible()
    await expect(page.getByText('This rulebook is published.')).toBeVisible()
    await expect(page.getByLabel('Name')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled()
    await expect(
      page.getByRole('button', { name: 'Add schema for Mobile Driving Licence (mso_mdoc)' }),
    ).toBeDisabled()

    const attempt = await page.request.put(`/api/v1/rulebooks/${published.id}/draft`, {
      headers: { authorization: `Bearer ${authorityToken()}` },
      data: { name: 'Mutated published rulebook', applicableSpec: 'ts11@1.0.1' },
    })
    expect(attempt.status()).toBe(409)
    expect(((await attempt.json()) as { error: { code: string } }).error.code).toBe('immutable')
  })

  test('creates a new rulebook with an empty source URL and opens its editor', async ({ page }) => {
    await signInAsAdmin(page)
    const name = `Created by the browser suite ${Date.now()}`

    await page.goto('/rulebooks/new')
    await page.getByLabel('Name').fill(name)
    await page.getByRole('button', { name: 'Create draft' }).click()

    await expect(page).toHaveURL(/\/rulebooks\/[0-9a-f-]+\/edit$/)
    await expect(page.getByRole('heading', { name: `Edit ${name} draft`, level: 1 })).toBeVisible()
    await expect(page.getByLabel('Name')).toHaveValue(name)
    await expect(page.getByLabel('Source URL (optional)')).toHaveValue('')

    const id = new URL(page.url()).pathname.split('/')[2]
    const draft = await page.request.get(`/api/v1/rulebooks/${id}/draft`)
    expect(draft.ok()).toBe(true)
    expect(
      ((await draft.json()) as { data: { sourceUrl: string | null } }).data.sourceUrl,
    ).toBeNull()
  })

  test('renders the new-rulebook editor without creating anything', async ({ page }) => {
    await signInAsAdmin(page)
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
    await signInAsAdmin(page)
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

    // The schema form is part of the editor surface too, so scan it open.
    const payment = await rulebookByName(page, 'Payment Account Rulebook')
    await page.goto(`/rulebooks/${payment.id}/edit`)
    await page.getByRole('button', { name: 'Add schema for Payment Account (dc+sd-jwt)' }).click()
    await page.getByRole('radio', { name: /Use existing external URL/ }).check()
    const formResults = await new AxeBuilder({ page }).analyze()
    expect(
      formResults.violations.map(
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

  test('sends an anonymous author to sign in and keeps the public catalogue readable', async ({
    page,
  }) => {
    await page.goto('/rulebooks/new')
    await expect(page.getByRole('heading', { name: 'Sign in to author rulebooks' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?next=%2Frulebooks%2Fnew',
    )
    await expect(page.getByLabel('Name')).toHaveCount(0)

    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Rulebook catalog' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'New rulebook' })).toHaveCount(0)
    await expect(page.locator('tbody tr').first()).toBeVisible()
  })

  test('preserves unsaved editor text when the session expires on save', async ({
    page,
    context,
  }) => {
    await signInAsAdmin(page)
    await openDraftEditor(page, 'Payment Account Rulebook')

    const description = `Expiry keeps these edits ${Date.now()}`
    await page.getByLabel('Description').fill(description)
    await context.clearCookies()
    await page.getByRole('button', { name: 'Save draft' }).click()

    await expect(page.getByRole('heading', { name: 'Sign in again' })).toBeVisible()
    await expect(page.getByLabel('Description')).toHaveValue(description)
  })

  test('registers a pasted hosted schema and keeps its URI and SRI pin across a save and reload', async ({
    page,
  }) => {
    await signInAsAdmin(page)
    await openDraftEditor(page, 'Payment Account Rulebook')

    await addHostedSchema(page, 'Payment Account', 'dc+sd-jwt', HOSTED_SCHEMA_PASTE)

    const jsonText = await page.getByLabel('Draft JSON').inputValue()
    const [reference] = schemaReferencesOf(jsonText, 0)
    expect(reference?.formatIdentifier).toBe('dc+sd-jwt')
    expect(reference?.uri).toContain('/api/v1/schema-documents/')
    expect(reference?.uri).toMatch(/\/content$/)
    expect(reference?.integrity).toMatch(/^sha256-/)
    expect(reference?.uri.startsWith('http://127.0.0.1:4173/')).toBe(true)

    // The returned URL is a real public endpoint serving the exact bytes.
    const content = await page.request.get(reference!.uri)
    expect(content.ok()).toBe(true)
    expect(content.headers()['content-type']).toBe('application/schema+json')
    expect(await content.text()).toBe(HOSTED_SCHEMA_PASTE)

    await page.getByRole('button', { name: 'Save draft' }).click()
    await expect(page.getByText(/Draft saved at/)).toBeVisible()
    await page.reload()
    await expect(page.locator('.schema-row__source').first()).toHaveText('AttestBook-hosted')
    const reloaded = await page.getByLabel('Draft JSON').inputValue()
    expect(schemaReferencesOf(reloaded, 0)).toEqual([reference])
    expect((await page.request.get(reference!.uri)).ok()).toBe(true)
  })

  test('adds a hosted schema from an uploaded .json file', async ({ page }) => {
    await signInAsAdmin(page)
    await openDraftEditor(page, 'Age Verification Rulebook')

    await page.getByRole('button', { name: 'Add schema for Proof of Age (dc+sd-jwt)' }).click()
    await page.getByRole('radio', { name: /Upload\/paste schema to AttestBook/ }).check()
    await page.getByLabel('Or choose a .json file').setInputFiles({
      name: 'proof-of-age.schema.json',
      mimeType: 'application/json',
      buffer: Buffer.from(HOSTED_SCHEMA_FILE),
    })
    await expect(page.getByText('Loaded proof-of-age.schema.json.')).toBeVisible()
    await expect(page.getByText(/Valid JSON Schema/)).toBeVisible()
    await page
      .getByRole('button', {
        name: 'Register and insert schema for Proof of Age (dc+sd-jwt)',
      })
      .click()
    await expect(page.getByText('Hosted schema registered and added to the draft.')).toBeVisible({
      timeout: 30_000,
    })

    const jsonText = await page.getByLabel('Draft JSON').inputValue()
    const [reference] = schemaReferencesOf(jsonText, 0)
    expect(reference?.uri).toContain('/api/v1/schema-documents/')
    expect(reference?.integrity).toMatch(/^sha256-/)
    const content = await page.request.get(reference!.uri)
    expect(await content.text()).toBe(HOSTED_SCHEMA_FILE)
  })

  test('inserts an external schema URL with an optional SRI pin and uploads nothing', async ({
    page,
  }) => {
    const schemaRequests: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/v1/schema-documents')) {
        schemaRequests.push(request.url())
      }
    })
    await signInAsAdmin(page)
    // The administrator session is bound to the issuer provider, so create a
    // draft it owns instead of editing another provider's read-only catalogue.
    const rulebookId = await createDraftViaApi(page, `External schema rulebook ${Date.now()}`, [
      {
        name: 'Loyalty Card',
        attestationLoS: 'iso_18045_high',
        bindingType: 'cryptographic',
        supportedFormats: ['dc+sd-jwt'],
      },
    ])
    await page.goto(`/rulebooks/${rulebookId}/edit`)

    await page.getByRole('button', { name: 'Add schema for Loyalty Card (dc+sd-jwt)' }).click()
    await page.getByRole('radio', { name: /Use existing external URL/ }).check()
    await page.getByLabel('Schema URL').fill('https://loyalty.example.org/schemas/card')
    await page
      .getByLabel('SRI integrity (optional)')
      .fill('sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=')
    await page
      .getByRole('button', {
        name: 'Insert external reference for Loyalty Card (dc+sd-jwt)',
      })
      .click()

    await expect(page.getByText('External schema reference added to the draft.')).toBeVisible()
    expect(schemaRequests).toEqual([])
    expect(schemaReferencesOf(await page.getByLabel('Draft JSON').inputValue(), 0)).toEqual([
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: 'https://loyalty.example.org/schemas/card',
        integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
      },
    ])

    await page.getByRole('button', { name: 'Save draft' }).click()
    await expect(page.getByText(/Draft saved at/)).toBeVisible()
    await page.reload()
    await expect(page.locator('.schema-row__source').first()).toHaveText('External')
    expect(schemaReferencesOf(await page.getByLabel('Draft JSON').inputValue(), 0)[0]?.uri).toBe(
      'https://loyalty.example.org/schemas/card',
    )
  })

  test('mixes hosted and external references across attestations and formats', async ({ page }) => {
    await signInAsAdmin(page)
    const rulebookId = await createDraftViaApi(page, `Mixed schema rulebook ${Date.now()}`, [
      {
        name: 'Payment Account',
        attestationLoS: 'iso_18045_high',
        bindingType: 'cryptographic',
        supportedFormats: ['dc+sd-jwt'],
      },
      {
        name: 'Account Details',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['mso_mdoc'],
      },
    ])
    await page.goto(`/rulebooks/${rulebookId}/edit`)
    await expect(page.getByRole('heading', { name: /^Edit .* draft$/ })).toBeVisible()

    await addHostedSchema(page, 'Payment Account', 'dc+sd-jwt', HOSTED_SCHEMA_PASTE)
    await page.getByRole('button', { name: 'Add schema for Account Details (mso_mdoc)' }).click()
    await page.getByRole('radio', { name: /Use existing external URL/ }).check()
    await page.getByLabel('Schema URL').fill('https://issuer.example.org/schemas/account-details')
    await page
      .getByRole('button', {
        name: 'Insert external reference for Account Details (mso_mdoc)',
      })
      .click()
    await expect(page.getByText('External schema reference added to the draft.')).toBeVisible()

    const jsonText = await page.getByLabel('Draft JSON').inputValue()
    const hosted = schemaReferencesOf(jsonText, 0)
    const external = schemaReferencesOf(jsonText, 1)
    expect(hosted[0]?.uri).toContain('/api/v1/schema-documents/')
    expect(external).toEqual([
      {
        formatIdentifier: 'mso_mdoc',
        uri: 'https://issuer.example.org/schemas/account-details',
      },
    ])

    await page.getByRole('button', { name: 'Save draft' }).click()
    await expect(page.getByText(/Draft saved at/)).toBeVisible()
    await page.reload()
    const reloaded = await page.getByLabel('Draft JSON').inputValue()
    expect(schemaReferencesOf(reloaded, 0)).toEqual(hosted)
    expect(schemaReferencesOf(reloaded, 1)).toEqual(external)
  })

  test('reports invalid schema JSON and disables registration before any request', async ({
    page,
  }) => {
    await signInAsAdmin(page)
    const rulebookId = await createDraftViaApi(page, `Invalid schema rulebook ${Date.now()}`, [
      {
        name: 'Payment Account',
        attestationLoS: 'iso_18045_high',
        bindingType: 'cryptographic',
        supportedFormats: ['dc+sd-jwt'],
      },
    ])
    await page.goto(`/rulebooks/${rulebookId}/edit`)

    await page.getByRole('button', { name: 'Add schema for Payment Account (dc+sd-jwt)' }).click()
    await page.getByRole('radio', { name: /Upload\/paste schema to AttestBook/ }).check()
    await page.getByLabel('JSON Schema document').fill('{not-json')
    await expect(page.getByText('This is not valid JSON.')).toBeVisible()
    await expect(
      page.getByRole('button', {
        name: 'Register and insert schema for Payment Account (dc+sd-jwt)',
      }),
    ).toBeDisabled()
    expect(schemaReferencesOf(await page.getByLabel('Draft JSON').inputValue(), 0)).toEqual([])
  })

  test('keeps the pasted schema when the session expires during registration', async ({ page }) => {
    await signInAsAdmin(page)
    const rulebookId = await createDraftViaApi(page, `Expiring schema rulebook ${Date.now()}`, [
      {
        name: 'Payment Account',
        attestationLoS: 'iso_18045_high',
        bindingType: 'cryptographic',
        supportedFormats: ['dc+sd-jwt'],
      },
    ])
    await page.route(/\/api\/v1\/schema-documents\?kind=/, (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'unauthorized', message: 'Authentication is required.' },
        }),
      }),
    )
    await page.goto(`/rulebooks/${rulebookId}/edit`)

    await page.getByRole('button', { name: 'Add schema for Payment Account (dc+sd-jwt)' }).click()
    await page.getByRole('radio', { name: /Upload\/paste schema to AttestBook/ }).check()
    await page.getByLabel('JSON Schema document').fill(HOSTED_SCHEMA_PASTE)
    await page
      .getByRole('button', {
        name: 'Register and insert schema for Payment Account (dc+sd-jwt)',
      })
      .click()

    await expect(page.getByRole('heading', { name: 'Sign in again' })).toBeVisible()
    await expect(page.getByLabel('JSON Schema document')).toHaveValue(HOSTED_SCHEMA_PASTE)
    expect(schemaReferencesOf(await page.getByLabel('Draft JSON').inputValue(), 0)).toEqual([])

    // Re-authenticating keeps the pasted document, so the registration can be retried.
    await page.getByLabel('Username').fill('e2e-admin')
    await page.getByLabel('Password').fill('e2e-admin-password')
    await page.getByRole('button', { name: 'Sign in again' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in again' })).toBeHidden()
    await expect(page.getByLabel('JSON Schema document')).toHaveValue(HOSTED_SCHEMA_PASTE)
  })
})
