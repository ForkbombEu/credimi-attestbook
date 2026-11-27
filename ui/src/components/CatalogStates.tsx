import { Alert } from './Alert'

interface LoadingStateProps {
  readonly rowCount?: number
  readonly title?: string
  readonly detail?: string
}

export function LoadingState({
  rowCount = 4,
  title = 'Loading rulebooks…',
  detail = 'Reading the public catalogue API.',
}: LoadingStateProps) {
  return (
    <div className="state-panel state-panel--loading">
      <h2 className="state-title">
        <span role="status" aria-live="polite">
          {title}
        </span>
      </h2>
      <p className="state-detail">{detail}</p>
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
  readonly title?: string
}

export function ErrorState({
  message,
  onRetry,
  title = 'The rulebook catalog could not be loaded.',
}: ErrorStateProps) {
  return (
    <Alert
      variant="destructive"
      title={title}
      titleAs="h2"
      role="alert"
      action={
        <button type="button" className="btn btn-outline btn-sm" onClick={onRetry}>
          Retry
        </button>
      }
    >
      <p>{message}</p>
    </Alert>
  )
}

interface EmptyStateProps {
  readonly filtering: boolean
  readonly partial?: boolean
  readonly onClear: () => void
}

export function EmptyState({ filtering, partial = false, onClear }: EmptyStateProps) {
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
      {partial ? (
        <p className="state-detail">
          Only the loaded page was searched; the catalog has more entries than the API page limit.
        </p>
      ) : null}
      <button type="button" className="btn btn-primary btn-md" onClick={onClear}>
        Reset search and filters
      </button>
    </div>
  )
}
