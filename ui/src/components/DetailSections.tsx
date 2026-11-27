import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'

import { versionContentPath, type CatalogApi } from '../api'
import { formatDate } from '../catalog'
import { RULEBOOK_COMPATIBILITY_DISCLOSURE } from '../compatibility'
import type { RulebookDetailSnapshot } from '../detail'
import {
  attestationNameFor,
  describeReference,
  formatDigest,
  hostedIntegrityState,
  hostedSchemaDownloadName,
  latestVersion,
  referencesForAttestation,
  rulebookLevelReferences,
  versionsNewestFirst,
  type ReferenceWithHostedSchema,
} from '../detail'
import { AppLink, PLAYGROUND_PATH } from '../router'
import type { HostedSchema, SchemaReference, VersionSchemaReferences } from '../types'

import { Alert } from './Alert'
import { CompatibilityBadge, StatusBadge } from './Badges'
import { GuideLink } from './GuideLink'

function SectionUnavailable({ children }: { readonly children: string }) {
  return (
    <Alert variant="warning" role="status">
      <p>{children}</p>
    </Alert>
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

/**
 * One row of a schema-reference table. A rulebook working-copy reference has a
 * registry id and an attestation id; a frozen version reference has neither,
 * because the snapshot carries only the standard members.
 */
export interface SchemaReferenceRow extends ReferenceWithHostedSchema {
  readonly key: string
  readonly formatIdentifier: string
  readonly uri: string
  readonly attestationId?: string | null
}

/** The stored document kind in the product's exact terminology. */
function hostedSchemaKindLabel(kind: HostedSchema['kind']): string {
  return kind === 'json_schema_2020_12' ? 'JSON Schema 2020-12' : 'SD-JWT VC Type Metadata'
}

function ReferenceSource({ reference }: { readonly reference: ReferenceWithHostedSchema }) {
  const hosted = reference.hostedSchema
  if (hosted == null) {
    return <span className="reference-source reference-source--external">External URL</span>
  }
  return (
    <span className="reference-source reference-source--hosted">
      <span className="reference-source__label">Hosted by AttestBook</span>
      <span className="reference-source__kind">{hostedSchemaKindLabel(hosted.kind)}</span>
    </span>
  )
}

function ReferenceUri({
  reference,
}: {
  readonly reference: { readonly uri: string; readonly hostedSchema?: HostedSchema | null }
}) {
  const hosted = reference.hostedSchema
  if (hosted == null) {
    return <ExternalReference uri={reference.uri} />
  }
  return (
    <a
      className="reference-uri"
      href={hosted.url}
      target="_blank"
      rel="noopener noreferrer"
      title={hosted.url}
    >
      {reference.uri}
      <span className="sr-only"> (opens the hosted schema in a new tab)</span>
    </a>
  )
}

function ReferenceIntegrity({ reference }: { readonly reference: ReferenceWithHostedSchema }) {
  const state = hostedIntegrityState(reference)
  return (
    <>
      {reference.integrity === null ? (
        <span className="muted">None recorded</span>
      ) : (
        <span className="data" title={reference.integrity}>
          {reference.integrity}
        </span>
      )}
      {state === 'matches' ? (
        <span className="reference-pin reference-pin--ok">Pin matches stored digest</span>
      ) : null}
      {state === 'missing' ? (
        <span className="reference-pin reference-pin--missing">No pin recorded</span>
      ) : null}
      {state === 'mismatch' ? (
        <span className="reference-pin reference-pin--mismatch">
          Pin does not match stored digest
        </span>
      ) : null}
    </>
  )
}

function SchemaReferenceTable({
  rows,
  attestations,
  showAttestation = true,
  caption,
}: {
  readonly rows: readonly SchemaReferenceRow[]
  readonly attestations: RulebookDetailSnapshot['attestations']
  readonly showAttestation?: boolean
  readonly caption: string
}) {
  return (
    <div className="table-wrap table-wrap--nested">
      <table className="detail-table schema-reference-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Format</th>
            <th scope="col">Schema reference</th>
            <th scope="col">Integrity pin</th>
            {showAttestation ? <th scope="col">Attestation type</th> : null}
            <th scope="col">Download</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const hosted = row.hostedSchema ?? null
            return (
              <tr key={row.key}>
                <th scope="row" className="cell-format">
                  {row.formatIdentifier}
                </th>
                <td>
                  <ReferenceSource reference={row} />
                  <ReferenceUri reference={row} />
                  {hosted === null ? null : (
                    <p className="reference-hosted-meta">
                      <span>
                        Media type: <code>{hosted.mediaType}</code>
                      </span>
                      <span>
                        SHA-256:{' '}
                        <span className="data" title={hosted.contentDigest}>
                          {formatDigest(hosted.contentDigest)}
                        </span>
                      </span>
                    </p>
                  )}
                </td>
                <td>
                  <ReferenceIntegrity reference={row} />
                </td>
                {showAttestation ? (
                  <td>{attestationNameFor(attestations, row.attestationId ?? null)}</td>
                ) : null}
                <td>
                  {hosted === null ? (
                    <span className="muted">—</span>
                  ) : (
                    <a
                      className="btn btn-outline btn-sm"
                      href={hosted.url}
                      download={hostedSchemaDownloadName(hosted)}
                      aria-label={`Download the ${hostedSchemaKindLabel(hosted.kind)} document for ${row.formatIdentifier}`}
                    >
                      Download
                    </a>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function rulebookRows(references: readonly SchemaReference[]): readonly SchemaReferenceRow[] {
  return references.map((reference) => ({
    key: reference.id,
    formatIdentifier: reference.formatIdentifier,
    uri: reference.uri,
    integrity: reference.integrity,
    hostedSchema: reference.hostedSchema ?? null,
    attestationId: reference.attestationId,
  }))
}

/**
 * The rulebook's one-line summary under the hero title: its provider,
 * specification, last update and version count, plus the source it was
 * imported from. A locally authored rulebook has no source, so none is shown.
 */
export function RulebookSummary({ snapshot }: { readonly snapshot: RulebookDetailSnapshot }) {
  const { rulebook, provider, versions } = snapshot
  const source = externalSourceUrl(rulebook.sourceUrl)
  const parts: { readonly key: string; readonly node: ReactNode }[] = [
    {
      key: 'provider',
      node:
        provider === null ? (
          <span className="data">{rulebook.providerId} (not in the provider list)</span>
        ) : (
          <span>{provider.name}</span>
        ),
    },
    { key: 'spec', node: <span className="data">{rulebook.applicableSpec}</span> },
    {
      key: 'updated',
      node: (
        <span>
          Last updated{' '}
          <time className="data" dateTime={rulebook.updatedAt}>
            {formatDate(rulebook.updatedAt)}
          </time>
        </span>
      ),
    },
  ]
  if (versions.length > 0) {
    parts.push({
      key: 'versions',
      node: <span>{versions.length === 1 ? '1 version' : `${versions.length} versions`}</span>,
    })
  }
  if (source !== null) {
    parts.push({
      key: 'source',
      node: (
        <span>
          Source{' '}
          <a href={source} target="_blank" rel="noopener noreferrer">
            {source}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </span>
      ),
    })
  }
  return (
    <p className="detail-heading__meta">
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index === 0 ? null : <span aria-hidden="true"> · </span>}
          {part.node}
        </Fragment>
      ))}
    </p>
  )
}

/** The imported-from URL when it is a safe http(s) link; anything else is not shown. */
function externalSourceUrl(value: string | null): string | null {
  if (value === null || value === '') {
    return null
  }
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * The attestation types with their schema references. Each attestation lists
 * its own references; references bound to no attestation type follow as the
 * rulebook-level group, so every reference appears exactly once on the page.
 */
export function AttestationsSection({ snapshot }: { readonly snapshot: RulebookDetailSnapshot }) {
  const { attestations, schemaReferences, availability } = snapshot
  const rulebookLevel = availability.schemaReferences
    ? rulebookLevelReferences(schemaReferences)
    : []
  return (
    <section className="content-section" aria-labelledby="attestations-heading">
      <h2 id="attestations-heading">Attestation types</h2>
      {availability.attestations ? null : (
        <SectionUnavailable>
          The attestation types could not be loaded, so none are shown.
        </SectionUnavailable>
      )}
      {availability.schemaReferences ? null : (
        <SectionUnavailable>
          The schema references could not be loaded, so only those embedded in each attestation type
          are shown.
        </SectionUnavailable>
      )}
      {availability.attestations && attestations.length === 0 ? (
        <p className="muted">No attestation types are recorded for this rulebook.</p>
      ) : null}
      {attestations.length > 0 || rulebookLevel.length > 0 ? (
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
                    rows={rulebookRows(references)}
                    attestations={attestations}
                    showAttestation={false}
                    caption={`Schema references for ${attestation.name}`}
                  />
                )}
              </li>
            )
          })}
          {rulebookLevel.length === 0 ? null : (
            <li className="attestation-card">
              <h3>Rulebook-level schema references</h3>
              <p className="table-note">These references belong to no single attestation type.</p>
              <SchemaReferenceTable
                rows={rulebookRows(rulebookLevel)}
                attestations={attestations}
                showAttestation={false}
                caption="Rulebook-level schema references"
              />
            </li>
          )}
        </ul>
      ) : null}
    </section>
  )
}

