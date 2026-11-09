import { useState } from 'react'

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CatalogApiError, type CaptureExplorerApi, type CatalogApi } from './api'
import { CaptureDetailPage } from './CaptureDetailPage'
import { makeBoundCaptureDetail, makeCaptureDetail, makeCaptureSummary } from './test/captures'
import { createFakeApi, makeValidationResult } from './test/fixtures'
import type { CorrelateCaptureRequest } from './types'
import { expectNoA11yViolations } from './test/a11y'

interface HarnessProps {
  readonly api: CaptureExplorerApi
  readonly catalogApi: CatalogApi
  readonly onNavigate: (path: string) => void
  readonly initialToken: string
}

function Harness({ api, catalogApi, onNavigate, initialToken }: HarnessProps) {
  const [token, setToken] = useState(initialToken)
  return (
    <CaptureDetailPage
      api={api}
      catalogApi={catalogApi}
      captureId="mock-capture-capture-issuer-3"
      token={token}
      onTokenChange={setToken}
      onNavigate={onNavigate}
    />
  )
}

function renderPage(
  api: CaptureExplorerApi = {
    listCaptures: () => new Promise(() => {}),
    getCapture: () => Promise.resolve(makeCaptureDetail()),
    correlateCapture: () => new Promise(() => {}),
  },
  catalogApi: CatalogApi = createFakeApi(),
  initialToken = '',
) {
  const onNavigate = vi.fn()
  const view = render(
    <Harness
      api={api}
      catalogApi={catalogApi}
      onNavigate={onNavigate}
      initialToken={initialToken}
    />,
  )
  return { ...view, onNavigate }
}

const pendingApi: CaptureExplorerApi = {
  listCaptures: () => new Promise(() => {}),
  getCapture: () => new Promise(() => {}),
  correlateCapture: () => new Promise(() => {}),
}

async function selectCorrelation(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(await screen.findByLabelText('Rulebook'), 'PID Rulebook')
  await screen.findByRole('option', { name: '1.0 (published)' })
  await user.selectOptions(screen.getByLabelText('Rulebook version'), '1.0')
  await user.selectOptions(screen.getByLabelText('Attestation type'), 'Person Identification Data')
}

