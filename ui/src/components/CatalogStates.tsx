interface LoadingStateProps {
  readonly rowCount?: number
}

export function LoadingState({ rowCount = 4 }: LoadingStateProps) {
  return (
    <div className="state-panel state-panel--loading">
      <h2 className="state-title">
        <span role="status" aria-live="polite">
          Loading rulebooks…
        </span>
      </h2>
      <p className="state-detail">Reading the public catalogue API.</p>
      <div className="skeleton-table" aria-hidden="true">
        {Array.from({ length: rowCount }, (_, index) => (
          <div className="skeleton-row" key={index}>
            <span className="skeleton-block skeleton-block--wide" />
            <span className="skeleton-block" />
            <span className="skeleton-block" />
            <span className="skeleton-block skeleton-block--short" />
          </div>
        ))}
      </div>
    </div>
  )
}

interface ErrorStateProps {
  readonly message: string
  readonly onRetry: () => void
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="state-panel state-panel--error" role="alert">
      <h2 className="state-title">The rulebook catalog could not be loaded.</h2>
      <p className="state-detail">{message}</p>
      <button type="button" className="button button--primary" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

interface EmptyStateProps {
  readonly filtering: boolean
  readonly onClear: () => void
}

export function EmptyState({ filtering, onClear }: EmptyStateProps) {
  if (!filtering) {
    return (
      <div className="state-panel state-panel--empty">
        <h2 className="state-title">No rulebooks yet</h2>
        <p className="state-detail">
          No rulebooks have been registered on this server. Imported or authored rulebooks will
          appear here.
        </p>
      </div>
    )
  }
  return (
    <div className="state-panel state-panel--empty">
      <h2 className="state-title">No rulebooks match your filters</h2>
      <p className="state-detail">Try a different search term, provider or publication status.</p>
      <button type="button" className="button button--primary" onClick={onClear}>
        Reset search and filters
      </button>
    </div>
  )
}