/**
 * UI-002 standards compatibility. No rulebook-level result exists yet, so the
 * section states that and points to where credentials are actually checked;
 * the per-dimension capability table lives on the playground.
 */
export function CompatibilitySection({
  onNavigate,
}: {
  readonly onNavigate: (path: string) => void
}) {
  return (
    <section className="content-section" aria-labelledby="compatibility-heading">
      <h2 id="compatibility-heading">Standards compatibility</h2>
      <p className="compatibility-summary">
        <CompatibilityBadge /> <strong>Rulebook-level compatibility: not tested.</strong>
      </p>
      <p className="table-note">
        {RULEBOOK_COMPATIBILITY_DISCLOSURE} Validate a credential in the{' '}
        <AppLink href={PLAYGROUND_PATH} onNavigate={onNavigate}>
          Validation playground
        </AppLink>
        ; the <GuideLink slug="credential-validation">credential validation guide</GuideLink>{' '}
        explains what each run checks.
      </p>
    </section>
  )
}

type VersionReferencesState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: VersionSchemaReferences }
  | { readonly status: 'error'; readonly message: string }

function versionRows(
  references: VersionSchemaReferences['schemaReferences'],
): readonly SchemaReferenceRow[] {
  return references.map((reference, index) => ({
    key: `${String(index)}-${reference.formatIdentifier}-${reference.uri}`,
    formatIdentifier: reference.formatIdentifier,
    uri: reference.uri,
    integrity: reference.integrity,
    hostedSchema: reference.hostedSchema ?? null,
  }))
}

