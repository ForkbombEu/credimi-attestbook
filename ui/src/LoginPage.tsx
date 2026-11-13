// Standalone administrator sign-in screen (issue #90).
//
// The form posts the configured username and password through the same-origin
// auth API, which answers with an HttpOnly session cookie. The page never asks
// for a bearer token, never stores the password beyond this React tree and
// returns to a validated same-origin `next` target instead of trusting an
// arbitrary redirect.

import { useEffect, useState, type FormEvent } from 'react'

import { AuthApiError, safeRedirectPath } from './auth'
import { useSession } from './session'
import { SiteFooter, SiteHeader, SkipLink } from './components/Layout'
import { formatDate } from './catalog'
import { AppLink, CATALOG_PATH } from './router'

interface LoginPageProps {
  readonly onNavigate: (path: string) => void
  /** Validated intended destination; the catalog when absent. */
  readonly nextPath?: string | null
}

interface FormErrors {
  readonly username?: string | undefined
  readonly password?: string | undefined
}

function messageForLoginError(error: unknown): string {
  if (error instanceof AuthApiError && error.message !== '') {
    return error.message
  }
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return 'Sign-in failed. Try again.'
}

function validateCredentials(username: string, password: string): FormErrors {
  return {
    ...(username.trim() === '' ? { username: 'Enter your username.' } : {}),
    ...(password === '' ? { password: 'Enter your password.' } : {}),
  }
}

export function LoginPage({ onNavigate, nextPath = null }: LoginPageProps) {
  const session = useSession()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<FormErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  const destination = safeRedirectPath(nextPath) ?? CATALOG_PATH

  useEffect(() => {
    document.title = 'Administrator sign-in · AttestBook'
  }, [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) {
      return
    }
    const nextErrors = validateCredentials(username, password)
    setErrors(nextErrors)
    setSubmitError(null)
    if (nextErrors.username !== undefined || nextErrors.password !== undefined) {
      return
    }
    setSubmitting(true)
    try {
      await session.signIn(username.trim(), password)
      setPassword('')
      onNavigate(destination)
    } catch (error: unknown) {
      setSubmitError(messageForLoginError(error))
    } finally {
      setSubmitting(false)
    }
  }

  const handleSignOut = async () => {
    if (signingOut) {
      return
    }
    setSignOutError(null)
    setSigningOut(true)
    try {
      await session.signOut()
    } catch {
      setSignOutError('Sign-out failed. Try again.')
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className="app-shell">
      <SkipLink href="#main-content">Skip to administrator sign-in</SkipLink>

      <SiteHeader section="Administrator login" onNavigate={onNavigate} showLoginLink={false} />

      <main className="page login-page" id="main-content">
        <div className="page-heading">
          <p className="eyebrow">Administrator</p>
          <h1>Sign in</h1>
          <p className="lede">
            Use the administrator credentials configured for this server. The catalogue and the
            validation playground stay available without signing in.
          </p>
        </div>

        <section className="login-card" aria-labelledby="login-card-title">
          <h2 className="login-card__title" id="login-card-title">
            {session.status === 'authenticated' ? 'Signed in' : 'Administrator credentials'}
          </h2>

          {session.status === 'loading' ? (
            <p className="login-card__status" role="status">
              Checking your session…
            </p>
          ) : null}

          {session.status === 'anonymous' ? (
            <>
              <p className="login-card__intro">
                Sign in to identify the provider this administrator acts for. Signing in starts a
                server-side session; this page never handles a provider bearer token.
              </p>

              <form
                className="login-form"
                onSubmit={(event) => {
                  void handleSubmit(event)
                }}
                aria-busy={submitting}
                noValidate
              >
                {submitError !== null ? (
                  <p className="login-form__error" role="alert">
                    {submitError}
                  </p>
                ) : null}

                <div className="field">
                  <label htmlFor="login-username">Username</label>
                  <input
                    id="login-username"
                    name="username"
                    type="text"
                    value={username}
                    autoComplete="username"
                    spellCheck={false}
                    disabled={submitting}
                    required
                    aria-invalid={errors.username === undefined ? undefined : true}
                    aria-describedby={
                      errors.username === undefined ? undefined : 'login-username-error'
                    }
                    onChange={(event) => {
                      setUsername(event.target.value)
                      setErrors((current) => ({ ...current, username: undefined }))
                    }}
                  />
                  {errors.username === undefined ? null : (
                    <p className="field-error" id="login-username-error">
                      {errors.username}
                    </p>
                  )}
                </div>

                <div className="field">
                  <label htmlFor="login-password">Password</label>
                  <input
                    id="login-password"
                    name="password"
                    type="password"
                    value={password}
                    autoComplete="current-password"
                    disabled={submitting}
                    required
                    aria-invalid={errors.password === undefined ? undefined : true}
                    aria-describedby={
                      errors.password === undefined ? undefined : 'login-password-error'
                    }
                    onChange={(event) => {
                      setPassword(event.target.value)
                      setErrors((current) => ({ ...current, password: undefined }))
                    }}
                  />
                  {errors.password === undefined ? null : (
                    <p className="field-error" id="login-password-error">
                      {errors.password}
                    </p>
                  )}
                </div>

                <div className="login-form__actions">
                  <button className="button button--primary" type="submit" disabled={submitting}>
                    {submitting ? 'Signing in…' : 'Sign in'}
                  </button>
                  {submitting ? (
                    <p className="login-form__working" role="status">
                      Verifying your credentials…
                    </p>
                  ) : null}
                </div>
              </form>

              <p className="login-card__note">
                Your password is sent only to this server. The session lives in an HttpOnly cookie;
                no password or token is written to browser storage.
              </p>
            </>
          ) : null}

          {session.status === 'authenticated' && session.session !== null ? (
            <>
              <p className="login-card__intro">
                You are signed in as <strong>{session.session.provider.name}</strong>.
              </p>
              <dl className="login-card__meta">
                <div>
                  <dt>Provider</dt>
                  <dd>{session.session.provider.name}</dd>
                </div>
                <div>
                  <dt>Session expires</dt>
                  <dd>
                    <time dateTime={session.session.expiresAt}>
                      {formatDate(session.session.expiresAt)}
                    </time>
                  </dd>
                </div>
              </dl>
              {signOutError === null ? null : (
                <p className="login-form__error" role="alert">
                  {signOutError}
                </p>
              )}
              <div className="login-card__actions">
                <AppLink
                  className="button button--primary"
                  href={destination}
                  onNavigate={onNavigate}
                >
                  Continue
                </AppLink>
                <button
                  className="button button--ghost"
                  type="button"
                  disabled={signingOut}
                  onClick={() => {
                    void handleSignOut()
                  }}
                >
                  {signingOut ? 'Signing out…' : 'Log out'}
                </button>
              </div>
            </>
          ) : null}
        </section>

        {session.status === 'authenticated' ? null : (
          <p className="login-page__back">
            <AppLink href={CATALOG_PATH} onNavigate={onNavigate}>
              Back to the rulebook catalog
            </AppLink>
          </p>
        )}
      </main>

      <SiteFooter />
    </div>
  )
}
