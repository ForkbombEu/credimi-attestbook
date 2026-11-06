import type { PublicationStatus, ValidationSeverity, ValidationStatus } from '../types'
import { PUBLICATION_STATUS_LABELS } from '../catalog'
import { VALIDATION_SEVERITY_LABELS, VALIDATION_STATUS_LABELS } from '../playground'

export function StatusBadge({ status }: { readonly status: PublicationStatus }) {
  return <span className={`badge badge--${status}`}>{PUBLICATION_STATUS_LABELS[status]}</span>
}

/** FR-012 status badge; `Not tested` and `Not applicable` are never styled as passes. */
export function ValidationStatusBadge({ status }: { readonly status: ValidationStatus }) {
  return (
    <span className={`badge badge--status-${status.toLowerCase().replaceAll('_', '-')}`}>
      {VALIDATION_STATUS_LABELS[status]}
    </span>
  )
}

export function SeverityBadge({ severity }: { readonly severity: ValidationSeverity }) {
  return (
    <span className={`badge badge--severity-${severity}`}>
      {VALIDATION_SEVERITY_LABELS[severity]}
    </span>
  )
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
