import { useCallback, useEffect, useState } from 'react'

import type { CatalogApi } from './api'
import { CatalogApiError } from './api'
import { Alert } from './components/Alert'
import { StatusBadge } from './components/Badges'
import {
  AttestationsSection,
  CompatibilitySection,
  RulebookSummary,
  VersionsSection,
  VersionSummary,
} from './components/DetailSections'
import { PageHero, SiteFooter, SiteHeader, SkipLink } from './components/Layout'
import { ErrorState, LoadingState } from './components/CatalogStates'
import { VersionComparisonPanel } from './components/VersionComparisonPanel'
import type { RulebookDetailSnapshot } from './detail'
import { loadRulebookDetail } from './detail'
import { AppLink, CATALOG_PATH, rulebookEditorPath } from './router'
import { useSession } from './session'

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
  const session = useSession()
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
  const breadcrumb = (
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
  )
  // Only the signed-in administrator bound to the owning provider is offered
  // the editor; the server independently enforces the same ownership rule.
  const canEditDraft =
    state.status === 'ready' &&
    session.status === 'authenticated' &&
    session.session !== null &&
    session.session.provider.id === state.snapshot.rulebook.providerId

  if (state.status === 'not-found') {
    return (
      <div className="app-shell">
        <SkipLink href="#rulebook-detail">Skip to rulebook details</SkipLink>

        <SiteHeader section="Rulebook detail" onNavigate={onNavigate} />

        <main className="page-main" id="main-content">
          <div id="rulebook-detail" tabIndex={-1}>
            <PageHero title="Rulebook not found" alert breadcrumb={breadcrumb}>
              <p>
                No rulebook matches this address. It may have been removed, or the identifier may be
                incorrect.
              </p>
              <p className="hero-actions">
                <button type="button" className="btn btn-outline btn-lg" onClick={backToCatalog}>
                  Back to the catalog
                </button>
              </p>
            </PageHero>
          </div>
        </main>

        <SiteFooter />
      </div>
    )
  }

  return (
    <div className="app-shell">
      <SkipLink href="#rulebook-detail">Skip to rulebook details</SkipLink>

      <SiteHeader section="Rulebook detail" onNavigate={onNavigate} />

      <main className="page-main" id="main-content">
        {state.status === 'ready' ? (
          <PageHero
            title={heading}
            breadcrumb={breadcrumb}
            badge={<StatusBadge status={state.snapshot.rulebook.publicationStatus} />}
          >
            {state.snapshot.rulebook.description === '' ? null : (
              <p>{state.snapshot.rulebook.description}</p>
            )}
            <RulebookSummary snapshot={state.snapshot} />
            <div className="detail-actions">
              <VersionSummary snapshot={state.snapshot} />
              {state.snapshot.rulebook.publicationStatus === 'draft' && canEditDraft ? (
                <AppLink
                  className="btn btn-outline btn-lg"
                  href={rulebookEditorPath(state.snapshot.rulebook.id)}
                  onNavigate={onNavigate}
                >
                  Edit draft
                </AppLink>
              ) : null}
              {state.snapshot.rulebook.publicationStatus === 'published' && canEditDraft ? (
                <AppLink
                  className="btn btn-outline btn-lg"
                  href={rulebookEditorPath(state.snapshot.rulebook.id)}
                  onNavigate={onNavigate}
                >
                  Create new version
                </AppLink>
              ) : null}
            </div>
          </PageHero>
        ) : (
          <PageHero title={heading} breadcrumb={breadcrumb} />
        )}

        <div className="page" id="rulebook-detail" tabIndex={-1}>
          {state.status === 'loading' ? (
            <LoadingState
              title="Loading rulebook…"
              detail="Reading the public rulebook API."
              rowCount={5}
            />
          ) : null}

          {state.status === 'error' ? (
            <ErrorState
              title="The rulebook could not be loaded."
              message={state.message}
              onRetry={reload}
            />
          ) : null}

          {state.status === 'ready' ? <DetailContent api={api} snapshot={state.snapshot} /> : null}
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}

function DetailContent({
  api,
  snapshot,
}: {
  readonly api: CatalogApi
  readonly snapshot: RulebookDetailSnapshot
}) {
  const { rulebook, versions, availability } = snapshot
  return (
    <>
      {availability.provider ? null : (
        <Alert variant="info">
          <p>The provider list could not be loaded, so only the provider identifier is shown.</p>
        </Alert>
      )}

      <AttestationsSection snapshot={snapshot} />
      <CompatibilitySection />
      <VersionsSection snapshot={snapshot} api={api} />
      <VersionComparisonPanel api={api} rulebookId={rulebook.id} versions={versions} />
    </>
  )
}
