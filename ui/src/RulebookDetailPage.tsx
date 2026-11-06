import { useCallback, useEffect, useState } from 'react'

import type { CatalogApi } from './api'
import { CatalogApiError } from './api'
import { formatDate } from './catalog'
import {
  AttestationsSection,
  CompatibilitySection,
  MetadataSection,
  ProvenanceSection,
  SchemaReferencesSection,
  VersionsSection,
  VersionSummary,
} from './components/DetailSections'
import { SiteFooter, SiteHeader, SkipLink } from './components/Layout'
import { ErrorState, LoadingState } from './components/CatalogStates'
import { VersionComparisonPanel } from './components/VersionComparisonPanel'
import type { RulebookDetailSnapshot } from './detail'
import { loadRulebookDetail } from './detail'
import { AppLink, CATALOG_PATH, rulebookEditorPath } from './router'

interface RulebookDetailPageProps {
  readonly api: CatalogApi
  readonly rulebookId: string
  readonly onNavigate: (path: string) => void
}

type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly snapshot: RulebookDetailSnapshot }
  | { readonly status: 'not-found' }
  | { readonly status: 'error'; readonly message: string }

export function RulebookDetailPage({ api, rulebookId, onNavigate }: RulebookDetailPageProps) {
  const [state, setState] = useState<DetailState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })

    loadRulebookDetail(api, rulebookId, controller.signal)
      .then((snapshot) => {
        if (!controller.signal.aborted) {
          setState({ status: 'ready', snapshot })
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return
        }
        if (error instanceof CatalogApiError && error.status === 404) {
          setState({ status: 'not-found' })
          return
        }
        setState({
          status: 'error',
          message:
            error instanceof Error && error.message !== ''
              ? error.message
              : 'The rulebook request failed.',
        })
      })

    return () => controller.abort()
  }, [api, rulebookId, reloadToken])

  useEffect(() => {
    if (state.status === 'ready') {
      document.title = `${state.snapshot.rulebook.name} · AttestBook`
    } else if (state.status === 'not-found') {
      document.title = 'Rulebook not found · AttestBook'
    }
  }, [state])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  const backToCatalog = useCallback(() => onNavigate(CATALOG_PATH), [onNavigate])

  const heading = state.status === 'ready' ? state.snapshot.rulebook.name : 'Rulebook details'

  return (
    <div className="app-shell">
      <SkipLink href="#rulebook-detail">Skip to rulebook details</SkipLink>

      <SiteHeader section="Rulebook detail" onNavigate={onNavigate} />

      <main className="page" id="main-content">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <ol>
            <li>
              <AppLink href={CATALOG_PATH} onNavigate={onNavigate}>
                Rulebook catalog
              </AppLink>
            </li>
            <li aria-current="page">{heading}</li>
          </ol>
        </nav>

        <div id="rulebook-detail" tabIndex={-1}>
          {state.status === 'loading' ? (
            <LoadingState
              title="Loading rulebook…"
              detail="Reading the public rulebook API."
              rowCount={5}
            />
          ) : null}

          {state.status === 'not-found' ? (
            <div className="state-panel state-panel--empty" role="alert">
              <h1 className="state-title">Rulebook not found</h1>
              <p className="state-detail">
                No rulebook matches this address. It may have been removed, or the identifier may be
                incorrect.
              </p>
              <button type="button" className="button button--primary" onClick={backToCatalog}>
                Back to the catalog
              </button>
            </div>
          ) : null}

          {state.status === 'error' ? (
            <ErrorState
              title="The rulebook could not be loaded."
              message={state.message}
              onRetry={reload}
            />
          ) : null}

          {state.status === 'ready' ? (
            <DetailContent api={api} snapshot={state.snapshot} onNavigate={onNavigate} />
          ) : null}
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}

function DetailContent({
  api,
  snapshot,
  onNavigate,
}: {
  readonly api: CatalogApi
  readonly snapshot: RulebookDetailSnapshot
  readonly onNavigate: (path: string) => void
}) {
  const { rulebook, versions } = snapshot
  return (
    <>
      <header className="detail-heading">
        <p className="eyebrow">Rulebook</p>
        <h1>{rulebook.name}</h1>
        {rulebook.description === '' ? null : <p className="lede">{rulebook.description}</p>}
        <p className="detail-heading__meta">
          <span>{rulebook.applicableSpec}</span>
          <span aria-hidden="true"> · </span>
          <span>Last updated {formatDate(rulebook.updatedAt)}</span>
          {versions.length > 0 ? (
            <>
              <span aria-hidden="true"> · </span>
              <span>{versions.length === 1 ? '1 version' : `${versions.length} versions`}</span>
            </>
          ) : null}
        </p>
        <div className="detail-actions">
          <VersionSummary snapshot={snapshot} />
          {rulebook.publicationStatus === 'draft' ? (
            <AppLink
              className="button button--ghost"
              href={rulebookEditorPath(rulebook.id)}
              onNavigate={onNavigate}
            >
              Edit draft
            </AppLink>
          ) : null}
        </div>
      </header>

      <div className="detail-grid">
        <MetadataSection snapshot={snapshot} />
        <ProvenanceSection snapshot={snapshot} />
      </div>

      <AttestationsSection snapshot={snapshot} />
      <SchemaReferencesSection snapshot={snapshot} />
      <CompatibilitySection />
      <VersionsSection snapshot={snapshot} />
      <VersionComparisonPanel api={api} rulebookId={rulebook.id} versions={versions} />
    </>
  )
}
