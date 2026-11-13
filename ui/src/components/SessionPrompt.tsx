// Session prompts shared by the protected authoring and capture views
// (issue #91).
//
// An anonymous visitor is sent to the full sign-in page with a validated
// same-origin return path. A session that expires while a form is open uses the
// inline renewal form instead of navigating away, so the view keeps its unsaved
// state; the caller retries the write after the refreshed session token is
// available. Neither prompt ever asks for a provider bearer token.

import { useId, useState, type FormEvent, type ReactNode } from 'react'

import { AuthApiError, currentPath, loginPath } from '../auth'
import { AppLink } from '../router'
import type { SessionController } from '../session'

interface SignInRequiredNoticeProps {
  readonly title: string
  readonly message: ReactNode
  readonly onNavigate: (path: string) => void
  /** `panel` fills an empty protected view; `inline` sits inside a public one. */
  readonly variant?: 'panel' | 'inline'
}

/** Sends an anonymous visitor to sign in and back to the current view. */
export function SignInRequiredNotice({
  title,
  message,
  onNavigate,
  variant = 'panel',
}: SignInRequiredNoticeProps) {
  const link = (
    <AppLink
      className="button button--primary"
      href={loginPath(currentPath())}
      onNavigate={onNavigate}
    >
      Sign in
    </AppLink>
  )

  if (variant === 'inline') {
    return (
      <div className="notice notice--warning" role="status">
        <p className="notice-title">{title}</p>
        <p>{message}</p>
        <p>{link}</p>
      </div>
    )
  }

  return (
    <div className="state-panel state-panel--empty" role="status">
      <h1 className="state-title">{title}</h1>
      <p className="state-detail">{message}</p>
      {link}
    </div>
  )
}

interface SessionRenewalFormProps {
  readonly session: SessionController
  readonly onRenewed: () => void
  readonly title?: string
  readonly description?: ReactNode
  readonly submitLabel?: string
}

function renewalErrorMessage(error: unknown): string {
  if (error instanceof AuthApiError && error.message !== '') {
    return error.message
  }
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return 'Sign-in failed. Try again.'
}

/**
 * Inline re-authentication for an expired session. The surrounding view stays
 * mounted, so its unsaved fields survive; `onRenewed` lets the caller clear the
 * expiry state and prompt the user to retry the write.
 */
export function SessionRenewalForm({
  session,
  onRenewed,
  title = 'Sign in again',
  description = 'Your administrator session expired. Sign in again to continue; your unsaved changes stay on this page.',
  submitLabel = 'Sign in again',
}: SessionRenewalFormProps) {
  const fieldPrefix = `renew-${useId().replaceAll(':', '')}`
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) {
      return
    }
    if (username.trim() === '' || password === '') {
      setError('Enter your username and password.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await session.signIn(username.trim(), password)
      setPassword('')
      onRenewed()
    } catch (caught) {
      setError(renewalErrorMessage(caught))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="detail-card session-renewal" aria-labelledby={`${fieldPrefix}-heading`}>
      <h2 id={`${fieldPrefix}-heading`}>{title}</h2>
      <p className="field-hint">{description}</p>
      {error === null ? null : (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="login-form"
        onSubmit={(event) => {
          void handleSubmit(event)
        }}
        aria-busy={submitting}
        noValidate
      >
        <div className="field">
          <label htmlFor={`${fieldPrefix}-username`}>Username</label>
          <input
            id={`${fieldPrefix}-username`}
            name="username"
            type="text"
            autoComplete="username"
            spellCheck={false}
            value={username}
            disabled={submitting}
            onChange={(event) => {
              setUsername(event.target.value)
              setError(null)
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`${fieldPrefix}-password`}>Password</label>
          <input
            id={`${fieldPrefix}-password`}
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={submitting}
            onChange={(event) => {
              setPassword(event.target.value)
              setError(null)
            }}
          />
        </div>
        <div className="login-form__actions">
          <button className="button button--primary" type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : submitLabel}
          </button>
          {submitting ? (
            <p className="login-form__working" role="status">
              Verifying your credentials…
            </p>
          ) : null}
        </div>
      </form>
    </section>
  )
}
