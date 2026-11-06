import { useCallback, useEffect, useMemo, useState } from 'react'

import type { CatalogApi } from './api'
import type { CatalogSnapshot, CatalogFilters as Filters } from './catalog'
import { EMPTY_FILTERS, filterEntries, isFiltering, loadCatalog, providerOptions } from './catalog'
import { CatalogFilterBar } from './components/CatalogFilters'
import { CatalogTable } from './components/CatalogTable'
import { EmptyState, ErrorState, LoadingState } from './components/CatalogStates'
import { SiteFooter, SiteHeader, SkipLink } from './components/Layout'
import { AppLink, NEW_RULEBOOK_PATH } from './router'

interface CatalogPageProps {
  readonly api: CatalogApi
  readonly onNavigate: (path: string) => void
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly snapshot: CatalogSnapshot }
  | { readonly status: 'error'; readonly message: string }

export function CatalogPage({ api, onNavigate }: CatalogPageProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })

    loadCatalog(api, controller.signal)
      .then((snapshot) => {
        if (!controller.signal.aborted) {
          setState({ status: 'ready', snapshot })
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return
        }
        setState({
          status: 'error',
          message:
            error instanceof Error && error.message !== ''
              ? error.message
              : 'The catalog request failed.',
        })
      })

    return () => controller.abort()
  }, [api, reloadToken])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  const clearFilters = useCallback(() => setFilters(EMPTY_FILTERS), [])

  const providers = useMemo(
    () =>
      state.status === 'ready'
        ? providerOptions(state.snapshot.entries, state.snapshot.providers)
        : [],
    [state],
  )
  const filtering = isFiltering(filters)
  const filteredEntries = useMemo(
    () => (state.status === 'ready' ? filterEntries(state.snapshot.entries, filters) : []),
    [state, filters],
  )

  return (
    <div className="app-shell">
      <SkipLink href="#catalog-results">Skip to catalog results</SkipLink>

      <SiteHeader section="Rulebook catalog" onNavigate={onNavigate} />

      <main className="page" id="main-content">
        <div className="page-heading">
          <p className="eyebrow">Catalog</p>
          <h1>Rulebook catalog</h1>
          <p className="lede">
            Browse attestation rulebooks by provider, version, publication status and attestation
            type. Every entry comes from the public AttestBook API.
          </p>
          <p className="page-heading__actions">
            <AppLink
              className="button button--primary"
              href={NEW_RULEBOOK_PATH}
              onNavigate={onNavigate}
            >
              New rulebook
            </AppLink>
          </p>
        </div>

        {state.status === 'ready' ? (
          <CatalogFilterBar
            filters={filters}
            providers={providers}
            resultCount={filteredEntries.length}
            totalCount={state.snapshot.entries.length}
            catalogTotal={state.snapshot.total}
            onChange={setFilters}
            onClear={clearFilters}
          />
        ) : null}

        <section
          className="results"
          id="catalog-results"
          aria-label="Catalog results"
          aria-busy={state.status === 'loading'}
        >
          {state.status === 'ready' && state.snapshot.truncated ? (
            <p className="notice">
              Showing the first {state.snapshot.entries.length} of {state.snapshot.total} rulebooks;
              search and filters apply only to these {state.snapshot.entries.length}.
            </p>
          ) : null}

          {state.status === 'loading' ? <LoadingState /> : null}

          {state.status === 'error' ? (
            <ErrorState message={state.message} onRetry={reload} />
          ) : null}

          {state.status === 'ready' ? (
            state.snapshot.entries.length === 0 ? (
              <EmptyState filtering={false} onClear={clearFilters} />
            ) : filteredEntries.length === 0 ? (
              <EmptyState
                filtering={filtering}
                partial={state.snapshot.truncated}
                onClear={clearFilters}
              />
            ) : (
              <CatalogTable entries={filteredEntries} onNavigate={onNavigate} />
            )
          ) : null}
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
