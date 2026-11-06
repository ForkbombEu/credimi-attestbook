import { useEffect, useState } from 'react'

import { createHttpCatalogApi, createHttpEditorApi, createHttpValidationApi } from './api'
import { CatalogPage } from './CatalogPage'
import { PlaygroundPage } from './PlaygroundPage'
import { RulebookDetailPage } from './RulebookDetailPage'
import { RulebookDraftEditorPage } from './RulebookDraftEditorPage'
import { useRoute } from './router'

const defaultApi = createHttpCatalogApi()
const defaultValidator = createHttpValidationApi()
const defaultEditor = createHttpEditorApi()

export function App() {
  const { route, navigate } = useRoute()
  /**
   * The provider bearer token lives only in this component's memory for the
   * current page session. It is never persisted to storage, the URL or a
   * rendered document, and navigating between the catalog and the editor keeps
   * it available until a full page reload.
   */
  const [editorToken, setEditorToken] = useState('')

  useEffect(() => {
    if (route.name === 'catalog') {
      document.title = 'Rulebook catalog · AttestBook'
    }
  }, [route])

  if (route.name === 'playground') {
    return <PlaygroundPage api={defaultApi} validator={defaultValidator} onNavigate={navigate} />
  }
  if (route.name === 'editor-new') {
    return (
      <RulebookDraftEditorPage
        api={defaultEditor}
        token={editorToken}
        onTokenChange={setEditorToken}
        onNavigate={navigate}
      />
    )
  }
  if (route.name === 'editor') {
    return (
      <RulebookDraftEditorPage
        api={defaultEditor}
        rulebookId={route.rulebookId}
        token={editorToken}
        onTokenChange={setEditorToken}
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
