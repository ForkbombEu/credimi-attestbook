// Draft lifecycle and publication panel for the rulebook editor (issue #41).
//
// The panel drives the transitions the server actually exposes:
//
//   freeze the working copy as a draft version   POST .../versions
//   refresh a draft snapshot                     POST .../versions/{v}/refresh
//   assess publication readiness                 GET  .../versions/{v}/publication-readiness
//   publish a ready draft version                POST .../versions/{v}/publish
//
// The administrator session's CSRF token comes from the parent editor; this
// panel only forwards it to the session-authenticated writes. Publish is enabled only after
// the server's readiness checks for that exact draft version report ready, so a
// stale or invalid snapshot is not published from the UI by accident. Conflicts
// (stale snapshot, duplicate label, immutable version) surface the server's
// safe message and leave every frozen artifact untouched.

import { useCallback, useEffect, useState, type FormEvent } from 'react'

import type { EditorApi } from '../api'
import { isAbortError, isSessionAuthError } from '../api'
import { formatDate } from '../catalog'
import { formatDigest, versionsNewestFirst } from '../detail'
import type {
  PublicationReadiness,
  PublicationReadinessCheckStatus,
  PublicationStatus,
  RulebookVersion,
} from '../types'

import { StatusBadge } from './Badges'
import { LoadingState } from './CatalogStates'

interface DraftLifecyclePanelProps {
  readonly api: EditorApi
  readonly rulebookId: string
  /** Live session CSRF token; `null` when the administrator is signed out. */
  readonly csrfToken: string | null
  readonly publicationStatus: PublicationStatus
  /** Reports the rulebook status a transition produced, without a reload. */
  readonly onChanged: (publicationStatus: PublicationStatus) => void
  /** Tells the editor to show its inline renewal prompt after a 401/403. */
  readonly onSessionExpired?: () => void
}

type VersionsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly versions: readonly RulebookVersion[] }
  | { readonly status: 'error'; readonly message: string }

const READINESS_STATUS_LABELS: Readonly<Record<PublicationReadinessCheckStatus, string>> = {
  pass: 'Pass',
  fail: 'Fail',
  warn: 'Warning',
  not_applicable: 'Not applicable',
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}

