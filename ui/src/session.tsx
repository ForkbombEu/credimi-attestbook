// React session state shared by the login page and the site navigation
// (issue #90). The provider restores the server session once on mount, so a
// reload keeps an authenticated administrator signed in, and exposes the
// sign-in/sign-out actions the views call.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { createHttpAuthApi, type AdminSession, type AuthApi } from './auth'

export type SessionStatus = 'loading' | 'anonymous' | 'authenticated'

export interface SessionController {
  readonly status: SessionStatus
  /** The live session, or `null` while loading and when anonymous. */
  readonly session: AdminSession | null
  /** Starts a session; the server answers 401/429/503 with a safe message. */
  readonly signIn: (username: string, password: string) => Promise<AdminSession>
  /** Revokes the server session and clears the local state. */
  readonly signOut: () => Promise<void>
  /** Re-reads `GET /api/v1/auth/me`, e.g. after a session expires. */
  readonly reload: () => void
}

/**
 * The header also renders outside a provider in component tests and in any
 * future standalone shell; there, an anonymous session is the safe default
 * and sign-in is unavailable rather than silently mocked.
 */
const anonymousController: SessionController = {
  status: 'anonymous',
  session: null,
  signIn: () => Promise.reject(new Error('Administrator sign-in needs a session provider.')),
  signOut: () => Promise.resolve(),
  reload: () => undefined,
}

const SessionContext = createContext<SessionController>(anonymousController)

export function useSession(): SessionController {
  return useContext(SessionContext)
}

interface SessionProviderProps {
  /** Injectable client; defaults to the real same-origin auth API. */
  readonly api?: AuthApi
  readonly children: ReactNode
}

interface SessionState {
  readonly status: Exclude<SessionStatus, 'loading'>
  readonly session: AdminSession | null
}

export function SessionProvider({ api, children }: SessionProviderProps) {
  const client = useMemo<AuthApi>(() => api ?? createHttpAuthApi(), [api])
  const [state, setState] = useState<SessionState | { readonly status: 'loading' }>({
    status: 'loading',
  })
  const [reloadToken, setReloadToken] = useState(0)
  // Sign-in, sign-out and reload bump the revision so a slower initial
  // `auth/me` response cannot overwrite the newer state with an older answer.
  const revision = useRef(0)
  // Sign-out needs the current session's CSRF token without making the action
  // depend on a render closure.
  const sessionRef = useRef<AdminSession | null>(null)
  useEffect(() => {
    sessionRef.current = state.status === 'authenticated' ? state.session : null
  }, [state])

  useEffect(() => {
    const controller = new AbortController()
    const startedAt = revision.current
    setState({ status: 'loading' })
    client
      .getSession(controller.signal)
      .then((session) => {
        if (controller.signal.aborted || revision.current !== startedAt) {
          return
        }
        setState(
          session === null
            ? { status: 'anonymous', session: null }
            : { status: 'authenticated', session },
        )
      })
      .catch(() => {
        // A server without a reachable session endpoint is treated as
        // anonymous: the public catalogue and playground keep working.
        if (!controller.signal.aborted && revision.current === startedAt) {
          setState({ status: 'anonymous', session: null })
        }
      })
    return () => controller.abort()
  }, [client, reloadToken])

  const signIn = useCallback(
    async (username: string, password: string): Promise<AdminSession> => {
      const session = await client.login({ username, password })
      revision.current += 1
      setState({ status: 'authenticated', session })
      return session
    },
    [client],
  )

  const signOut = useCallback(async (): Promise<void> => {
    const current = sessionRef.current
    if (current !== null) {
      // The session-bound CSRF token is required for a live cookie logout.
      await client.logout(current.csrfToken)
    }
    revision.current += 1
    setState({ status: 'anonymous', session: null })
  }, [client])

  const reload = useCallback(() => {
    revision.current += 1
    setReloadToken((token) => token + 1)
  }, [])

  const value = useMemo<SessionController>(
    () => ({
      status: state.status,
      session: state.status === 'authenticated' ? state.session : null,
      signIn,
      signOut,
      reload,
    }),
    [state, signIn, signOut, reload],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
