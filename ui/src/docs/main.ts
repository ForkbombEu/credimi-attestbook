// Interactive reference for the AttestBook product API (issue #126).
//
// Scalar is bundled into the UI build and served from the application origin,
// so `/docs` never loads a script, style or font from a third-party CDN. The
// OpenAPI document is the canonical same-origin contract from `GET
// /openapi.json`; this entry adds no route schema of its own. Telemetry and
// Scalar's default remote fonts are disabled so the page makes no unsanctioned
// external request, and the document URL stays path-relative so a reverse
// proxy's public host is used without configuration.

import { createApiReference } from '@scalar/api-reference'
import '@scalar/api-reference/style.css'

// The small documentation header above the reference is part of this entry,
// not the SPA layout, because `/docs` is a separate server document.
import './docs.css'

const root = document.getElementById('docs-root')
const documentUrl = root instanceof HTMLElement ? root.dataset['openapiUrl'] : undefined

if (root !== null && documentUrl !== undefined && documentUrl !== '') {
  createApiReference(root, {
    url: documentUrl,
    telemetry: false,
    withDefaultFonts: false,
    // A public documentation page does not need Scalar's dashboard toolbar,
    // hosted client or "Ask AI" service. Disabling them keeps the page local
    // and avoids controls that would contact scalar.com.
    showDeveloperTools: 'never',
    hideClientButton: true,
    agent: { disabled: true },
  })
}
