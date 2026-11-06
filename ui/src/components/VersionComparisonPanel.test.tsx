// Version comparison panel tests (issue #41, UI-003 "version diff").

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CatalogApiError, type CatalogApi } from '../api'
import type { CatalogDataset } from '../test/fixtures'
import { createFakeApi, makeVersion, SAMPLE_DATASET } from '../test/fixtures'
import { expectNoA11yViolations } from '../test/a11y'

import { VersionComparisonPanel } from './VersionComparisonPanel'

const VERSIONS = SAMPLE_DATASET.versions['rulebook-pid'] ?? []

function renderPanel(api: CatalogApi = createFakeApi(), versions = VERSIONS) {
  return render(<VersionComparisonPanel api={api} rulebookId="rulebook-pid" versions={versions} />)
}

describe('version comparison panel', () => {
  test('compares the selected versions and shows the deterministic changes', async () => {
    const user = userEvent.setup()
    renderPanel()

    expect(screen.getByRole('heading', { name: 'Compare versions' })).toBeVisible()
    expect(screen.getByLabelText('Baseline version')).toHaveValue('1.0')
    expect(screen.getByLabelText('Compared version')).toHaveValue('1.1')

    await user.click(screen.getByRole('button', { name: 'Compare' }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('1 change between 1.0 and 1.1')
    const table = screen.getByRole('table')
    const row = within(table).getByRole('row', { name: /\/name/ })
    expect(row).toHaveTextContent('changed')
    expect(row).toHaveTextContent('Rulebook at 1.0')
    expect(row).toHaveTextContent('Rulebook at 1.1')
    await expectNoA11yViolations(document.body)
  })

  test('reports identical authored content across two labels', async () => {
    const identical: CatalogDataset = {
      ...SAMPLE_DATASET,
      versions: {
        'rulebook-pid': [
          makeVersion({ id: 'version-1', version: '1.0' }),
          makeVersion({ id: 'version-2', version: '2.0', status: 'draft', publishedAt: null }),
        ],
      },
    }
    const user = userEvent.setup()
    renderPanel(createFakeApi(identical), identical.versions['rulebook-pid'] ?? [])

    await user.click(screen.getByRole('button', { name: 'Compare' }))

    expect(await screen.findByText(/have identical authored content/)).toBeVisible()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  test('surfaces a comparison failure with a retry', async () => {
    const api = createFakeApi()
    let attempts = 0
    const flaky: CatalogApi = {
      ...api,
      getVersionDiff: async (rulebookId, fromVersion, toVersion, signal) => {
        attempts += 1
        if (attempts === 1) {
          throw new CatalogApiError('The version comparison endpoint is unavailable.', 503)
        }
        return api.getVersionDiff(rulebookId, fromVersion, toVersion, signal)
      },
    }
    const user = userEvent.setup()
    renderPanel(flaky)

    await user.click(screen.getByRole('button', { name: 'Compare' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The versions could not be compared')
    expect(alert).toHaveTextContent('The version comparison endpoint is unavailable.')

    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('status')).toHaveTextContent('1 change between 1.0 and 1.1')
  })

  test('asks for two versions before enabling a comparison', () => {
    renderPanel(createFakeApi(), [makeVersion()])

    expect(screen.getByText('Record at least two versions to compare them.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Compare' })).not.toBeInTheDocument()
  })

  test('does not compare a version with itself', async () => {
    const user = userEvent.setup()
    renderPanel()

    await user.selectOptions(screen.getByLabelText('Compared version'), '1.0')

    expect(screen.getByText('Choose two different versions.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Compare' })).toBeDisabled()
  })

  test('abort-aware fake is still called with the selected labels', async () => {
    const api = createFakeApi()
    const spy = vi.spyOn(api, 'getVersionDiff')
    const user = userEvent.setup()
    renderPanel(api)

    await user.click(screen.getByRole('button', { name: 'Compare' }))
    await screen.findByRole('status')

    expect(spy).toHaveBeenCalledWith('rulebook-pid', '1.0', '1.1', expect.any(AbortSignal))
  })
})
