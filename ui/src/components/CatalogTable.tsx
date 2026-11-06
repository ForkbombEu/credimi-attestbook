import type { CatalogEntry } from '../catalog'
import { describeSource, formatDate, PUBLICATION_STATUS_LABELS } from '../catalog'
import { AppLink, rulebookPath } from '../router'

import { CompatibilityBadge, DetailsUnavailableBadge, StatusBadge } from './Badges'

function VersionCell({ entry }: { readonly entry: CatalogEntry }) {
  if (entry.version === null) {
    return <span className="muted">No versions yet</span>
  }
  return (
    <span className="version-cell">
      <span className="version-label">{entry.version}</span>
      <span className="version-meta">
        {entry.versionStatus === null ? '' : PUBLICATION_STATUS_LABELS[entry.versionStatus]} ·{' '}
        {entry.versionCount === 1 ? '1 version' : `${entry.versionCount} versions`}
      </span>
    </span>
  )
}

function SourceCell({ sourceUrl }: { readonly sourceUrl: string | null }) {
  const source = describeSource(sourceUrl)
  if (source.href === null) {
    return <span className="muted">{source.label}</span>
  }
  return (
    <a
      className="source-link"
      href={source.href}
      target="_blank"
      rel="noopener noreferrer"
      title={source.href}
    >
      {source.label}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

function AttestationCell({ entry }: { readonly entry: CatalogEntry }) {
  if (entry.detailsUnavailable) {
    return (
      <div className="attestation-cell">
        <DetailsUnavailableBadge />
      </div>
    )
  }
  if (entry.attestations.length === 0) {
    return <span className="muted">None</span>
  }
  return (
    <div className="attestation-cell">
      <ul className="tag-list">
        {entry.attestations.map((attestation) => (
          <li key={attestation.name}>
            <span
              className="tag"
              title={`LoS: ${attestation.attestationLoS} · Binding: ${attestation.bindingType} · Formats: ${attestation.supportedFormats.join(', ') || 'not stated'}`}
            >
              {attestation.name}
            </span>
          </li>
        ))}
      </ul>
      {entry.supportedFormats.length > 0 ? (
        <span className="format-list">{entry.supportedFormats.join(' · ')}</span>
      ) : null}
    </div>
  )
}

export function CatalogTable({
  entries,
  onNavigate,
}: {
  readonly entries: readonly CatalogEntry[]
  readonly onNavigate: (path: string) => void
}) {
  return (
    <div className="table-wrap">
      <table className="catalog-table">
        <caption className="sr-only">
          Attestation rulebooks matching the current search and filters
        </caption>
        <thead>
          <tr>
            <th scope="col">Rulebook</th>
            <th scope="col">Provider</th>
            <th scope="col">Version</th>
            <th scope="col">Status</th>
            <th scope="col">Attestation types</th>
            <th scope="col">Source</th>
            <th scope="col">Last updated</th>
            <th scope="col">Compatibility</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td data-label="Rulebook">
                <AppLink
                  className="rulebook-name"
                  href={rulebookPath(entry.id)}
                  onNavigate={onNavigate}
                >
                  {entry.name}
                </AppLink>
                {entry.description === '' ? null : (
                  <span className="rulebook-description">{entry.description}</span>
                )}
                <span className="rulebook-spec">{entry.applicableSpec}</span>
              </td>
              <td data-label="Provider">
                <span className={entry.providerKnown ? '' : 'muted'} title={entry.providerId}>
                  {entry.providerName}
                </span>
              </td>
              <td data-label="Version">
                <VersionCell entry={entry} />
              </td>
              <td data-label="Status">
                <StatusBadge status={entry.publicationStatus} />
              </td>
              <td data-label="Attestation types">
                <AttestationCell entry={entry} />
              </td>
              <td data-label="Source">
                <SourceCell sourceUrl={entry.sourceUrl} />
              </td>
              <td data-label="Last updated">
                <time dateTime={entry.updatedAt}>{formatDate(entry.updatedAt)}</time>
              </td>
              <td data-label="Compatibility">
                <CompatibilityBadge />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
