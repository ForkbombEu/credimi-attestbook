// Public version comparison panel (UI-003 "version diff", issue #41).
//
// The panel compares two stored snapshots through the public API. The diff is
// computed server-side and is deterministic: changes arrive as JSON Pointer
// paths sorted by path, and the client only renders them. Identity fields of a
// snapshot (format marker, rulebook id and the version label) are excluded by
// the server, so "identical content" is meaningful across labels.

import { useCallback, useEffect, useRef, useState } from 'react'

import type { CatalogApi } from '../api'
import { isAbortError } from '../api'
import { formatDigest, versionsNewestFirst } from '../detail'
import type { JsonValue, RulebookVersion, VersionDiff } from '../types'

interface VersionComparisonPanelProps {
  readonly api: CatalogApi
  readonly rulebookId: string
  readonly versions: readonly RulebookVersion[]
}

type ComparisonState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly diff: VersionDiff }
  | { readonly status: 'error'; readonly message: string }

function formatValue(value: JsonValue | undefined): string {
  return value === undefined ? '—' : JSON.stringify(value)
}

export function VersionComparisonPanel({ api, rulebookId, versions }: VersionComparisonPanelProps) {
  const ordered = versionsNewestFirst(versions)
  const [fromLabel, setFromLabel] = useState(versions[0]?.version ?? '')
  const [toLabel, setToLabel] = useState(versions.at(-1)?.version ?? '')
  const [state, setState] = useState<ComparisonState>({ status: 'idle' })
  const pending = useRef<AbortController | null>(null)

  // Keep the selection valid when the version history reloads.
  useEffect(() => {
    if (versions.length === 0) {
      return
    }
    if (!versions.some((version) => version.version === fromLabel)) {
      setFromLabel(versions[0]?.version ?? '')
    }
    const latest = versions.at(-1)?.version ?? ''
    if (!versions.some((version) => version.version === toLabel)) {
      setToLabel(latest)
    }
  }, [fromLabel, toLabel, versions])

  useEffect(() => () => pending.current?.abort(), [])

  const compare = useCallback(() => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setState({ status: 'loading' })
    api
      .getVersionDiff(rulebookId, fromLabel, toLabel, controller.signal)
      .then((diff) => {
        if (!controller.signal.aborted) {
          setState({ status: 'ready', diff })
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) {
          return
        }
        setState({
          status: 'error',
          message:
            error instanceof Error && error.message !== ''
              ? error.message
              : 'The version comparison failed.',
        })
      })
  }, [api, fromLabel, rulebookId, toLabel])

  const selectable = versions.length >= 2
  const sameVersion = fromLabel === toLabel

  return (
    <section className="detail-card" aria-labelledby="version-comparison-heading">
      <h2 id="version-comparison-heading">Compare versions</h2>
      <p className="field-hint">
        A deterministic structural comparison of two snapshots. Snapshot identity fields (format,
        rulebook id and the version label) are excluded, so two labels with the same authored
        content compare as identical.
      </p>

      {!selectable ? (
        <p className="muted">Record at least two versions to compare them.</p>
      ) : (
        <>
          <div className="comparison-controls">
            <div className="field">
              <label htmlFor="version-compare-from">Baseline version</label>
              <select
                id="version-compare-from"
                value={fromLabel}
                onChange={(event) => {
                  setFromLabel(event.target.value)
                  setState({ status: 'idle' })
                }}
              >
                {ordered.map((version) => (
                  <option key={version.id} value={version.version}>
                    {version.version} ({version.status})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="version-compare-to">Compared version</label>
              <select
                id="version-compare-to"
                value={toLabel}
                onChange={(event) => {
                  setToLabel(event.target.value)
                  setState({ status: 'idle' })
                }}
              >
                {ordered.map((version) => (
                  <option key={version.id} value={version.version}>
                    {version.version} ({version.status})
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="button button--primary"
              onClick={compare}
              disabled={state.status === 'loading' || sameVersion}
            >
              {state.status === 'loading' ? 'Comparing…' : 'Compare'}
            </button>
          </div>
          {sameVersion ? (
            <p className="field-hint" role="status">
              Choose two different versions.
            </p>
          ) : null}

          {state.status === 'error' ? (
            <div className="state-panel state-panel--error playground-error-summary" role="alert">
              <p className="state-title">The versions could not be compared</p>
              <p>{state.message}</p>
              <button type="button" className="button button--ghost" onClick={compare}>
                Retry
              </button>
            </div>
          ) : null}

          {state.status === 'ready' ? (
            state.diff.identical ? (
              <p className="notice" role="status">
                <strong>
                  {state.diff.from.version} and {state.diff.to.version}
                </strong>{' '}
                have identical authored content (digests{' '}
                {formatDigest(state.diff.from.contentDigest)} and{' '}
                {formatDigest(state.diff.to.contentDigest)}).
              </p>
            ) : (
              <>
                <p className="editor-status" role="status">
                  {state.diff.changes.length}{' '}
                  {state.diff.changes.length === 1 ? 'change' : 'changes'} between{' '}
                  <strong>{state.diff.from.version}</strong> and{' '}
                  <strong>{state.diff.to.version}</strong>: {state.diff.summary.added} added,{' '}
                  {state.diff.summary.removed} removed, {state.diff.summary.changed} changed.
                </p>
                <div className="table-wrap table-wrap--nested">
                  <table className="detail-table">
                    <caption className="sr-only">
                      Differences from version {state.diff.from.version} to version{' '}
                      {state.diff.to.version}, sorted by path
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Path</th>
                        <th scope="col">Change</th>
                        <th scope="col">Baseline value</th>
                        <th scope="col">Compared value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.diff.changes.map((change) => (
                        <tr key={change.path}>
                          <th scope="row">
                            <code>{change.path === '' ? '(document)' : change.path}</code>
                          </th>
                          <td>
                            <span className={`badge badge--diff-${change.kind}`}>
                              {change.kind}
                            </span>
                          </td>
                          <td>
                            <code className="diff-value">{formatValue(change.before)}</code>
                          </td>
                          <td>
                            <code className="diff-value">{formatValue(change.after)}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )
          ) : null}
        </>
      )}
    </section>
  )
}