/** Reads one exact frozen version and renders its references with provenance. */
function VersionSchemaReferencesPanel({
  api,
  rulebookId,
  version,
}: {
  readonly api: CatalogApi
  readonly rulebookId: string
  readonly version: string
}) {
  const [state, setState] = useState<VersionReferencesState>({ status: 'loading' })
  const controller = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setState({ status: 'loading' })
    try {
      const data = await api.getVersionSchemaReferences(rulebookId, version, current.signal)
      if (!current.signal.aborted) {
        setState({ status: 'ready', data })
      }
    } catch (error) {
      if (current.signal.aborted) {
        return
      }
      setState({
        status: 'error',
        message:
          error instanceof Error && error.message !== ''
            ? error.message
            : 'The version schema references could not be loaded.',
      })
    }
  }, [api, rulebookId, version])

  useEffect(() => {
    void load()
    return () => controller.current?.abort()
  }, [load])

  if (state.status === 'loading') {
    return (
      <p className="version-references__status" role="status">
        Reading the schema references frozen in version {version}…
      </p>
    )
  }
  if (state.status === 'error') {
    return (
      <Alert
        variant="destructive"
        role="alert"
        action={
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => {
              void load()
            }}
          >
            Retry
          </button>
        }
      >
        <p>{state.message}</p>
      </Alert>
    )
  }

  const { data } = state
  const referenceCount =
    data.schemaReferences.length +
    data.attestations.reduce((total, attestation) => total + attestation.schemaReferences.length, 0)
  return (
    <div className="version-references">
      <h3 className="version-references__title">Schema references in version {data.version}</h3>
      <p className="version-references__pin">
        Exact frozen version <span className="data">{data.version}</span> · SHA-256{' '}
        <span className="data" title={data.contentDigest}>
          {formatDigest(data.contentDigest)}
        </span>
      </p>
      {referenceCount === 0 ? (
        <p className="muted">No schema references are recorded in this version.</p>
      ) : null}
      {data.attestations.map((attestation) =>
        attestation.schemaReferences.length === 0 ? null : (
          <div className="version-references__group" key={attestation.name}>
            <h4>{attestation.name}</h4>
            <SchemaReferenceTable
              rows={versionRows(attestation.schemaReferences)}
              attestations={[]}
              showAttestation={false}
              caption={`Schema references for ${attestation.name} in version ${data.version}`}
            />
          </div>
        ),
      )}
      {data.schemaReferences.length === 0 ? null : (
        <div className="version-references__group">
          <h4>Rulebook-level</h4>
          <SchemaReferenceTable
            rows={versionRows(data.schemaReferences)}
            attestations={[]}
            showAttestation={false}
            caption={`Rulebook-level schema references in version ${data.version}`}
          />
        </div>
      )}
    </div>
  )
}

