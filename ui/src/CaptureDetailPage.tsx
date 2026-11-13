import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { CaptureExplorerApi, CatalogApi } from './api'
import { CatalogApiError, isAbortError, isSessionAuthError } from './api'
import { formatDate } from './catalog'
import {
  CAPTURE_ARTIFACT_TYPE_LABELS,
  CAPTURE_EVIDENCE_GAP_LABELS,
  CAPTURE_INTERACTION_LABELS,
  CAPTURE_REDACTION_LABELS,
  CAPTURE_SOURCE_COMPONENT_LABELS,
  captureProjectionText,
  captureValidationEligibility,
} from './capture'
import { ErrorState, LoadingState } from './components/CatalogStates'
import { SiteFooter, SiteHeader, SkipLink } from './components/Layout'
import { SessionRenewalForm, SignInRequiredNotice } from './components/SessionPrompt'
import { ValidationReport } from './components/ValidationReport'
import { describeReference, formatDigest } from './detail'
import { formatValidatedAt, validationResultDocument, validationResultFilename } from './playground'
import { AppLink, CAPTURES_PATH, rulebookPath } from './router'
import type { SessionController } from './session'
import type {
  Attestation,
  CaptureExplorerDetail,
  CaptureTimelineEvent,
  CredentialValidationResult,
  Rulebook,
  RulebookVersion,
} from './types'

interface CaptureDetailPageProps {
  readonly api: CaptureExplorerApi
  readonly catalogApi: CatalogApi
  readonly captureId: string
  /** Administrator session state; correlation writes use its CSRF token. */
  readonly session: SessionController
  readonly onNavigate: (path: string) => void
}

type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly detail: CaptureExplorerDetail }
  | { readonly status: 'not-found' }
  | { readonly status: 'error'; readonly message: string }

type CatalogState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly rulebooks: readonly Rulebook[] }
  | { readonly status: 'error'; readonly message: string }

type RelatedState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready'
      readonly versions: readonly RulebookVersion[]
      readonly attestations: readonly Attestation[]
    }
  | { readonly status: 'error'; readonly message: string }

type RunState =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'success' }
  | { readonly status: 'error'; readonly message: string }

interface CorrelationForm {
  readonly rulebookId: string
  readonly rulebookVersion: string
  readonly attestationType: string
}

const EMPTY_FORM: CorrelationForm = { rulebookId: '', rulebookVersion: '', attestationType: '' }

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof CatalogApiError || error instanceof Error) {
    return error.message === '' ? fallback : error.message
  }
  return fallback
}

