import { useEffect } from 'react'

import { createHttpCatalogApi, createHttpValidationApi } from './api'
import { CatalogPage } from './CatalogPage'
import { PlaygroundPage } from './PlaygroundPage'
import { RulebookDetailPage } from './RulebookDetailPage'
import { useRoute } from './router'

const defaultApi = createHttpCatalogApi()
const defaultValidator = createHttpValidationApi()

export function App() {
  const { route, navigate } = useRoute()

  useEffect(() => {
    if (route.name === 'catalog') {
      document.title = 'Rulebook catalog · AttestBook'
    }
  }, [route])

  if (route.name === 'playground') {
    return <PlaygroundPage api={defaultApi} validator={defaultValidator} onNavigate={navigate} />
  }
  if (route.name === 'rulebook') {
    return (
      <RulebookDetailPage api={defaultApi} rulebookId={route.rulebookId} onNavigate={navigate} />
    )
  }
  return <CatalogPage api={defaultApi} onNavigate={navigate} />
}
