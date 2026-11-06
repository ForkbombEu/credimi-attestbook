import type { CatalogFilters, StatusFilter } from '../catalog'
import { PUBLICATION_STATUS_LABELS } from '../catalog'

interface CatalogFiltersProps {
  readonly filters: CatalogFilters
  readonly providers: readonly { readonly id: string; readonly name: string }[]
  readonly resultCount: number
  readonly totalCount: number
  readonly catalogTotal: number
  readonly onChange: (filters: CatalogFilters) => void
  readonly onClear: () => void
}

const STATUS_OPTIONS: readonly StatusFilter[] = ['all', 'draft', 'published', 'historical']

export function CatalogFilterBar({
  filters,
  providers,
  resultCount,
  totalCount,
  catalogTotal,
  onChange,
  onClear,
}: CatalogFiltersProps) {
  const filtering =
    filters.query.trim() !== '' || filters.providerId !== 'all' || filters.status !== 'all'

  return (
    <form
      className="filter-bar"
      role="search"
      aria-label="Rulebook catalog filters"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="field field--search">
        <label htmlFor="catalog-search">Search</label>
        <input
          id="catalog-search"
          name="query"
          type="search"
          autoComplete="off"
          placeholder="Name, provider, attestation type or format"
          value={filters.query}
          onChange={(event) => onChange({ ...filters, query: event.target.value })}
        />
      </div>

      <div className="field">
        <label htmlFor="provider-filter">Provider</label>
        <select
          id="provider-filter"
          name="provider"
          value={filters.providerId}
          onChange={(event) => onChange({ ...filters, providerId: event.target.value })}
        >
          <option value="all">All providers</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="status-filter">Status</label>
        <select
          id="status-filter"
          name="status"
          value={filters.status}
          onChange={(event) => onChange({ ...filters, status: event.target.value as StatusFilter })}
        >
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status === 'all' ? 'All statuses' : PUBLICATION_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>

      <button
        type="button"
        className="button button--ghost"
        onClick={onClear}
        disabled={!filtering}
      >
        Clear filters
      </button>

      <p className="result-count" role="status" aria-live="polite">
        {catalogTotal > totalCount ? (
          <>
            Showing <strong>{resultCount}</strong> of <strong>{totalCount}</strong> loaded rulebooks
            (<strong>{catalogTotal}</strong> in the catalog)
          </>
        ) : (
          <>
            Showing <strong>{resultCount}</strong> of <strong>{totalCount}</strong> rulebooks
          </>
        )}
      </p>
    </form>
  )
}
