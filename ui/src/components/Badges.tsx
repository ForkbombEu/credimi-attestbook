import type { PublicationStatus } from '../types'
import { PUBLICATION_STATUS_LABELS } from '../catalog'

export function StatusBadge({ status }: { readonly status: PublicationStatus }) {
  return <span className={`badge badge--${status}`}>{PUBLICATION_STATUS_LABELS[status]}</span>
}

export function CompatibilityBadge() {
  return (
    <span
      className="badge badge--untested"
      title="Structural validation runs per credential against a pinned rulebook version."
    >
      Not tested
    </span>
  )
}

export function DetailsUnavailableBadge() {
  return (
    <span className="badge badge--warning" title="The per-rulebook API request failed.">
      Details unavailable
    </span>
  )
}
