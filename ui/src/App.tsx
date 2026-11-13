import { useEffect } from 'react'

import {
  createHttpCaptureApi,
  createHttpCatalogApi,
  createHttpEditorApi,
  createHttpValidationApi,
} from './api'
import { createHttpAuthApi, intendedPath } from './auth'
import { CaptureDetailPage } from './CaptureDetailPage'
import { CapturesPage } from './CapturesPage'
import { CatalogPage } from './CatalogPage'
import { LoginPage } from './LoginPage'
import { PlaygroundPage } from './PlaygroundPage'
import { RulebookDetailPage } from './RulebookDetailPage'
import { RulebookDraftEditorPage } from './RulebookDraftEditorPage'
import { useRoute } from './router'
import { SessionProvider, useSession } from './session'

const defaultApi = createHttpCatalogApi()
const defaultValidator = createHttpValidationApi()
const defaultEditor = createHttpEditorApi()
const defaultCaptures = createHttpCaptureApi()
const defaultAuth = createHttpAuthApi()

export function App() {
  return (
    <SessionProvider api={defaultAuth}>
      <AppRoutes />
    </SessionProvider>
  )
}

function AppRoutes() {
  const { route, navigate } = useRoute()
  // The administrator session is the only credential the protected views use;
  // there is no bearer-token state to carry between routes.
  const session = useSession()

  useEffect(() => {
    if (route.name === 'catalog') {
      document.title = 'Rulebook catalog · AttestBook'
    }
  }, [route])

  if (route.name === 'login') {
    return <LoginPage onNavigate={navigate} nextPath={intendedPath(window.location.search)} />
  }
  if (route.name === 'playground') {
    return <PlaygroundPage api={defaultApi} validator={defaultValidator} onNavigate={navigate} />
  }
  if (route.name === 'captures') {
    return <CapturesPage api={defaultCaptures} onNavigate={navigate} />
  }
  if (route.name === 'capture') {
    return (
      <CaptureDetailPage
        api={defaultCaptures}
        catalogApi={defaultApi}
        captureId={route.captureId}
        session={session}
        onNavigate={navigate}
      />
    )
  }
  if (route.name === 'editor-new') {
    return <RulebookDraftEditorPage api={defaultEditor} session={session} onNavigate={navigate} />
  }
  if (route.name === 'editor') {
    return (
      <RulebookDraftEditorPage
        api={defaultEditor}
        rulebookId={route.rulebookId}
        session={session}
        onNavigate={navigate}
      />
    )
  }
  if (route.name === 'rulebook') {
    return (
      <RulebookDetailPage api={defaultApi} rulebookId={route.rulebookId} onNavigate={navigate} />
    )
  }
  return <CatalogPage api={defaultApi} onNavigate={navigate} />
}
