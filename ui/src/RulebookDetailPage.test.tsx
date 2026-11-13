import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { type CatalogApi } from './api'
import { RulebookDetailPage } from './RulebookDetailPage'
import {
  createFakeApi,
  HOSTED_SCHEMA,
  makeAttestation,
  makeRulebook,
  makeSchemaReference,
  makeVersion,
  SAMPLE_DATASET,
} from './test/fixtures'
import { expectNoA11yViolations } from './test/a11y'

function renderDetail(api: CatalogApi = createFakeApi(), rulebookId = 'rulebook-pid') {
  const onNavigate = vi.fn()
  const view = render(
    <RulebookDetailPage api={api} rulebookId={rulebookId} onNavigate={onNavigate} />,
  )
  return { ...view, onNavigate }
}

describe('rulebook detail states', () => {
  test('shows a loading state while the rulebook request is pending', () => {
    const pending: CatalogApi = {
      listProviders: () => new Promise(() => {}),
      listRulebooks: () => new Promise(() => {}),
      getRulebook: () => new Promise(() => {}),
      listAttestations: () => new Promise(() => {}),
      listSchemaReferences: () => new Promise(() => {}),
      listVersions: () => new Promise(() => {}),
      getVersionSchemaReferences: () => new Promise(() => {}),
      getVersionDiff: () => new Promise(() => {}),
    }

    renderDetail(pending)

    expect(screen.getByRole('status')).toHaveTextContent('Loading rulebook…')
    expect(screen.getByText('Reading the public rulebook API.')).toBeInTheDocument()
  })

  test('shows a not-found state and navigates back to the catalog', async () => {
    const user = userEvent.setup()
    const { onNavigate } = renderDetail(createFakeApi(), 'rulebook-missing')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Rulebook not found')
    expect(screen.getByRole('link', { name: 'Rulebook catalog' })).toHaveAttribute('href', '/')
    await waitFor(() => expect(document.title).toBe('Rulebook not found · AttestBook'))

    await user.click(screen.getByRole('button', { name: 'Back to the catalog' }))
    expect(onNavigate).toHaveBeenCalledWith('/')
  })

  test('shows an error state and retries the rulebook request', async () => {
    const user = userEvent.setup()
    const api = createFakeApi()
    let attempts = 0
    const flaky: CatalogApi = {
      ...api,
      getRulebook: async (rulebookId, signal) => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('The rulebook registry is not configured on this server.')
        }
        return api.getRulebook(rulebookId, signal)
      },
    }

    renderDetail(flaky)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The rulebook could not be loaded.')
    expect(alert).toHaveTextContent('The rulebook registry is not configured on this server.')

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('heading', { name: 'PID Rulebook' })).toBeInTheDocument()
    expect(attempts).toBe(2)
  })
})