function downloadJson(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const link = document.createElement('a')
  link.download = filename
  if (typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(blob)
    link.href = url
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    return
  }
  link.href = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`
  link.click()
}

function SafeReference({ uri }: { readonly uri: string }) {
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

function MetadataRow({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function EvidenceSummary({ detail }: { readonly detail: CaptureExplorerDetail }) {
  const party = detail.party
  return (
    <section className="detail-card" aria-labelledby="capture-evidence-heading">
      <h2 id="capture-evidence-heading">Normalized evidence</h2>
      <p className="table-note">
        Metadata is separated from the artifact. An inline artifact is shown only as its redacted
        projection; the segregated raw artifact is never sent to the browser.
      </p>
      <dl className="metadata-grid">
        <MetadataRow label="Capture source">
          {CAPTURE_SOURCE_COMPONENT_LABELS[detail.source.component]} ·{' '}
          <code>{detail.source.sourceId}</code>
        </MetadataRow>
        <MetadataRow label="Source version">
          {detail.provenance.sourceVersion ?? 'Not declared'}
        </MetadataRow>
        <MetadataRow label="Transport">
          <span className="badge badge--mock">Mock</span>
        </MetadataRow>
        <MetadataRow label="Interaction">
          {CAPTURE_INTERACTION_LABELS[detail.interactionType]} · {detail.protocol}
        </MetadataRow>
        <MetadataRow label="Artifact type">
          {CAPTURE_ARTIFACT_TYPE_LABELS[detail.artifactType]}
        </MetadataRow>
        <MetadataRow label="Credential format">{detail.credentialFormat}</MetadataRow>
        <MetadataRow label="Party">
          {party === null ? (
            'Not declared'
          ) : (
            <>
              {party.name ?? party.role} (<code>{party.identifier}</code>)
            </>
          )}
        </MetadataRow>
        <MetadataRow label="Correlation id">
          <code>{detail.correlationId}</code>
        </MetadataRow>
        <MetadataRow label="Test execution reference">
          {detail.testExecutionRef ?? 'Not declared'}
        </MetadataRow>
        <MetadataRow label="Captured at">{formatDate(detail.provenance.capturedAt)}</MetadataRow>
        <MetadataRow label="Received at">{formatDate(detail.provenance.receivedAt)}</MetadataRow>
        <MetadataRow label="Declared redaction">
          {CAPTURE_REDACTION_LABELS[detail.declaredRedaction.status]}
          {detail.declaredRedaction.policyRef === null ? null : (
            <>
              {' '}
              · <code>{detail.declaredRedaction.policyRef}</code>
            </>
          )}
        </MetadataRow>
        <MetadataRow label="Artifact integrity">
          <code>{formatDigest(detail.integrity.digest)}</code>{' '}
          {detail.integrity.verified ? '(verified)' : '(declared, not verified)'}
        </MetadataRow>
      </dl>
      {detail.declaredRedaction.redactedPaths.length === 0 ? null : (
        <p className="table-note">
          Source-redacted paths:{' '}
          {detail.declaredRedaction.redactedPaths.map((path) => (
            <code key={path}>{path} </code>
          ))}
        </p>
      )}
      {Object.keys(detail.metadata).length === 0 ? null : (
        <details className="evidence-details">
          <summary>Source metadata</summary>
          <dl className="evidence-grid">
            {Object.entries(detail.metadata).map(([key, value]) => (
              <div key={key}>
                <dt>
                  <code>{key}</code>
                </dt>
                <dd>{value === null ? 'null' : String(value)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </section>
  )
}

function ArtifactEvidence({ detail }: { readonly detail: CaptureExplorerDetail }) {
  const projection = detail.artifactProjection
  return (
    <section className="detail-card" aria-labelledby="capture-artifact-heading">
      <h2 id="capture-artifact-heading">Artifact evidence</h2>
      {detail.artifact.availability === 'external' ? (
        <div className="notice notice--warning">
          <p className="notice-title">External artifact not fetched</p>
          <p>
            The artifact is stored behind an external reference. AttestBook has not fetched it, so
            its content, media type body and recomputed digest are unavailable; the declared digest
            is not verified.
          </p>
          {detail.artifact.uri === null ? null : (
            <p>
              Reference: <SafeReference uri={detail.artifact.uri} /> ({detail.artifact.mediaType})
            </p>
          )}
        </div>
      ) : projection === null ? (
        <p className="table-note">No artifact projection is available for this capture.</p>
      ) : (
        <>
          <dl className="metadata-grid">
            <MetadataRow label="Availability">Inline, segregated</MetadataRow>
            <MetadataRow label="Media type">{projection.mediaType}</MetadataRow>
            <MetadataRow label="Redacted size">{projection.byteLength} bytes</MetadataRow>
            <MetadataRow label="Display redaction">
              {CAPTURE_REDACTION_LABELS[projection.redaction.status]}
              {projection.redaction.policyRef === null ? null : (
                <>
                  {' '}
                  · <code>{projection.redaction.policyRef}</code>
                </>
              )}
            </MetadataRow>
            <MetadataRow label="Redacted digest">
              <code>{formatDigest(projection.digest)}</code>
            </MetadataRow>
          </dl>
          {projection.redaction.redactedPaths.length === 0 ? null : (
            <p className="table-note">
              Redacted paths recorded for this projection:{' '}
              {projection.redaction.redactedPaths.map((path) => (
                <code key={path}>{path} </code>
              ))}
            </p>
          )}
          {projection.diagnostics.length === 0 ? null : (
            <ul className="limitation-list">
              {projection.diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.code}-${String(index)}`}>
                  <code>{diagnostic.code}</code> {diagnostic.message}
                </li>
              ))}
            </ul>
          )}
          {projection.document === null ? (
            <p className="notice">
              This artifact is opaque (not JSON) or could not be parsed, so only full redaction is
              available and the original structure is not preserved.
            </p>
          ) : (
            <pre className="capture-projection" aria-label="Redacted artifact projection">
              {captureProjectionText(projection.document)}
            </pre>
          )}
        </>
      )}
    </section>
  )
}

