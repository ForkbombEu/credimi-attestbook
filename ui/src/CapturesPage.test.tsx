import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CatalogApiError, type CaptureExplorerApi } from './api'
import { CapturesPage } from './CapturesPage'
import { makeCaptureSummary, createFakeCaptureApi } from './test/captures'
import { expectNoA11yViolations } from './test/a11y'

function renderPage(api: CaptureExplorerApi = createFakeCaptureApi()) {
  const onNavigate = vi.fn()
  const view = render(<CapturesPage api={api} onNavigate={onNavigate} />)
  return { ...view, onNavigate }
}

const pendingApi: CaptureExplorerApi = {
  listCaptures: () => new Promise(() => {}),
  getCapture: () => new Promise(() => {}),
  correlateCapture: () => new Promise(() => {}),
}

describe('capture explorer list', () => {
  test('shows a loading state while the captures are requested', () => {
    renderPage(pendingApi)
    expect(screen.getByRole('status')).toHaveTextContent('Loading capture evidence…')
  })

  test('shows a load error and retries the request', async () => {
    const user = userEvent.setup()
    const api = createFakeCaptureApi()
    let attempts = 0
    const flaky: CaptureExplorerApi = {
      ...api,
      listCaptures: async (signal) => {
        attempts += 1
        if (attempts === 1) {
          throw new CatalogApiError('The capture explorer is not configured on this server.', 503)
        }
        return api.listCaptures(signal)
      },
    }
    renderPage(flaky)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The capture explorer could not be loaded.')
    expect(alert).toHaveTextContent('The capture explorer is not configured on this server.')

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('link', { name: 'mock-capture-capture-issuer-3' })).toBeVisible()
    expect(attempts).toBe(2)
  })

  test('shows an empty state when the source served nothing', async () => {
    const empty: CaptureExplorerApi = {
      ...createFakeCaptureApi(),
      listCaptures: async () => ({
        data: [],
        pagination: { limit: 100, offset: 0, total: 0 },
      }),
    }
    renderPage(empty)
    expect(await screen.findByText('No capture evidence yet')).toBeInTheDocument()
  })

  test('renders the normalized evidence with its source, correlation and gaps', async () => {
    const { onNavigate } = renderPage()
    const link = await screen.findByRole('link', { name: 'mock-capture-capture-issuer-3' })
    expect(link).toHaveAttribute('href', '/captures/mock-capture-capture-issuer-3')

    expect(screen.getByText('Mock-backed explorer')).toBeInTheDocument()
    expect(screen.getAllByText('Mock').length).toBeGreaterThan(0)
    expect(screen.getByText('Capture issuer')).toBeInTheDocument()
    expect(screen.getByText('Issued credential')).toBeInTheDocument()
    expect(screen.getByText('dc+sd-jwt')).toBeInTheDocument()
    expect(screen.getByText('mock-correlation-3')).toBeInTheDocument()
    expect(screen.getByText('test execution mock-execution-3')).toBeInTheDocument()
    expect(screen.getByText('No rulebook binding')).toBeInTheDocument()
    expect(screen.getAllByText('Validation not run').length).toBeGreaterThan(0)
    expect(screen.getByText('Not bound')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('1 of 1 capture shown')

    await userEvent.setup().click(link)
    expect(onNavigate).toHaveBeenCalledWith('/captures/mock-capture-capture-issuer-3')
  })

  test('shows the linked pinned version and validation status', async () => {
    const bound = createFakeCaptureApi()
    const api: CaptureExplorerApi = {
      ...bound,
      listCaptures: async () => {
        const page = await bound.listCaptures()
        const [summary] = page.data
        if (summary === undefined) {
          throw new Error('the fixture must contain a capture')
        }
        return {
          data: [
            makeCaptureSummary({
              rulebook: {
                rulebookId: 'rulebook-pid',
                rulebookName: 'PID Rulebook',
                version: '1.0',
                contentDigest: 'a'.repeat(64),
                digestVerified: true,
                specVersion: 'ts11@1.0.1',
                rulebookStatus: 'published',
                attestationType: 'Person Identification Data',
                boundAt: '2026-11-09T10:01:00.000Z',
              },
              validation: {
                validationId: 'validation-0001',
                validatedAt: '2026-11-09T10:01:00.000Z',
                overallStatus: 'NOT_TESTED',
                violations: 1,
                limitations: 2,
                dimensions: [],
              },
              evidenceComplete: false,
            }),
          ],
          pagination: page.pagination,
        }
      },
    }
    renderPage(api)

    expect(await screen.findByText('PID Rulebook 1.0')).toBeInTheDocument()
    expect(screen.getByText('Not tested')).toBeInTheDocument()
    expect(screen.getByText('1 violation')).toBeInTheDocument()
  })

  test('shows an explicit truncation notice when the explorer page is capped', async () => {
    const api: CaptureExplorerApi = {
      ...createFakeCaptureApi(),
      listCaptures: async () => ({
        data: [makeCaptureSummary()],
        pagination: { limit: 100, offset: 0, total: 250 },
      }),
    }
    renderPage(api)
    expect(
      await screen.findByText(/This view shows the first 1 of 250 captures/),
    ).toBeInTheDocument()
  })

  test('has no detectable accessibility violations', async () => {
    const { container } = renderPage()
    await screen.findByRole('link', { name: 'mock-capture-capture-issuer-3' })
    await expectNoA11yViolations(container)
  })

  test('renders the shared capture navigation as the current page', async () => {
    renderPage()
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    const link = within(nav).getByRole('link', { name: 'Capture explorer' })
    expect(link).toHaveAttribute('aria-current', 'page')
  })
})