export function DraftLifecyclePanel({
  api,
  rulebookId,
  csrfToken,
  publicationStatus,
  onChanged,
  onSessionExpired,
}: DraftLifecyclePanelProps) {
  const [state, setState] = useState<VersionsState>({ status: 'loading' })
  const [reloadToken, setReloadToken] = useState(0)
  const [versionInput, setVersionInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [readiness, setReadiness] = useState<PublicationReadiness | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    api
      .listVersions(rulebookId, controller.signal)
      .then((versions) => {
        if (!controller.signal.aborted) {
          setState({ status: 'ready', versions })
        }
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || isAbortError(caught)) {
          return
        }
        setState({
          status: 'error',
          message: message(caught, 'The version history could not be loaded.'),
        })
      })
    return () => controller.abort()
  }, [api, reloadToken, rulebookId])

  const reloadVersions = useCallback(() => setReloadToken((value) => value + 1), [])

  /** Returns the live session CSRF token or reports the missing session. */
  const requireCsrfToken = useCallback((): string | null => {
    if (csrfToken === null) {
      setError('Sign in again to change the draft lifecycle.')
      onSessionExpired?.()
      return null
    }
    return csrfToken
  }, [csrfToken, onSessionExpired])

  const runAction = useCallback(
    async (key: string, action: () => Promise<void>) => {
      setBusy(key)
      setError(null)
      setStatusMessage(null)
      try {
        await action()
      } catch (caught) {
        if (isSessionAuthError(caught)) {
          onSessionExpired?.()
        }
        setError(message(caught, 'The lifecycle action failed.'))
      } finally {
        setBusy(null)
      }
    },
    [onSessionExpired],
  )

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const label = versionInput.trim()
    if (label === '') {
      setError('Enter a version label such as 1.0.')
      return
    }
    const sessionToken = requireCsrfToken()
    if (sessionToken === null) {
      return
    }
    void runAction('create', async () => {
      const created = await api.createVersion(rulebookId, label, sessionToken)
      setVersionInput('')
      setReadiness(null)
      setStatusMessage(
        `Draft version ${created.version} frozen at ${formatDigest(created.contentDigest)}. Published artifacts were not changed.`,
      )
      reloadVersions()
      onChanged('draft')
    })
  }

  const handleRefresh = (version: string) => {
    const sessionToken = requireCsrfToken()
    if (sessionToken === null) {
      return
    }
    void runAction(`refresh:${version}`, async () => {
      const refreshed = await api.refreshVersion(rulebookId, version, sessionToken)
      setReadiness(null)
      setStatusMessage(
        `Draft version ${refreshed.version} refreshed at ${formatDigest(refreshed.contentDigest)}.`,
      )
      reloadVersions()
    })
  }

  const handleReadiness = (version: string) => {
    void runAction(`readiness:${version}`, async () => {
      const assessment = await api.getPublicationReadiness(rulebookId, version)
      setReadiness(assessment)
    })
  }

  const handlePublish = (version: string) => {
    if (readiness === null || readiness.version.version !== version) {
      setError('Run the readiness checks for this draft version before publishing.')
      return
    }
    if (!readiness.ready) {
      setError('Publication readiness has failed checks; resolve them before publishing.')
      return
    }
    const sessionToken = requireCsrfToken()
    if (sessionToken === null) {
      return
    }
    void runAction(`publish:${version}`, async () => {
      const published = await api.publishVersion(rulebookId, version, sessionToken)
      setReadiness(null)
      setStatusMessage(
        `Version ${published.version} is now published and immutable. Any earlier published version became historical.`,
      )
      reloadVersions()
      onChanged('published')
    })
  }

  const versions = state.status === 'ready' ? versionsNewestFirst(state.versions) : []
  const canFreeze = publicationStatus !== 'historical'

  return (
    <section className="detail-card" aria-labelledby="draft-lifecycle-heading">
      <h2 id="draft-lifecycle-heading">Draft lifecycle and publication</h2>
      <p className="field-hint">
        Freeze the working copy as a version, refresh a draft snapshot, check publication readiness,
        then publish. Published and historical versions are immutable; publishing a newer version
        only demotes the previous one to historical.
      </p>

      {canFreeze ? (
        <form className="lifecycle-create" onSubmit={handleCreate} noValidate>
          <div className="field">
            <label htmlFor="lifecycle-version-label">New version label</label>
            <input
              id="lifecycle-version-label"
              value={versionInput}
              onChange={(event) => setVersionInput(event.target.value)}
              placeholder="1.0"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="field-hint">
              {publicationStatus === 'published'
                ? 'Creating a version reopens the working copy for the next version; the published version stays immutable.'
                : 'The working copy is frozen under this label. An existing label is rejected as a conflict.'}
            </p>
          </div>
          <button type="submit" className="button button--primary" disabled={busy !== null}>
            {busy === 'create' ? 'Freezing…' : 'Freeze as draft version'}
          </button>
        </form>
      ) : (
        <p className="notice notice--warning" role="status">
          This rulebook is historical. Its versions cannot be transitioned again.
        </p>
      )}

      {error === null ? null : (
        <div className="state-panel state-panel--error playground-error-summary" role="alert">
          <p className="state-title">The lifecycle action was rejected</p>
          <p>{error}</p>
        </div>
      )}
      {statusMessage === null ? null : (
        <p className="notice editor-saved" role="status">
          {statusMessage}
        </p>
      )}

      <h3>Versions</h3>
      {state.status === 'loading' ? <LoadingState title="Loading versions…" rowCount={3} /> : null}
      {state.status === 'error' ? (
        <div className="state-panel state-panel--error playground-error-summary" role="alert">
          <p className="state-title">The version history could not be loaded</p>
          <p>{state.message}</p>
          <button type="button" className="button button--ghost" onClick={reloadVersions}>
            Retry
          </button>
        </div>
      ) : null}
      {state.status === 'ready' && versions.length === 0 ? (
        <p className="muted">No versions have been frozen for this rulebook yet.</p>
      ) : null}
      {versions.length > 0 ? (
        <div className="table-wrap table-wrap--nested">
          <table className="detail-table version-table">
            <caption className="sr-only">Version lifecycle actions, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Status</th>
                <th scope="col">Content digest (SHA-256)</th>
                <th scope="col">Created</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => {
                const draft = version.status === 'draft'
                const readyForThis =
                  readiness !== null &&
                  readiness.version.version === version.version &&
                  readiness.ready
                return (
                  <tr key={version.id}>
                    <th scope="row">
                      <code>{version.version}</code>
                    </th>
                    <td>
                      <StatusBadge status={version.status} />
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
                      {draft ? (
                        <div className="lifecycle-actions">
                          <button
                            type="button"
                            className="button button--ghost"
                            onClick={() => handleRefresh(version.version)}
                            disabled={busy !== null}
                          >
                            {busy === `refresh:${version.version}` ? 'Refreshing…' : 'Refresh'}
                          </button>
                          <button
                            type="button"
                            className="button button--ghost"
                            onClick={() => handleReadiness(version.version)}
                            disabled={busy !== null}
                          >
                            {busy === `readiness:${version.version}`
                              ? 'Checking…'
                              : 'Check readiness'}
                          </button>
                          <button
                            type="button"
                            className="button button--primary"
                            onClick={() => handlePublish(version.version)}
                            disabled={busy !== null || !readyForThis}
                            title={
                              readyForThis
                                ? undefined
                                : 'Run the readiness checks for this version first.'
                            }
                          >
                            {busy === `publish:${version.version}` ? 'Publishing…' : 'Publish'}
                          </button>
                        </div>
                      ) : (
                        <span className="muted">Immutable</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {readiness === null ? (
        versions.some((version) => version.status === 'draft') ? (
          <p className="field-hint">
            Check publication readiness before publishing a draft version; the publish action stays
            disabled until every blocking check passes.
          </p>
        ) : null
      ) : (
        <div className="readiness-panel" aria-live="polite">
          <h3>Publication readiness for version {readiness.version.version}</h3>
          <p
            className={`readiness-summary readiness-summary--${readiness.ready ? 'ready' : 'blocked'}`}
            role="status"
          >
            {readiness.ready
              ? 'Ready to publish: every blocking check passed.'
              : 'Not ready to publish: resolve the failed checks first.'}
          </p>
          <ul className="readiness-list">
            {readiness.checks.map((check) => (
              <li key={check.id}>
                <span className={`badge readiness-badge--${check.status}`}>
                  {READINESS_STATUS_LABELS[check.status]}
                </span>{' '}
                <span className="readiness-message">{check.message}</span>
              </li>
            ))}
          </ul>
          {readiness.limitations.length === 0 ? null : (
            <div className="editor-limitations">
              <h4>Readiness boundaries</h4>
              <ul className="limitation-list">
                {readiness.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