function Timeline({ events }: { readonly events: readonly CaptureTimelineEvent[] }) {
  return (
    <section className="detail-card" aria-labelledby="capture-timeline-heading">
      <h2 id="capture-timeline-heading">Evidence timeline</h2>
      <p className="table-note">
        Events are ordered by their own timestamps. The capture timestamp is asserted by the source;
        the receipt, binding and validation timestamps are AttestBook records.
      </p>
      <ol className="capture-timeline">
        {events.map((event, index) => (
          <li key={`${event.kind}-${event.at}-${String(index)}`}>
            <span className="badge badge--untested">{event.kind}</span>
            <p className="capture-timeline__label">{event.label}</p>
            <p className="version-meta">{formatDate(event.at)}</p>
            <p className="capture-timeline__detail">{event.detail}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

function EvidenceGaps({ detail }: { readonly detail: CaptureExplorerDetail }) {
  return (
    <section className="detail-card" aria-labelledby="capture-gaps-heading">
      <h2 id="capture-gaps-heading">Missing and unavailable evidence</h2>
      {detail.evidenceGaps.length === 0 ? (
        <p className="table-note">
          Every correlated evidence field is present for this capture: the artifact is inline and
          not source-redacted, a test execution reference exists, and a validation result is linked
          to a pinned rulebook version.
        </p>
      ) : (
        <>
          <p className="table-note">
            These gaps are explicit requirements, not failures. An absent field is never treated as
            a pass.
          </p>
          <ul className="capture-gap-detail-list">
            {detail.evidenceGaps.map((gap) => (
              <li key={gap.code}>
                <span className="badge badge--warning">
                  {CAPTURE_EVIDENCE_GAP_LABELS[gap.code]}
                </span>
                <p>{gap.message}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

interface CorrelationPanelProps {
  readonly detail: CaptureExplorerDetail
  readonly catalog: CatalogState
  readonly related: RelatedState
  readonly values: CorrelationForm
  readonly session: SessionController
  readonly sessionExpired: boolean
  readonly onSessionRenewed: () => void
  readonly formError: string | null
  readonly run: RunState
  readonly onChange: (patch: Partial<CorrelationForm>) => void
  readonly onSubmit: () => void
  readonly onRetryCatalog: () => void
  readonly onRetryRelated: () => void
  readonly onNavigate: (path: string) => void
}

function CorrelationPanel({
  detail,
  catalog,
  related,
  values,
  session,
  sessionExpired,
  onSessionRenewed,
  formError,
  run,
  onChange,
  onSubmit,
  onRetryCatalog,
  onRetryRelated,
  onNavigate,
}: CorrelationPanelProps) {
  const eligibility = captureValidationEligibility(detail)
  const running = run.status === 'running'
  const authenticated = session.status === 'authenticated'
  const selectedRulebook =
    catalog.status === 'ready'
      ? (catalog.rulebooks.find((rulebook) => rulebook.id === values.rulebookId) ?? null)
      : null

  return (
    <section className="detail-card" aria-labelledby="capture-correlation-heading">
      <h2 id="capture-correlation-heading">Pinned rulebook correlation</h2>
      {detail.rulebook === null ? (
        <p className="table-note">
          This capture is not bound to a rulebook version yet, so no validation findings are linked.
        </p>
      ) : (
        <dl className="metadata-grid">
          <MetadataRow label="Rulebook">
            <AppLink href={rulebookPath(detail.rulebook.rulebookId)} onNavigate={onNavigate}>
              {detail.rulebook.rulebookName}
            </AppLink>{' '}
            (<code>{detail.rulebook.rulebookId}</code>)
          </MetadataRow>
          <MetadataRow label="Pinned version">
            {detail.rulebook.version} · {detail.rulebook.rulebookStatus}
          </MetadataRow>
          <MetadataRow label="Snapshot digest">
            <code>{formatDigest(detail.rulebook.contentDigest)}</code> (verified on validation)
          </MetadataRow>
          <MetadataRow label="Specification">{detail.rulebook.specVersion}</MetadataRow>
          <MetadataRow label="Attestation type">{detail.rulebook.attestationType}</MetadataRow>
          <MetadataRow label="Correlated at">
            {formatValidatedAt(detail.rulebook.boundAt)}
          </MetadataRow>
        </dl>
      )}

      {!eligibility.allowed ? (
        <div className="notice notice--warning">
          <p className="notice-title">Credential validation is not available for this evidence</p>
          <p>{eligibility.reason}</p>
        </div>
      ) : (
        <>
          <h3>
            {detail.rulebook === null
              ? 'Validate against a pinned rulebook version'
              : 'Run another correlation'}
          </h3>
          <p className="table-note">
            The structural engine inspects the capture&rsquo;s segregated inline artifact and
            records the exact rulebook version and digest. It never claims cryptographic,
            issuer-trust, protocol or interoperability success.
          </p>

          {catalog.status === 'loading' ? (
            <p className="playground-run-status" role="status">
              Loading rulebooks…
            </p>
          ) : null}
          {catalog.status === 'error' ? (
            <div className="state-panel state-panel--error" role="alert">
              <p className="state-detail">{catalog.message}</p>
              <button type="button" className="button button--primary" onClick={onRetryCatalog}>
                Retry
              </button>
            </div>
          ) : null}

          {formError === null ? null : (
            <div className="state-panel state-panel--error playground-error-summary" role="alert">
              <p className="state-detail">{formError}</p>
            </div>
          )}
          {run.status === 'error' ? (
            <div className="state-panel state-panel--error playground-error-summary" role="alert">
              <p className="state-detail">{run.message}</p>
            </div>
          ) : null}
          {run.status === 'success' ? (
            <p className="notice" role="status">
              The validation result is linked to the pinned rulebook version shown above.
            </p>
          ) : null}

          <div className="playground-grid capture-validation-form">
            <div className="field">
              <label htmlFor="capture-rulebook">Rulebook</label>
              <select
                id="capture-rulebook"
                value={values.rulebookId}
                disabled={catalog.status !== 'ready' || running}
                onChange={(event) => onChange({ rulebookId: event.target.value })}
              >
                <option value="">Select a rulebook…</option>
                {catalog.status === 'ready'
                  ? catalog.rulebooks.map((rulebook) => (
                      <option value={rulebook.id} key={rulebook.id}>
                        {rulebook.name}
                      </option>
                    ))
                  : null}
              </select>
              {selectedRulebook === null ? null : (
                <p className="field-hint">{selectedRulebook.publicationStatus}</p>
              )}
            </div>

            <div className="field">
              <label htmlFor="capture-version">Rulebook version</label>
              <select
                id="capture-version"
                value={values.rulebookVersion}
                disabled={related.status !== 'ready' || running}
                onChange={(event) => onChange({ rulebookVersion: event.target.value })}
              >
                <option value="">Select a version…</option>
                {related.status === 'ready'
                  ? related.versions.map((version) => (
                      <option value={version.version} key={version.id}>
                        {version.version} ({version.status})
                      </option>
                    ))
                  : null}
              </select>
            </div>

            <div className="field">
              <label htmlFor="capture-attestation">Attestation type</label>
              <select
                id="capture-attestation"
                value={values.attestationType}
                disabled={related.status !== 'ready' || running}
                onChange={(event) => onChange({ attestationType: event.target.value })}
              >
                <option value="">Select an attestation type…</option>
                {related.status === 'ready'
                  ? related.attestations.map((attestation) => (
                      <option value={attestation.name} key={attestation.id}>
                        {attestation.name}
                      </option>
                    ))
                  : null}
              </select>
            </div>

            {authenticated ? null : (
              <SignInRequiredNotice
                variant="inline"
                title="Sign in to record a validation"
                message="Recording a correlation against a pinned rulebook version needs the configured administrator session. The capture explorer stays public."
                onNavigate={onNavigate}
              />
            )}

            <div className="field capture-validation-submit">
              <button
                type="button"
                className="button button--primary"
                onClick={onSubmit}
                disabled={
                  !authenticated ||
                  running ||
                  related.status !== 'ready' ||
                  values.rulebookId === '' ||
                  values.rulebookVersion === '' ||
                  values.attestationType === ''
                }
              >
                {running ? 'Running validation…' : 'Run validation'}
              </button>
              {related.status === 'loading' ? (
                <p className="field-hint" role="status">
                  Loading versions and attestation types…
                </p>
              ) : null}
              {related.status === 'error' ? (
                <div role="alert">
                  <p className="field-error">{related.message}</p>
                  <button type="button" className="button button--ghost" onClick={onRetryRelated}>
                    Retry related reads
                  </button>
                </div>
              ) : null}
            </div>

            {sessionExpired ? (
              <SessionRenewalForm
                session={session}
                onRenewed={onSessionRenewed}
                title="Sign in again to record the validation"
              />
            ) : null}
          </div>
        </>
      )}
    </section>
  )
}

function LinkedValidationReport({ result }: { readonly result: CredentialValidationResult }) {
  return (
    <div className="capture-validation-report">
      <ValidationReport
        result={result}
        onExport={() =>
          downloadJson(validationResultDocument(result), validationResultFilename(result))
        }
      />
    </div>
  )
}

export function CaptureDetailPage({
  api,
  catalogApi,
  captureId,
  session,
  onNavigate,
}: CaptureDetailPageProps) {
  const [state, setState] = useState<DetailState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' })
  const [catalogReloadToken, setCatalogReloadToken] = useState(0)
  const [related, setRelated] = useState<RelatedState>({ status: 'idle' })
  const [relatedReloadToken, setRelatedReloadToken] = useState(0)
  const [values, setValues] = useState<CorrelationForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const runController = useRef<AbortController | null>(null)

  const applyDetail = useCallback((detail: CaptureExplorerDetail) => {
    setState({ status: 'ready', detail })
    document.title = `${detail.captureId} · Capture explorer · AttestBook`
  }, [])

  useEffect(() => {
    if (state.status === 'not-found') {
      document.title = 'Capture not found · AttestBook'
    }
  }, [state.status])

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    api
      .getCapture(captureId, controller.signal)
      .then((detail) => {
        if (!controller.signal.aborted) {
          applyDetail(detail)
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) {
          return
        }
        if (error instanceof CatalogApiError && error.status === 404) {
          setState({ status: 'not-found' })
          return
        }
        setState({
          status: 'error',
          message: errorMessage(error, 'The capture request failed.'),
        })
      })
    return () => controller.abort()
  }, [api, captureId, reloadToken, applyDetail])

  useEffect(() => {
    const controller = new AbortController()
    setCatalog({ status: 'loading' })
    catalogApi
      .listRulebooks(controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) {
          setCatalog({ status: 'ready', rulebooks: page.data })
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          setCatalog({
            status: 'error',
            message: errorMessage(error, 'The rulebook catalog request failed.'),
          })
        }
      })
    return () => controller.abort()
  }, [catalogApi, catalogReloadToken])

  useEffect(() => {
    if (values.rulebookId === '') {
      setRelated({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    setRelated({ status: 'loading' })
    Promise.all([
      catalogApi.listVersions(values.rulebookId, controller.signal),
      catalogApi.listAttestations(values.rulebookId, controller.signal),
    ])
      .then(([versions, attestations]) => {
        if (!controller.signal.aborted) {
          setRelated({ status: 'ready', versions, attestations })
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) {
          setRelated({
            status: 'error',
            message: errorMessage(error, 'The related rulebook request failed.'),
          })
        }
      })
    return () => controller.abort()
  }, [catalogApi, values.rulebookId, relatedReloadToken])

  useEffect(() => {
    if (related.status !== 'ready') {
      return
    }
    setValues((current) => {
      const versionExists = related.versions.some(
        (version) => version.version === current.rulebookVersion,
      )
      const attestationExists = related.attestations.some(
        (attestation) => attestation.name === current.attestationType,
      )
      if (versionExists && attestationExists) {
        return current
      }
      return {
        ...current,
        rulebookVersion: versionExists ? current.rulebookVersion : '',
        attestationType: attestationExists ? current.attestationType : '',
      }
    })
  }, [related])

  useEffect(() => {
    return () => runController.current?.abort()
  }, [])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  const retryCatalog = useCallback(() => setCatalogReloadToken((token) => token + 1), [])
  const retryRelated = useCallback(() => setRelatedReloadToken((token) => token + 1), [])

  const handleChange = useCallback((patch: Partial<CorrelationForm>) => {
    setFormError(null)
    setRun({ status: 'idle' })
    setValues((current) => {
      if ('rulebookId' in patch && patch.rulebookId !== current.rulebookId) {
        return { ...current, ...patch, rulebookVersion: '', attestationType: '' }
      }
      return { ...current, ...patch }
    })
  }, [])

  const handleSubmit = useCallback(() => {
    if (
      values.rulebookId === '' ||
      values.rulebookVersion === '' ||
      values.attestationType === ''
    ) {
      setFormError(
        'Select a rulebook, a version and an attestation type before running validation.',
      )
      return
    }
    const csrfToken =
      session.status === 'authenticated' ? (session.session?.csrfToken ?? null) : null
    if (csrfToken === null) {
      setSessionExpired(true)
      setFormError('Sign in again to record a correlation.')
      return
    }
    runController.current?.abort()
    const controller = new AbortController()
    runController.current = controller
    setFormError(null)
    setRun({ status: 'running' })
    api
      .correlateCapture(captureId, values, csrfToken, controller.signal)
      .then(() => api.getCapture(captureId, controller.signal))
      .then((detail) => {
        if (!controller.signal.aborted) {
          applyDetail(detail)
          setRun({ status: 'success' })
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) {
          return
        }
        if (isSessionAuthError(error)) {
          setSessionExpired(true)
        }
        setRun({ status: 'error', message: errorMessage(error, 'The validation request failed.') })
      })
  }, [api, captureId, values, session, applyDetail])

  const notFoundAction = useCallback(() => onNavigate(CAPTURES_PATH), [onNavigate])

  const detail = state.status === 'ready' ? state.detail : null

  return (
    <div className="app-shell">
      <SkipLink href="#capture-detail">Skip to capture evidence</SkipLink>

      <SiteHeader section="Capture detail" onNavigate={onNavigate} />

      <main className="page" id="main-content">
        <nav className="breadcrumb" aria-label="Breadcrumb">
          <ol>
            <li>
              <AppLink href={CAPTURES_PATH} onNavigate={onNavigate}>
                Capture explorer
              </AppLink>
            </li>
            <li aria-current="page">{captureId}</li>
          </ol>
        </nav>

        <div id="capture-detail" tabIndex={-1}>
          {state.status === 'loading' ? (
            <LoadingState
              title="Loading capture evidence…"
              detail="Reading the mock-backed capture explorer API."
              rowCount={4}
            />
          ) : null}

          {state.status === 'not-found' ? (
            <div className="state-panel state-panel--empty" role="alert">
              <h1 className="state-title">Capture not found</h1>
              <p className="state-detail">
                No capture matches this address. It may have been removed, or the identifier may be
                incorrect.
              </p>
              <button type="button" className="button button--primary" onClick={notFoundAction}>
                Back to the capture explorer
              </button>
            </div>
          ) : null}

          {state.status === 'error' ? (
            <ErrorState
              title="The capture could not be loaded."
              message={state.message}
              onRetry={reload}
            />
          ) : null}

          {detail === null ? null : (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">
                    {CAPTURE_INTERACTION_LABELS[detail.interactionType]} capture
                  </p>
                  <h1>{detail.captureId}</h1>
                  <p className="lede">
                    Normalized evidence from <code>{detail.source.sourceId}</code>, joined with its
                    correlation identifiers and the exact pinned rulebook version of any recorded
                    validation.
                  </p>
                </div>
              </div>

              <div className="notice notice--warning" role="note">
                <p className="notice-title">Mock-backed capture evidence</p>
                <p>
                  This capture comes from the deterministic local mock source (
                  <code>transport: mock</code>). No live <code>capture-issuer</code> or{' '}
                  <code>capture-verifier</code> interaction is shown, and none is claimed
                  operational.
                </p>
              </div>

              <EvidenceSummary detail={detail} />

              <ArtifactEvidence detail={detail} />

              {detail.validationResult === null ? null : (
                <LinkedValidationReport result={detail.validationResult} />
              )}

              <CorrelationPanel
                detail={detail}
                catalog={catalog}
                related={related}
                values={values}
                session={session}
                sessionExpired={sessionExpired}
                onSessionRenewed={() => {
                  setSessionExpired(false)
                  setRun({ status: 'idle' })
                }}
                formError={formError}
                run={run}
                onChange={handleChange}
                onSubmit={handleSubmit}
                onRetryCatalog={retryCatalog}
                onRetryRelated={retryRelated}
                onNavigate={onNavigate}
              />

              <EvidenceGaps detail={detail} />

              <Timeline events={detail.timeline} />

              <section className="detail-card" aria-labelledby="capture-limitations-heading">
                <h2 id="capture-limitations-heading">Limitations</h2>
                <ul className="limitation-list">
                  {detail.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
