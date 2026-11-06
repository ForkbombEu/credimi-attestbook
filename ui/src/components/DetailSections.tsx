import { versionContentPath } from '../api'
import { formatDate } from '../catalog'
import {
  EVALUATION_SUPPORT,
  EVALUATION_SUPPORT_LABELS,
  RULEBOOK_COMPATIBILITY_DISCLOSURE,
} from '../compatibility'
import type { RulebookDetailSnapshot } from '../detail'
import {
  attestationNameFor,
  describeReference,
  formatDigest,
  latestVersion,
  referencesForAttestation,
  versionsNewestFirst,
} from '../detail'
import type { Rulebook, SchemaReference } from '../types'

import { CompatibilityBadge, StatusBadge } from './Badges'

function SectionUnavailable({ children }: { readonly children: string }) {
  return (
    <p className="notice notice--warning" role="status">
      {children}
    </p>
  )
}

function ExternalReference({ uri }: { readonly uri: string }) {
  const target = describeReference(uri)
  if (target.href === null) {
    return <span className="reference-uri reference-uri--inert">{target.label}</span>
  }
  return (
    <a
      className="reference-uri"
      href={target.href}
      target="_blank"
      rel="noopener noreferrer"
      title={target.href}
    >
      {target.label}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

function SchemaReferenceTable({
  references,
  attestations,
  showAttestation = true,
}: {
  readonly references: readonly SchemaReference[]
  readonly attestations: RulebookDetailSnapshot['attestations']
  readonly showAttestation?: boolean
}) {
  return (
    <div className="table-wrap table-wrap--nested">
      <table className="detail-table">
        <caption className="sr-only">
          {showAttestation
            ? 'Schema references with their format identifier, URI, integrity value and attestation type'
            : 'Schema references for this attestation type'}
        </caption>
        <thead>
          <tr>
            <th scope="col">Format</th>
            <th scope="col">Schema URI</th>
            <th scope="col">Integrity</th>
            {showAttestation ? <th scope="col">Attestation type</th> : null}
          </tr>
        </thead>
        <tbody>
          {references.map((reference) => (
            <tr key={reference.id}>
              <th scope="row" className="cell-format">
                {reference.formatIdentifier}
              </th>
              <td>
                <ExternalReference uri={reference.uri} />
              </td>
              <td>
                {reference.integrity === null ? (
                  <span className="muted">None recorded</span>
                ) : (
                  <code title={reference.integrity}>{reference.integrity}</code>
                )}
              </td>
              {showAttestation ? (
                <td>{attestationNameFor(attestations, reference.attestationId)}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function MetadataSection({ snapshot }: { readonly snapshot: RulebookDetailSnapshot }) {
  const { rulebook, provider, attestations, schemaReferences, versions, availability } = snapshot
  return (
    <section className="detail-card" aria-labelledby="metadata-heading">
      <h2 id="metadata-heading">Rulebook metadata</h2>
      <dl className="metadata-grid">
        <div>
          <dt>Rulebook ID</dt>
          <dd>
            <code>{rulebook.id}</code>
          </dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>
            {provider === null ? (
              <span className="muted">{rulebook.providerId} (not in the provider list)</span>
            ) : (
              <>
                {provider.name} <span className="muted">({provider.id})</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Publication status</dt>
          <dd>
            <StatusBadge status={rulebook.publicationStatus} />
          </dd>
        </div>
        <div>
          <dt>Applicable specification</dt>
          <dd>
            <code>{rulebook.applicableSpec}</code>
          </dd>
        </div>
        <div>
          <dt>Attestation types</dt>
          <dd>{availability.attestations ? attestations.length : 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Schema references</dt>
          <dd>{availability.schemaReferences ? schemaReferences.length : 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Versions</dt>
          <dd>{availability.versions ? versions.length : 'Unavailable'}</dd>
        </div>
      </dl>
      {availability.provider ? null : (
        <p className="notice">
          The provider list could not be loaded, so only the provider identifier is shown.
        </p>
      )}
    </section>
  )
}

export function ProvenanceSection({ snapshot }: { readonly snapshot: RulebookDetailSnapshot }) {
  const { rulebook } = snapshot
  const source = describeSourceFor(rulebook)
  return (
    <section className="detail-card" aria-labelledby="provenance-heading">
      <h2 id="provenance-heading">Source provenance</h2>
      <dl className="metadata-grid">
        <div>
          <dt>Source</dt>
          <dd>
            {source.href === null ? (
              source.label
            ) : (
              <a href={source.href} target="_blank" rel="noopener noreferrer">
                {source.href}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </dd>
        </div>
        <div>
          <dt>Registered</dt>
          <dd>
            <time dateTime={rulebook.createdAt}>{formatDate(rulebook.createdAt)}</time>
          </dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>
            <time dateTime={rulebook.updatedAt}>{formatDate(rulebook.updatedAt)}</time>
          </dd>
        </div>
        <div>
          <dt>Publication authority</dt>
          <dd>Owned by the provider recorded above.</dd>
        </div>
      </dl>
      <p className="table-note">
        This is the public provenance projection: source URL and registry timestamps.
        Import-internal provenance is not exposed by the public API.
      </p>
    </section>
  )
}

function describeSourceFor(rulebook: Rulebook) {
  // Reuse the catalog's URL-safety rule without importing its display label.
  const value = rulebook.sourceUrl
  if (value === null || value === '') {
    return { href: null as string | null, label: 'Locally authored' }
  }
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return { href: url.toString(), label: url.toString() }
    }
  } catch {
    // Fall through to inert text.
  }
  return { href: null as string | null, label: value }
}

export function AttestationsSection({ snapshot }: { readonly snapshot: RulebookDetailSnapshot }) {
  const { attestations, schemaReferences, availability } = snapshot
  return (
    <section className="detail-card" aria-labelledby="attestations-heading">
      <h2 id="attestations-heading">Attestation types</h2>
      {availability.attestations ? null : (
        <SectionUnavailable>
          The attestation types could not be loaded, so none are shown.
        </SectionUnavailable>
      )}
      {availability.attestations && attestations.length === 0 ? (
        <p className="muted">No attestation types are recorded for this rulebook.</p>
      ) : null}
      {attestations.length > 0 ? (
        <ul className="attestation-list">
          {attestations.map((attestation) => {
            const references = availability.schemaReferences
              ? referencesForAttestation(schemaReferences, attestation.id)
              : attestation.schemaReferences
            return (
              <li className="attestation-card" key={attestation.id}>
                <h3>{attestation.name}</h3>
                <dl className="inline-metadata">
                  <div>
                    <dt>Level of assurance</dt>
                    <dd>{attestation.attestationLoS}</dd>
                  </div>
                  <div>
                    <dt>Binding type</dt>
                    <dd>{attestation.bindingType}</dd>
                  </div>
                  <div>
                    <dt>Supported formats</dt>
                    <dd>
                      {attestation.supportedFormats.length === 0 ? (
                        <span className="muted">None recorded</span>
                      ) : (
                        <ul className="tag-list">
                          {attestation.supportedFormats.map((format) => (
                            <li key={format}>
                              <span className="tag">{format}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </dd>
                  </div>
                </dl>
                <h4>Schema references</h4>
                {references.length === 0 ? (
                  <p className="muted">
                    No schema references are recorded for this attestation type.
                  </p>
                ) : (
                  <SchemaReferenceTable
                    references={references}
                    attestations={attestations}
                    showAttestation={false}
                  />
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}

export function SchemaReferencesSection({
  snapshot,
}: {
  readonly snapshot: RulebookDetailSnapshot
}) {
  const { schemaReferences, attestations, availability } = snapshot
  return (
    <section className="detail-card" aria-labelledby="schema-references-heading">
      <h2 id="schema-references-heading">Schema references</h2>
      {availability.schemaReferences ? null : (
        <SectionUnavailable>
          The schema references could not be loaded, so none are shown.
        </SectionUnavailable>
      )}
      {availability.schemaReferences && schemaReferences.length === 0 ? (
        <p className="muted">No schema references are recorded for this rulebook.</p>
      ) : null}
      {schemaReferences.length > 0 ? (
        <SchemaReferenceTable references={schemaReferences} attestations={attestations} />
      ) : null}
      <p className="table-note">
        A reference URI is linked only when it is an absolute http(s) URL; other values stay inert
        text.
      </p>
    </section>
  )
}

export function CompatibilitySection() {
  return (
    <section className="detail-card" aria-labelledby="compatibility-heading">
      <h2 id="compatibility-heading">Standards compatibility</h2>
      <p className="compatibility-summary">
        <CompatibilityBadge /> <strong>Rulebook-level compatibility: not tested.</strong>
      </p>
      <p>{RULEBOOK_COMPATIBILITY_DISCLOSURE}</p>
      <div className="table-wrap table-wrap--nested">
        <table className="detail-table">
          <caption className="sr-only">
            Evaluation dimensions and whether this build supports them for a credential
          </caption>
          <thead>
            <tr>
              <th scope="col">Evaluation dimension</th>
              <th scope="col">Support in this build</th>
            </tr>
          </thead>
          <tbody>
            {EVALUATION_SUPPORT.map((dimension) => (
              <tr key={dimension.id}>
                <th scope="row">{dimension.title}</th>
                <td>
                  <span className={`support support--${dimension.support}`}>
                    {EVALUATION_SUPPORT_LABELS[dimension.support]}
                  </span>
                  <span className="support-detail"> {dimension.detail}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="table-note">
        Not tested means the check did not run; not applicable means the dimension cannot be
        evaluated for a standalone credential. Neither status is a pass.
      </p>
    </section>
  )
}

export function VersionsSection({ snapshot }: { readonly snapshot: RulebookDetailSnapshot }) {
  const { rulebook, versions, availability } = snapshot
  const current = latestVersion(versions)
  const ordered = versionsNewestFirst(versions)
  return (
    <section className="detail-card" aria-labelledby="versions-heading">
      <h2 id="versions-heading">Version history</h2>
      {availability.versions ? null : (
        <SectionUnavailable>
          The version history could not be loaded, so no versions are shown.
        </SectionUnavailable>
      )}
      {availability.versions && versions.length === 0 ? (
        <p className="muted">No versions have been recorded for this rulebook.</p>
      ) : null}
      {versions.length > 0 ? (
        <>
          <div className="table-wrap table-wrap--nested">
            <table className="detail-table version-table">
              <caption className="sr-only">Rulebook version history, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Status</th>
                  <th scope="col">Specification</th>
                  <th scope="col">Content digest (SHA-256)</th>
                  <th scope="col">Created</th>
                  <th scope="col">Published</th>
                  <th scope="col">Export</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((version) => (
                  <tr key={version.id}>
                    <th scope="row">
                      <code>{version.version}</code>
                      {current?.id === version.id ? (
                        <span className="badge badge--latest">Latest</span>
                      ) : null}
                    </th>
                    <td>
                      <StatusBadge status={version.status} />
                    </td>
                    <td>
                      <code>{version.specVersion}</code>
                    </td>
                    <td>
                      <code className="digest" title={version.contentDigest}>
                        {formatDigest(version.contentDigest)}
                      </code>
                    </td>
                    <td>
                      <time dateTime={version.createdAt}>{formatDate(version.createdAt)}</time>
                    </td>
                    <td>
                      {version.publishedAt === null ? (
                        <span className="muted">Not published</span>
                      ) : (
                        <time dateTime={version.publishedAt}>
                          {formatDate(version.publishedAt)}
                        </time>
                      )}
                    </td>
                    <td>
                      <a
                        className="button button--small button--ghost"
                        href={versionContentPath(rulebook.id, version.version)}
                        download={`rulebook-${rulebook.id}-${version.version}.json`}
                        aria-label={`Export version ${version.version} snapshot`}
                      >
                        Export
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="table-note">
            Exports are the exact immutable snapshot bytes. The shown SHA-256 digest identifies
            them, and the download response carries <code>Content-Digest</code> and{' '}
            <code>ETag</code> headers for verification.
          </p>
        </>
      ) : null}
    </section>
  )
}

export function VersionSummary({ snapshot }: { readonly snapshot: RulebookDetailSnapshot }) {
  const current = latestVersion(snapshot.versions)
  if (current === null) {
    return null
  }
  return (
    <a
      className="button button--primary"
      href={versionContentPath(snapshot.rulebook.id, current.version)}
      download={`rulebook-${snapshot.rulebook.id}-${current.version}.json`}
    >
      Export version {current.version}
    </a>
  )
}
