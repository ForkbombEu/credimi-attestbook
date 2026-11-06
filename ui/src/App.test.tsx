import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { App } from './App'
import type { CatalogApi } from './api'
import { CatalogPage } from './CatalogPage'
import { createFakeApi, PROVIDERS, SAMPLE_DATASET } from './test/fixtures'
import { expectNoA11yViolations } from './test/a11y'

function renderCatalog(api: CatalogApi = createFakeApi()) {
  return render(<CatalogPage api={api} onNavigate={() => {}} />)
}

describe('catalog loading, error and empty states', () => {
  test('shows a loading state while the API request is pending', () => {
    const pending: CatalogApi = {
      listProviders: () => new Promise(() => {}),
      listRulebooks: () => new Promise(() => {}),
      getRulebook: () => new Promise(() => {}),
      listAttestations: () => new Promise(() => {}),
      listSchemaReferences: () => new Promise(() => {}),
      listVersions: () => new Promise(() => {}),
      getVersionDiff: () => new Promise(() => {}),
    }

    renderCatalog(pending)

    expect(screen.getByRole('status')).toHaveTextContent('Loading rulebooks…')
    expect(screen.getByText('Reading the public catalogue API.')).toBeInTheDocument()
  })

  test('shows an error state and retries the request', async () => {
    const user = userEvent.setup()
    const api = createFakeApi()
    let attempts = 0
    const flaky: CatalogApi = {
      ...api,
      listRulebooks: async (signal) => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('The rulebook registry is not configured on this server.')
        }
        return api.listRulebooks(signal)
      },
    }

    renderCatalog(flaky)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The rulebook catalog could not be loaded.')
    expect(alert).toHaveTextContent('The rulebook registry is not configured on this server.')

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('PID Rulebook')).toBeInTheDocument()
    expect(attempts).toBe(2)
  })

  test('shows an empty state when the API returns no rulebooks', async () => {
    const empty: CatalogApi = {
      ...createFakeApi(),
      listRulebooks: async () => ({
        data: [],
        pagination: { limit: 100, offset: 0, total: 0 },
      }),
    }

    renderCatalog(empty)

    expect(await screen.findByText('No rulebooks yet')).toBeInTheDocument()
    expect(screen.getByText(/No rulebooks have been registered on this server/)).toBeInTheDocument()
  })

  test('shows the filtered empty state and clears filters', async () => {
    const user = userEvent.setup()
    renderCatalog()

    await screen.findByText('PID Rulebook')
    await user.type(screen.getByLabelText('Search'), 'no-such-rulebook')

    expect(screen.getByText('No rulebooks match your filters')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reset search and filters' }))

    expect(screen.getByText('PID Rulebook')).toBeInTheDocument()
    expect(screen.getByLabelText('Search')).toHaveValue('')
  })
})

describe('catalog content from the public API', () => {
  test('renders provider, version, status, attestation, source and update information', async () => {
    renderCatalog()

    const row = await screen.findByRole('row', { name: /PID Rulebook/ })
    expect(within(row).getByText('Example Issuer')).toBeInTheDocument()
    expect(screen.getByText('Person Identification Data')).toBeInTheDocument()
    expect(screen.getByText('dc+sd-jwt · mso_mdoc')).toBeInTheDocument()
    expect(screen.getByText('1.0')).toBeInTheDocument()
    expect(screen.getByText(/Published · 2 versions/)).toBeInTheDocument()
    expect(screen.getAllByText('Published').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: /issuer\.example\.org/ })).toHaveAttribute(
      'href',
      'https://issuer.example.org/rulebooks/pid',
    )
    expect(screen.getByText('04 Mar 2026')).toBeInTheDocument()
    expect(screen.getByText('Locally authored')).toBeInTheDocument()
  })

  test('reports compatibility as not tested instead of claiming it', async () => {
    renderCatalog()

    await screen.findByText('PID Rulebook')
    expect(screen.getAllByText('Not tested')).toHaveLength(2)
    expect(
      screen.getByText(/AttestBook does not test or claim trust, interoperability/),
    ).toBeInTheDocument()
  })

  test('marks a row whose detail request failed without blanking the catalogue', async () => {
    const api = createFakeApi()
    const failing: CatalogApi = {
      ...api,
      listVersions: async () => Promise.reject(new Error('versions unavailable')),
    }

    renderCatalog(failing)

    expect(await screen.findByText('PID Rulebook')).toBeInTheDocument()
    expect(screen.getAllByText('Details unavailable')).toHaveLength(2)
  })
})

