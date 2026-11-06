import { useEffect } from 'react'

import { createHttpCatalogApi } from './api'
import { CatalogPage } from './CatalogPage'
import { RulebookDetailPage } from './RulebookDetailPage'
import { useRoute } from './router'

const defaultApi = createHttpCatalogApi()

export function App() {
  const { route, navigate } = useRoute()

  useEffect(() => {
    if (route.name === 'catalog') {
      document.title = 'Rulebook catalog · AttestBook'
    }
  }, [route])

  return route.name === 'catalog' ? (
    <CatalogPage api={defaultApi} onNavigate={navigate} />
  ) : (
    <RulebookDetailPage api={defaultApi} rulebookId={route.rulebookId} onNavigate={navigate} />
  )
}
