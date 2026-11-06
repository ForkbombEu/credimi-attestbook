import { createHttpCatalogApi } from './api'
import { CatalogPage } from './CatalogPage'

const defaultApi = createHttpCatalogApi()

export function App() {
  return <CatalogPage api={defaultApi} />
}