describe('catalog search and filters', () => {
  test('filters by search text and updates the result count', async () => {
    const user = userEvent.setup()
    renderCatalog()

    await screen.findByText('PID Rulebook')
    expect(screen.getByRole('status')).toHaveTextContent('Showing 2 of 2 rulebooks')

    await user.type(screen.getByLabelText('Search'), 'age')

    expect(screen.queryByText('PID Rulebook')).not.toBeInTheDocument()
    expect(screen.getByText('Age Verification Rulebook')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Showing 1 of 2 rulebooks')
  })

  test('filters by provider', async () => {
    const user = userEvent.setup()
    renderCatalog()

    await screen.findByText('PID Rulebook')
    await user.selectOptions(screen.getByLabelText('Provider'), 'provider-lab')

    expect(screen.queryByText('PID Rulebook')).not.toBeInTheDocument()
    expect(screen.getByText('Age Verification Rulebook')).toBeInTheDocument()
  })

  test('filters by publication status', async () => {
    const user = userEvent.setup()
    renderCatalog()

    await screen.findByText('PID Rulebook')
    await user.selectOptions(screen.getByLabelText('Status'), 'draft')

    expect(screen.queryByText('PID Rulebook')).not.toBeInTheDocument()
    expect(screen.getByText('Age Verification Rulebook')).toBeInTheDocument()
  })

  test('keeps the truncation notice visible when a search matches nothing', async () => {
    const user = userEvent.setup()
    const api = createFakeApi()
    const truncated: CatalogApi = {
      ...api,
      listRulebooks: () =>
        Promise.resolve({
          data: SAMPLE_DATASET.rulebooks,
          pagination: { limit: 100, offset: 0, total: 52 },
        }),
    }

    renderCatalog(truncated)

    await screen.findByText('PID Rulebook')
    expect(screen.getByText(/Showing the first 2 of 52 rulebooks/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing 2 of 2 loaded rulebooks (52 in the catalog)',
    )

    await user.type(screen.getByLabelText('Search'), 'no-such-rulebook')

    expect(screen.getByText('No rulebooks match your filters')).toBeInTheDocument()
    expect(screen.getByText(/Showing the first 2 of 52 rulebooks/)).toBeInTheDocument()
    expect(screen.getByText(/Only the loaded page was searched/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing 0 of 2 loaded rulebooks (52 in the catalog)',
    )
  })

  test('lists API providers that own no loaded rulebook', async () => {
    renderCatalog(
      createFakeApi({
        ...SAMPLE_DATASET,
        providers: [
          ...SAMPLE_DATASET.providers,
          { id: 'provider-extra', name: 'Zeta Provider', createdAt: '2026-01-04T10:00:00.000Z' },
        ],
      }),
    )

    await screen.findByText('PID Rulebook')
    expect(screen.getByRole('option', { name: 'Zeta Provider' })).toBeInTheDocument()
  })
})

describe('catalog accessibility', () => {
  test('has no detectable accessibility violations with results', async () => {
    renderCatalog()

    await screen.findByText('PID Rulebook')
    await expectNoA11yViolations(document.body)
  })

  test('has no detectable accessibility violations in the error state', async () => {
    const failing: CatalogApi = {
      ...createFakeApi(),
      listRulebooks: async () => Promise.reject(new Error('registry unavailable')),
    }

    renderCatalog(failing)

    await screen.findByRole('alert')
    await expectNoA11yViolations(document.body)
  })
})

describe('catalog rendering details', () => {
  test('shows the empty-detail fallback as a visible table label', async () => {
    renderCatalog()

    const row = await screen.findByRole('row', { name: /Age Verification Rulebook/ })
    expect(within(row).getByText('Draft')).toBeInTheDocument()
    expect(within(row).getByText('No versions yet')).toBeInTheDocument()
  })

  test('passes the abort signal to per-rulebook detail requests', async () => {
    const listAttestations = vi.fn(async () => SAMPLE_DATASET.attestations['rulebook-pid'] ?? [])
    const api: CatalogApi = {
      ...createFakeApi(),
      listAttestations,
    }

    renderCatalog(api)

    await screen.findByText('PID Rulebook')
    await waitFor(() => expect(listAttestations).toHaveBeenCalledTimes(2))
    expect(listAttestations).toHaveBeenCalledWith('rulebook-pid', expect.anything())
  })
})

const DRAFT_RULEBOOK = {
  id: 'rulebook-pid',
  providerId: 'provider-example',
  name: 'PID Rulebook',
  description: 'Person identification data.',
  sourceUrl: null,
  applicableSpec: 'ts11@1.0.1',
  publicationStatus: 'draft',
  attestations: [],
  schemaReferences: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('app catalog and detail navigation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    window.history.replaceState({}, '', '/')
  })

  function installFetch() {
    const fetchMock = vi.fn(async (input: string) => {
      const json = (body: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )

      if (input === '/api/v1/providers') {
        return json({ data: PROVIDERS })
      }
      if (input.startsWith('/api/v1/rulebooks?')) {
        return json({
          data: SAMPLE_DATASET.rulebooks,
          pagination: { limit: 100, offset: 0, total: SAMPLE_DATASET.rulebooks.length },
        })
      }
      if (input === '/api/v1/rulebooks/rulebook-pid') {
        return json({ data: SAMPLE_DATASET.rulebooks[0] })
      }
      if (input === '/api/v1/rulebooks/rulebook-pid/attestations') {
        return json({ data: SAMPLE_DATASET.attestations['rulebook-pid'] })
      }
      if (input === '/api/v1/rulebooks/rulebook-pid/schema-references') {
        return json({ data: SAMPLE_DATASET.schemaReferences['rulebook-pid'] })
      }
      if (input === '/api/v1/rulebooks/rulebook-pid/versions') {
        return json({ data: SAMPLE_DATASET.versions['rulebook-pid'] })
      }
      if (input === '/api/v1/rulebooks/rulebook-pid/draft') {
        return json({ data: DRAFT_RULEBOOK })
      }
      if (input === '/api/v1/rulebooks/validate-draft') {
        return json({
          data: {
            valid: true,
            saveable: true,
            profile: 'ts11@1.0.1',
            diagnostics: [],
            limitations: [],
          },
        })
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'not_found', message: 'No route matches.' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  test('opens a rulebook detail from the catalog and returns to the catalog', async () => {
    const user = userEvent.setup()
    installFetch()

    render(<App />)

    await user.click(await screen.findByRole('link', { name: 'PID Rulebook' }))

    expect(window.location.pathname).toBe('/rulebooks/rulebook-pid')
    expect(await screen.findByRole('heading', { name: 'PID Rulebook' })).toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Rulebook catalog' }))

    expect(window.location.pathname).toBe('/')
    expect(await screen.findByRole('heading', { name: 'Rulebook catalog' })).toBeInTheDocument()
  })

  test('opens the credential playground from the shared header', async () => {
    const user = userEvent.setup()
    installFetch()

    render(<App />)

    await user.click(await screen.findByRole('link', { name: 'Validation playground' }))

    expect(window.location.pathname).toBe('/playground')
    expect(
      await screen.findByRole('heading', { name: 'Credential playground' }),
    ).toBeInTheDocument()
    expect(await screen.findByLabelText('Rulebook')).toBeInTheDocument()
  })

  test('opens the new-rulebook editor from the catalog', async () => {
    const user = userEvent.setup()
    installFetch()

    render(<App />)

    await user.click(await screen.findByRole('link', { name: 'New rulebook' }))
    expect(window.location.pathname).toBe('/rulebooks/new')
    expect(await screen.findByRole('heading', { name: 'New rulebook draft' })).toBeInTheDocument()
  })

  test('renders a deep-linked draft editor path directly', async () => {
    installFetch()
    window.history.replaceState({}, '', '/rulebooks/rulebook-pid/edit')

    render(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Edit PID Rulebook draft' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('PID Rulebook')
  })

  test('renders a deep-linked detail path directly', async () => {
    installFetch()
    window.history.replaceState({}, '', '/rulebooks/rulebook-pid')

    render(<App />)

    expect(await screen.findByRole('heading', { name: 'PID Rulebook' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Version history' })).toBeInTheDocument()
  })
})
