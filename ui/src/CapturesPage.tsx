import { useCallback, useEffect, useState } from 'react'

import type { CaptureExplorerApi } from './api'
import { CatalogApiError, isAbortError } from './api'
import { formatDate } from './catalog'
import {
  CAPTURE_ARTIFACT_TYPE_LABELS,
  CAPTURE_EVIDENCE_GAP_LABELS,
  CAPTURE_INTERACTION_LABELS,
  CAPTURE_SOURCE_COMPONENT_LABELS,
  captureBindingLabel,
} from './capture'
import { ErrorState, LoadingState } from './components/CatalogStates'
import { SiteFooter, SiteHeader, SkipLink } from './components/Layout'
import { ValidationStatusBadge } from './components/Badges'
import { AppLink, CATALOG_PATH, capturePath } from './router'
import type { CaptureExplorerPage, CaptureExplorerSummary } from './types'

interface CapturesPageProps {
  readonly api: CaptureExplorerApi
  readonly onNavigate: (path: string) => void
}

type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly page: CaptureExplorerPage }
  | { readonly status: 'error'; readonly message: string }

function errorMessage(error: unknown): string {
  if (error instanceof CatalogApiError || error instanceof Error) {
    return error.message === '' ? 'The capture explorer request failed.' : error.message
  }
  return 'The capture explorer request failed.'
}

function EvidenceCell({ capture }: { readonly capture: CaptureExplorerSummary }) {
  if (capture.evidenceGaps.length === 0) {
    return <span className="badge badge--published">Complete</span>
  }
  return (
    <ul className="capture-gap-list">
      {capture.evidenceGaps.map((gap) => (
        <li key={gap.code}>
          <span className="badge badge--warning" title={gap.message}>
            {CAPTURE_EVIDENCE_GAP_LABELS[gap.code]}
          </span>
        </li>
      ))}
    </ul>
  )
}

function CaptureRow({
  capture,
  onNavigate,
}: {
  readonly capture: CaptureExplorerSummary
  readonly onNavigate: (path: string) => void
}) {
  return (
    <tr>
      <th scope="row">
        <AppLink
          className="rulebook-name"
          href={capturePath(capture.captureId)}
          onNavigate={onNavigate}
        >
          {capture.captureId}
        </AppLink>
        <p className="version-meta">
          correlation <code>{capture.correlationId}</code>
        </p>
        <p className="version-meta">
          {capture.testExecutionRef === null
            ? 'No test execution reference'
            : `test execution ${capture.testExecutionRef}`}
        </p>
      </th>
      <td data-label="Source & interaction">
        <span>{CAPTURE_SOURCE_COMPONENT_LABELS[capture.source.component]}</span>
        <span className="badge badge--mock">Mock</span>
        <p className="version-meta">
          {CAPTURE_INTERACTION_LABELS[capture.interactionType]} · {capture.protocol}
        </p>
      </td>
      <td data-label="Artifact">
        <span>{CAPTURE_ARTIFACT_TYPE_LABELS[capture.artifactType]}</span>
        <p className="version-meta">{capture.credentialFormat}</p>
        <p className="version-meta">
          {capture.artifact.availability === 'inline' ? 'Inline artifact' : 'External reference'}
        </p>
      </td>
      <td data-label="Captured">
        <span>{formatDate(capture.provenance.capturedAt)}</span>
        <p className="version-meta">received {formatDate(capture.provenance.receivedAt)}</p>
      </td>
      <td data-label="Rulebook & validation">
        <span>{captureBindingLabel(capture)}</span>
        {capture.rulebook === null ? (
          <p className="version-meta">No pinned rulebook version</p>
        ) : (
          <p className="version-meta">{capture.rulebook.attestationType}</p>
        )}
        {capture.validation === null ? (
          <p className="version-meta">Validation not run</p>
        ) : (
          <p className="capture-validation-cell">
            <ValidationStatusBadge status={capture.validation.overallStatus} />
            <span className="version-meta">
              {capture.validation.violations}{' '}
              {capture.validation.violations === 1 ? 'violation' : 'violations'}
            </span>
          </p>
        )}
      </td>
      <td data-label="Evidence">
        <EvidenceCell capture={capture} />
        <p className="version-meta">
          {capture.declaredRedaction.status === 'none'
            ? 'Source redaction: none'
            : `Source redaction: ${capture.declaredRedaction.status}`}
        </p>
      </td>
    </tr>
  )
}