export function VersionsSection({
  snapshot,
  api,
}: {
  readonly snapshot: RulebookDetailSnapshot
  readonly api: CatalogApi
}) {
  const { rulebook, versions, availability } = snapshot
  const current = latestVersion(versions)
  const ordered = versionsNewestFirst(versions)
  const [openVersionId, setOpenVersionId] = useState<string | null>(null)
  const panelPrefix = `version-panel-${useId().replaceAll(':', '')}`
  return (
    <section className="content-section" aria-labelledby="versions-heading">
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
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((version) => {
                  const open = openVersionId === version.id
                  const panelId = `${panelPrefix}-${version.id}`
                  return (
                    <Fragment key={version.id}>
                      <tr>
                        <th scope="row">
                          <span className="data">{version.version}</span>
                          {current?.id === version.id ? (
                            <span className="badge badge--latest">Latest</span>
                          ) : null}
                        </th>
                        <td>
                          <StatusBadge status={version.status} />
                        </td>
                        <td>
                          <span className="data">{version.specVersion}</span>
                        </td>
                        <td>
                          <span className="data" title={version.contentDigest}>
                            {formatDigest(version.contentDigest)}
                          </span>
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
                          <div className="version-actions">
                            <button
                              type="button"
                              className="btn btn-outline btn-sm"
                              aria-expanded={open}
                              aria-controls={panelId}
                              aria-label={`${open ? 'Hide' : 'Inspect'} references for version ${version.version}`}
                              onClick={() => {
                                setOpenVersionId(open ? null : version.id)
                              }}
                            >
                              {open ? 'Hide references' : 'Inspect references'}
                            </button>
                            <a
                              className="btn btn-outline btn-sm"
                              href={versionContentPath(rulebook.id, version.version)}
                              download={`rulebook-${rulebook.id}-${version.version}.json`}
                              aria-label={`Export version ${version.version} snapshot`}
                            >
                              Export
                            </a>
                          </div>
                        </td>
                      </tr>
                      {open ? (
                        <tr className="version-references-row">
                          <td colSpan={7}>
                            <div id={panelId}>
                              <VersionSchemaReferencesPanel
                                api={api}
                                rulebookId={rulebook.id}
                                version={version.version}
                              />
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="table-note">
            Exports are the exact immutable snapshot bytes. The shown SHA-256 digest identifies
            them, and the download response carries <code>Content-Digest</code> and{' '}
            <code>ETag</code> headers for verification. <strong>Inspect references</strong> reads
            the same frozen snapshot and distinguishes hosted from external schema references.
          </p>
        </>
      ) : null}
    </section>
  )
}
