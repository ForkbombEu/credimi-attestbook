// Next-version flow for a published rulebook (issue #112).
//
// A published rulebook's working copy is read-only. The server reopens it when
// the owning administrator freezes the next draft version through the existing
// lifecycle API (`POST /api/v1/rulebooks/:rulebookId/versions`); this panel is
// the editor's entry point for that transition. It never generates a label and
// never publishes, keeps the typed label in the form when a request fails, and
// sends a repeated submission at most once.

import { useId, useRef, useState, type FormEvent } from 'react'

import type { EditorApi } from '../api'
import { isSessionAuthError } from '../api'
import type { RulebookVersion } from '../types'
import { Alert } from './Alert'

interface CreateVersionPanelProps {
  readonly api: EditorApi
  readonly rulebookId: string
  /** Live session CSRF token; `null` when the administrator is signed out. */
  readonly csrfToken: string | null
  /** Reports the created draft version so the editor can reopen its working copy. */
  readonly onCreated: (version: RulebookVersion) => void
  /** Tells the editor to show its inline renewal prompt after a 401/403. */
  readonly onSessionExpired: () => void
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}

export function CreateVersionPanel({
  api,
  rulebookId,
  csrfToken,
  onCreated,
  onSessionExpired,
}: CreateVersionPanelProps) {
  const fieldId = `create-version-${useId().replaceAll(':', '')}`
  const [label, setLabel] = useState('')
  const [labelError, setLabelError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting.current) {
      return
    }
    const version = label.trim()
    if (version === '') {
      setLabelError('Enter a version label such as 1.1.0.')
      return
    }
    if (csrfToken === null) {
      setError('Sign in again to create a new version; the published version stays unchanged.')
      onSessionExpired()
      return
    }
    setLabelError(null)
    setError(null)
    submitting.current = true
    setBusy(true)
    void (async () => {
      try {
        const created = await api.createVersion(rulebookId, version, csrfToken)
        setLabel('')
        onCreated(created)
      } catch (caught) {
        if (isSessionAuthError(caught)) {
          onSessionExpired()
        }
        setError(message(caught, 'The new version could not be created.'))
      } finally {
        submitting.current = false
        setBusy(false)
      }
    })()
  }

  return (
    <section className="detail-card create-version-panel" aria-labelledby={`${fieldId}-heading`}>
      <p className="eyebrow">Published version</p>
      <h2 id={`${fieldId}-heading`}>Create a new version</h2>
      <p className="field-hint">
        The published version is immutable. Creating a new draft version reopens the working copy
        for editing here without changing the published bytes or digest; nothing is published until
        you publish the new version yourself.
      </p>
      <form className="lifecycle-create" onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor={`${fieldId}-label`}>New version label</label>
          <input
            id={`${fieldId}-label`}
            value={label}
            onChange={(event) => {
              setLabel(event.target.value)
              setLabelError(null)
              setError(null)
            }}
            placeholder="1.0"
            autoComplete="off"
            spellCheck={false}
            required
            disabled={busy}
            aria-invalid={labelError !== null}
            aria-describedby={
              labelError === null ? `${fieldId}-hint` : `${fieldId}-hint ${fieldId}-label-error`
            }
          />
          <p className="field-hint" id={`${fieldId}-hint`}>
            A version label such as 1.1.0. An existing label is rejected as a conflict.
          </p>
          {labelError === null ? null : (
            <p className="field-error" id={`${fieldId}-label-error`} role="alert">
              {labelError}
            </p>
          )}
        </div>
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
          {busy ? 'Creating…' : 'Create new version'}
        </button>
      </form>
      {error === null ? null : (
        <Alert variant="destructive" role="alert" title="The new version was not created">
          <p>{error}</p>
        </Alert>
      )}
    </section>
  )
}