describe('capture detail loading', () => {
  test('shows a loading state while the capture is requested', () => {
    renderPage(pendingApi)
    expect(screen.getByRole('status')).toHaveTextContent('Loading capture evidence…')
  })

  test('shows the not-found state and navigates back to the explorer', async () => {
    const user = userEvent.setup()
    const api: CaptureExplorerApi = {
      ...pendingApi,
      getCapture: () =>
        Promise.reject(new CatalogApiError('The requested capture does not exist.', 404)),
    }
    const { onNavigate } = renderPage(api)

    expect(await screen.findByRole('heading', { name: 'Capture not found' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to the capture explorer' }))
    expect(onNavigate).toHaveBeenCalledWith('/captures')
  })

  test('shows a load error and retries the request', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const api: CaptureExplorerApi = {
      ...pendingApi,
      getCapture: () => {
        attempts += 1
        if (attempts === 1) {
          return Promise.reject(
            new CatalogApiError('The capture explorer is not configured on this server.', 503),
          )
        }
        return Promise.resolve(makeCaptureDetail())
      },
    }
    renderPage(api)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The capture could not be loaded.')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByRole('heading', { name: 'mock-capture-capture-issuer-3' }),
    ).toBeInTheDocument()
    expect(attempts).toBe(2)
  })
})

describe('capture detail evidence', () => {
  test('renders normalized metadata, the redacted projection, timeline and limitations', async () => {
    renderPage()

    expect(
      await screen.findByRole('heading', { name: 'mock-capture-capture-issuer-3' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Mock-backed capture evidence')).toBeInTheDocument()
    expect(screen.getByText('mock-correlation-3')).toBeInTheDocument()
    expect(screen.getByText('mock-execution-3')).toBeInTheDocument()
    expect(screen.getByText('capture-issuer 0.0.0-mock')).toBeInTheDocument()

    const projection = screen.getByLabelText('Redacted artifact projection')
    expect(projection).toHaveTextContent('[redacted]')
    expect(projection).toHaveTextContent('urn:example:attestbook:mock:pid:1')
    expect(projection).not.toHaveTextContent('synthetic-access-token-not-a-secret')

    expect(screen.getByText('No rulebook binding')).toBeInTheDocument()
    expect(screen.getAllByText('Validation not run').length).toBeGreaterThan(0)
    expect(screen.getByText(/never claims cryptographic/i)).toBeInTheDocument()
    expect(screen.getAllByText(/deterministic local mock source/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Evidence captured/)).toBeInTheDocument()
  })

  test('reports an external artifact reference as unavailable and offers no validation', async () => {
    const api: CaptureExplorerApi = {
      ...pendingApi,
      getCapture: () =>
        Promise.resolve(
          makeCaptureDetail({
            artifact: {
              availability: 'external',
              mediaType: 'application/json',
              byteLength: 512,
              uri: 'https://artifacts.example.test/mock/issuer-metadata.json',
            },
            artifactProjection: null,
            evidenceGaps: [
              {
                code: 'external_artifact_not_fetched',
                message: 'The artifact is stored behind an external reference.',
              },
            ],
          }),
        ),
    }
    renderPage(api)

    expect((await screen.findAllByText('External artifact not fetched')).length).toBeGreaterThan(0)
    expect(
      screen.getByRole('link', {
        name: /https:\/\/artifacts\.example\.test\/mock\/issuer-metadata\.json/,
      }),
    ).toHaveAttribute('href', 'https://artifacts.example.test/mock/issuer-metadata.json')
    expect(
      screen.getByText(/Credential validation is not available for this evidence/),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Rulebook')).not.toBeInTheDocument()
  })

  test('reports source-redacted evidence and offers no validation', async () => {
    const api: CaptureExplorerApi = {
      ...pendingApi,
      getCapture: () =>
        Promise.resolve(
          makeCaptureDetail({
            declaredRedaction: {
              status: 'partial',
              policyRef: 'source-policy',
              redactedPaths: ['/claims'],
              redactedDigest: 'e'.repeat(64),
            },
          }),
        ),
    }
    renderPage(api)

    expect(
      await screen.findByText(/Credential validation is not available for this evidence/),
    ).toBeInTheDocument()
    expect(screen.getAllByText(/partially redacted/i).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Run validation' })).not.toBeInTheDocument()
  })

  test('reports a non-credential artifact type without a validation form', async () => {
    const api: CaptureExplorerApi = {
      ...pendingApi,
      getCapture: () =>
        Promise.resolve(
          makeCaptureDetail({
            artifactType: 'verification-outcome',
            artifactProjection: null,
          }),
        ),
    }
    renderPage(api)
    expect(await screen.findByText(/this artifact type carries no credential/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run validation' })).not.toBeInTheDocument()
  })
})

describe('capture detail correlation', () => {
  test('runs the real correlation request and displays the linked validation findings', async () => {
    const user = userEvent.setup()
    let current = makeCaptureDetail()
    const correlate = vi.fn(
      async (_captureId: string, _request: CorrelateCaptureRequest, _token: string) => {
        current = makeBoundCaptureDetail()
        const binding = current.rulebook
        if (binding === null) {
          throw new Error('the fixture must be bound to a rulebook version')
        }
        return {
          captureId: current.captureId,
          correlationId: current.correlationId,
          testExecutionRef: current.testExecutionRef,
          rulebook: binding,
          validation: makeValidationResult(),
        }
      },
    )
    const api: CaptureExplorerApi = {
      listCaptures: () =>
        Promise.resolve({ data: [], pagination: { limit: 100, offset: 0, total: 0 } }),
      getCapture: () => Promise.resolve(current),
      correlateCapture: correlate,
    }
    renderPage(api)

    await selectCorrelation(user)
    await user.type(screen.getByLabelText('Provider token'), 'att_test_token')
    await user.click(screen.getByRole('button', { name: 'Run validation' }))

    expect(correlate.mock.calls[0]?.[0]).toBe('mock-capture-capture-issuer-3')
    expect(correlate.mock.calls[0]?.[1]).toEqual({
      rulebookId: 'rulebook-pid',
      rulebookVersion: '1.0',
      attestationType: 'Person Identification Data',
    })
    expect(correlate.mock.calls[0]?.[2]).toBe('att_test_token')
    expect(await screen.findByRole('heading', { name: 'Overall result' })).toBeInTheDocument()
    expect(screen.getByText('rulebook-pid')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'PID Rulebook' })).toHaveAttribute(
      'href',
      '/rulebooks/rulebook-pid',
    )
    expect(screen.getByText('1.0 · published')).toBeInTheDocument()
    expect(screen.getByText(/linked to the pinned rulebook version/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export result (JSON)' })).toBeInTheDocument()
  })

  test('requires a complete selection before sending a request', async () => {
    const user = userEvent.setup()
    const correlate = vi.fn()
    const api: CaptureExplorerApi = {
      listCaptures: () =>
        Promise.resolve({ data: [], pagination: { limit: 100, offset: 0, total: 0 } }),
      getCapture: () => Promise.resolve(makeCaptureDetail()),
      correlateCapture: correlate,
    }
    renderPage(api)

    await screen.findByLabelText('Rulebook')
    await user.selectOptions(screen.getByLabelText('Rulebook'), 'PID Rulebook')
    const button = screen.getByRole('button', { name: 'Run validation' })
    expect(button).toBeDisabled()
    expect(correlate).not.toHaveBeenCalled()
  })

  test('shows a safe correlation error without leaking evidence', async () => {
    const user = userEvent.setup()
    const api: CaptureExplorerApi = {
      listCaptures: () =>
        Promise.resolve({ data: [], pagination: { limit: 100, offset: 0, total: 0 } }),
      getCapture: () => Promise.resolve(makeCaptureDetail()),
      correlateCapture: () =>
        Promise.reject(
          new CatalogApiError(
            'The capture artifact was declared partial redacted by its source.',
            409,
          ),
        ),
    }
    renderPage(api)

    await selectCorrelation(user)
    await user.type(screen.getByLabelText('Provider token'), 'att_test_token')
    await user.click(screen.getByRole('button', { name: 'Run validation' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('declared partial redacted')
  })

  test('requires a provider token before sending a correlation request', async () => {
    const user = userEvent.setup()
    const correlate = vi.fn()
    const api: CaptureExplorerApi = {
      listCaptures: () =>
        Promise.resolve({ data: [], pagination: { limit: 100, offset: 0, total: 0 } }),
      getCapture: () => Promise.resolve(makeCaptureDetail()),
      correlateCapture: correlate,
    }
    renderPage(api)

    await selectCorrelation(user)
    await user.click(screen.getByRole('button', { name: 'Run validation' }))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A provider token is required to record a correlation.',
    )
    expect(correlate).not.toHaveBeenCalled()
  })

  test('shows the safe unauthorized message when the token is rejected', async () => {
    const user = userEvent.setup()
    const api: CaptureExplorerApi = {
      listCaptures: () =>
        Promise.resolve({ data: [], pagination: { limit: 100, offset: 0, total: 0 } }),
      getCapture: () => Promise.resolve(makeCaptureDetail()),
      correlateCapture: () =>
        Promise.reject(new CatalogApiError('A valid bearer token is required.', 401)),
    }
    renderPage(api)

    await selectCorrelation(user)
    await user.type(screen.getByLabelText('Provider token'), 'att_unknown_token')
    await user.click(screen.getByRole('button', { name: 'Run validation' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('A valid bearer token is required.')
  })

  test('has no detectable accessibility violations with a linked validation', async () => {
    const api: CaptureExplorerApi = {
      ...pendingApi,
      getCapture: () => Promise.resolve(makeBoundCaptureDetail()),
    }
    const { container } = renderPage(api)
    await screen.findByRole('heading', { name: 'Overall result' })
    await expectNoA11yViolations(container)
  })

  test('keeps the capture id as the page heading', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'mock-capture-capture-issuer-3' }),
    ).toBeInTheDocument()
    expect(screen.getByText(makeCaptureSummary().correlationId)).toBeInTheDocument()
  })
})