describe('rulebook detail content', () => {
  test('renders metadata, attestation types, schema references and provenance', async () => {
    renderDetail()

    expect(await screen.findByRole('heading', { name: 'PID Rulebook' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Rulebook metadata' })).toBeInTheDocument()
    expect(screen.getByText('Example Issuer')).toBeInTheDocument()
    expect(screen.getAllByText('ts11@1.0.1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Person Identification Data').length).toBeGreaterThan(0)
    expect(screen.getByText('iso_18045_high')).toBeInTheDocument()
    expect(screen.getByText('cryptographic')).toBeInTheDocument()
    expect(screen.getAllByText('dc+sd-jwt').length).toBeGreaterThan(0)

    const schemaLinks = screen.getAllByRole('link', {
      name: /https:\/\/issuer\.example\.org\/schemas\/pid/,
    })
    expect(schemaLinks.length).toBeGreaterThan(0)
    for (const link of schemaLinks) {
      expect(link).toHaveAttribute('href', 'https://issuer.example.org/schemas/pid')
    }

    expect(screen.getByRole('heading', { name: 'Source provenance' })).toBeInTheDocument()
    expect(screen.getByText('https://issuer.example.org/rulebooks/pid')).toBeInTheDocument()
    expect(document.title).toBe('PID Rulebook · AttestBook')
  })

  test('shows every schema reference including rulebook-level ones', async () => {
    renderDetail()

    const section = await screen.findByRole('region', { name: 'Schema references' })
    expect(within(section).getByText('dc+sd-jwt')).toBeInTheDocument()
    expect(within(section).getByText('mso_mdoc')).toBeInTheDocument()
    expect(within(section).getByText('Rulebook-level')).toBeInTheDocument()
    expect(within(section).getByText('None recorded')).toBeInTheDocument()
    expect(
      within(section).getByText('sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='),
    ).toBeInTheDocument()
  })

  test('reports standards compatibility and marks unsupported evaluations', async () => {
    renderDetail()

    const section = await screen.findByRole('region', { name: 'Standards compatibility' })
    expect(
      within(section).getByText('Rulebook-level compatibility: not tested.'),
    ).toBeInTheDocument()
    expect(within(section).getAllByText('Not tested')).toHaveLength(3)
    expect(within(section).getAllByText('Not applicable')).toHaveLength(2)
    expect(within(section).getAllByText('Supported per credential')).toHaveLength(4)
    expect(within(section).getByText('Cryptographic verification')).toBeInTheDocument()
    expect(within(section).getByText('End-to-end interoperability')).toBeInTheDocument()
  })

  test('renders newest-first version history with digest and export links', async () => {
    renderDetail()

    const section = await screen.findByRole('region', { name: 'Version history' })
    const rows = within(section).getAllByRole('row')
    expect(within(rows[1]!).getByText('1.1')).toBeInTheDocument()
    expect(within(rows[2]!).getByText('1.0')).toBeInTheDocument()
    expect(within(section).getByText('Latest')).toBeInTheDocument()
    expect(within(section).getByText(`${'a'.repeat(16)}…`)).toBeInTheDocument()

    const exportOne = within(section).getByRole('link', {
      name: 'Export version 1.0 snapshot',
    })
    expect(exportOne).toHaveAttribute('href', '/api/v1/rulebooks/rulebook-pid/versions/1.0/content')
    expect(exportOne).toHaveAttribute('download', 'rulebook-rulebook-pid-1.0.json')
  })

  test('offers an export action for the latest version in the heading', async () => {
    renderDetail()

    const action = await screen.findByRole('link', { name: 'Export version 1.0' })
    expect(action).toHaveAttribute('href', '/api/v1/rulebooks/rulebook-pid/versions/1.0/content')
  })

  test('does not link unsafe reference or source URLs', async () => {
    const unsafe = createFakeApi({
      ...SAMPLE_DATASET,
      rulebooks: [makeRulebook({ sourceUrl: 'javascript:alert(1)' })],
      attestations: {
        'rulebook-pid': [
          makeAttestation({
            schemaReferences: [
              {
                ...SAMPLE_DATASET.schemaReferences['rulebook-pid']![0]!,
                uri: 'javascript:alert(1)',
              },
            ],
          }),
        ],
      },
      schemaReferences: {
        'rulebook-pid': [
          {
            ...SAMPLE_DATASET.schemaReferences['rulebook-pid']![0]!,
            uri: 'javascript:alert(1)',
          },
        ],
      },
    })

    renderDetail(unsafe)

    expect((await screen.findAllByText('javascript:alert(1)')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('link', { name: /javascript/ })).not.toBeInTheDocument()
  })

  test('falls back to the provider identifier when the provider list is unavailable', async () => {
    const api = createFakeApi()
    renderDetail({
      ...api,
      listProviders: () => Promise.reject(new Error('providers unavailable')),
    })

    expect(
      await screen.findByText(/provider-issuer \(not in the provider list\)/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'The provider list could not be loaded, so only the provider identifier is shown.',
      ),
    ).toBeInTheDocument()
  })

  test('marks failed related sections without hiding the rulebook', async () => {
    const api = createFakeApi()
    renderDetail({
      ...api,
      listVersions: () => Promise.reject(new Error('versions unavailable')),
      listSchemaReferences: () => Promise.reject(new Error('references unavailable')),
    })

    expect(await screen.findByRole('heading', { name: 'PID Rulebook' })).toBeInTheDocument()
    expect(
      screen.getByText('The version history could not be loaded, so no versions are shown.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('The schema references could not be loaded, so none are shown.'),
    ).toBeInTheDocument()
  })

  test('shows the empty version state for a rulebook without versions', async () => {
    renderDetail(createFakeApi(), 'rulebook-age')

    expect(
      await screen.findByRole('heading', { name: 'Age Verification Rulebook' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('No versions have been recorded for this rulebook.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Export version/ })).not.toBeInTheDocument()
  })

  test('shows a malformed version record as the values the API returned', async () => {
    const api = createFakeApi({
      ...SAMPLE_DATASET,
      versions: {
        'rulebook-pid': [
          makeVersion({ publishedAt: null, createdAt: 'not-a-date', contentDigest: 'short' }),
        ],
      },
    })

    renderDetail(api)

    expect(await screen.findByText('Not published')).toBeInTheDocument()
    expect(screen.getByText('not-a-date')).toBeInTheDocument()
    expect(screen.getByText('short')).toBeInTheDocument()
  })
})

describe('hosted and external schema provenance', () => {
  const hosted = makeSchemaReference({
    id: 'reference-hosted',
    formatIdentifier: 'dc+sd-jwt',
    uri: HOSTED_SCHEMA.url,
    integrity: HOSTED_SCHEMA.integrity,
    hostedSchema: HOSTED_SCHEMA,
  })
  const external = makeSchemaReference({
    id: 'reference-external',
    formatIdentifier: 'mso_mdoc',
    uri: 'https://issuer.example.org/schemas/pid-mdoc',
    integrity: null,
    hostedSchema: null,
  })
  const dataset = {
    ...SAMPLE_DATASET,
    attestations: {
      'rulebook-pid': [makeAttestation({ schemaReferences: [hosted, external] })],
    },
    schemaReferences: { 'rulebook-pid': [hosted, external] },
  }

  test('distinguishes hosted documents from external URLs in the same rulebook', async () => {
    renderDetail(createFakeApi(dataset))

    const section = await screen.findByRole('region', { name: 'Schema references' })
    expect(within(section).getAllByText('Hosted by AttestBook').length).toBeGreaterThan(0)
    expect(within(section).getAllByText('External URL').length).toBeGreaterThan(0)
    expect(within(section).getAllByText('JSON Schema 2020-12').length).toBeGreaterThan(0)
    expect(within(section).getAllByText('application/schema+json').length).toBeGreaterThan(0)
    expect(within(section).getAllByText(`${'c'.repeat(16)}…`).length).toBeGreaterThan(0)
    expect(within(section).getAllByText('Pin matches stored digest').length).toBeGreaterThan(0)

    const download = within(section).getAllByRole('link', {
      name: /Download the JSON Schema 2020-12 document for dc\+sd-jwt/,
    })[0]!
    expect(download).toHaveAttribute('href', HOSTED_SCHEMA.url)
    expect(download).toHaveAttribute('download', 'attestbook-json-schema-document-pid.json')

    const externalLink = within(section).getAllByRole('link', {
      name: /https:\/\/issuer\.example\.org\/schemas\/pid-mdoc/,
    })[0]!
    expect(externalLink).toHaveAttribute('href', 'https://issuer.example.org/schemas/pid-mdoc')
    expect(externalLink).toHaveAttribute('target', '_blank')
  })

  test('inspects the exact frozen version and names its hosted references', async () => {
    const user = userEvent.setup()
    renderDetail(
      createFakeApi({
        ...dataset,
        versionSchemaReferences: {
          'rulebook-pid:1.0': {
            version: '1.0',
            contentDigest: 'a'.repeat(64),
            status: 'published',
            publishedAt: '2026-02-03T10:00:00.000Z',
            attestations: [
              {
                name: 'Person Identification Data',
                schemaReferences: [
                  {
                    formatIdentifier: 'dc+sd-jwt',
                    uri: HOSTED_SCHEMA.url,
                    integrity: HOSTED_SCHEMA.integrity,
                    hostedSchema: HOSTED_SCHEMA,
                  },
                  {
                    formatIdentifier: 'mso_mdoc',
                    uri: 'https://issuer.example.org/schemas/pid-mdoc',
                    integrity: null,
                    hostedSchema: null,
                  },
                ],
              },
            ],
            schemaReferences: [],
          },
        },
      }),
    )

    await user.click(
      await screen.findByRole('button', {
        name: 'Inspect references for version 1.0',
      }),
    )

    expect(await screen.findByText('Schema references in version 1.0')).toBeInTheDocument()
    expect(screen.getByText(/Exact frozen version/)).toBeInTheDocument()
    expect(screen.getAllByText(`${'a'.repeat(16)}…`).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Hosted by AttestBook').length).toBeGreaterThan(0)
    expect(screen.getAllByText('External URL').length).toBeGreaterThan(0)
    expect(screen.getAllByText('application/schema+json').length).toBeGreaterThan(0)
    expect(
      screen.getAllByRole('link', {
        name: /Download the JSON Schema 2020-12 document for dc\+sd-jwt/,
      }).length,
    ).toBeGreaterThan(0)
  })

  test('reports a failed version inspection and retries it', async () => {
    const user = userEvent.setup()
    const api = createFakeApi(dataset)
    let attempts = 0
    renderDetail({
      ...api,
      getVersionSchemaReferences: async (rulebookId, version, signal) => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('The version schema references could not be read.')
        }
        return api.getVersionSchemaReferences(rulebookId, version, signal)
      },
    })

    await user.click(
      await screen.findByRole('button', {
        name: 'Inspect references for version 1.0',
      }),
    )
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The version schema references could not be read.')

    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Schema references in version 1.0')).toBeInTheDocument()
    expect(attempts).toBe(2)
  })
})

describe('rulebook detail accessibility', () => {
  test('has no detectable accessibility violations', async () => {
    renderDetail()

    await screen.findByRole('heading', { name: 'PID Rulebook' })
    await expectNoA11yViolations(document.body)
  })

  test('has no detectable accessibility violations in the not-found state', async () => {
    renderDetail(createFakeApi(), 'rulebook-missing')

    await screen.findByRole('alert')
    await expectNoA11yViolations(document.body)
  })
})