export function CapturesPage({ api, onNavigate }: CapturesPageProps) {
  const [state, setState] = useState<ListState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    api
      .listCaptures(controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setState({ status: 'ready', page })
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          setState({ status: 'error', message: errorMessage(error) })
        }
      })
    return () => controller.abort()
  }, [api, reloadToken])

  useEffect(() => {
    document.title = 'Capture explorer · AttestBook'
  }, [])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  const total = state.status === 'ready' ? state.page.pagination.total : 0

  return (
    <div className="app-shell">
      <SkipLink href="#captures">Skip to capture evidence</SkipLink>

      <SiteHeader section="Capture explorer" onNavigate={onNavigate} />

      <main className="page" id="main-content">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <ol>
            <li>
              <AppLink href={CATALOG_PATH} onNavigate={onNavigate}>
                Rulebook catalog
              </AppLink>
            </li>
            <li aria-current="page">Capture explorer</li>
          </ol>
        </nav>

        <div className="page-heading">
          <div>
            <p className="eyebrow">Capture integration</p>
            <h1>Capture explorer</h1>
            <p className="lede">
              Normalized evidence from issued and presented credentials, correlated with the pinned
              rulebook version a validation ran against and with the source&rsquo;s opaque test
              execution reference.
            </p>
          </div>
        </div>

        <div className="notice notice--warning" role="note">
          <p className="notice-title">Mock-backed explorer</p>
          <p>
            Every capture is served by the deterministic local mock source and is labelled{' '}
            <code>mock</code>. No live <code>capture-issuer</code> or <code>capture-verifier</code>{' '}
            interaction is shown, and AttestBook is not claimed operational for either component.
          </p>
        </div>

        <div id="captures" tabIndex={-1}>
          {state.status === 'loading' ? (
            <LoadingState
              title="Loading capture evidence…"
              detail="Reading the mock-backed capture explorer API."
              rowCount={5}
            />
          ) : null}

          {state.status === 'error' ? (
            <ErrorState
              title="The capture explorer could not be loaded."
              message={state.message}
              onRetry={reload}
            />
          ) : null}

          {state.status === 'ready' && state.page.data.length === 0 ? (
            <div className="state-panel state-panel--empty">
              <h2 className="state-title">No capture evidence yet</h2>
              <p className="state-detail">
                The configured capture source has not served any normalized artifact.
              </p>
            </div>
          ) : null}

          {state.status === 'ready' && state.page.data.length > 0 ? (
            <>
              <p className="result-count" role="status">
                <strong>{state.page.data.length}</strong> of {total}{' '}
                {total === 1 ? 'capture' : 'captures'} shown
              </p>
              <div className="table-wrap">
                <table className="catalog-table capture-table">
                  <caption className="sr-only">
                    Normalized capture evidence with its source, correlation identifiers, pinned
                    rulebook version and explicit evidence gaps.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Capture</th>
                      <th scope="col">Source &amp; interaction</th>
                      <th scope="col">Artifact</th>
                      <th scope="col">Captured</th>
                      <th scope="col">Rulebook &amp; validation</th>
                      <th scope="col">Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.page.data.map((capture) => (
                      <CaptureRow
                        key={capture.captureId}
                        capture={capture}
                        onNavigate={onNavigate}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              {total > state.page.data.length ? (
                <p className="notice">
                  This view shows the first {state.page.data.length} of {total} captures; the
                  explorer API page limit is {state.page.pagination.limit}.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
