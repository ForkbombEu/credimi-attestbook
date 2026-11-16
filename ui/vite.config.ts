import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vitest/config'

const uiRoot = fileURLToPath(new URL('.', import.meta.url))

/**
 * Development-only routing for the documentation entry document.
 *
 * The production server maps `/docs` to the built `docs.html`; Vite serves the
 * file directly at `/docs.html`, so a dev browser navigating to the public URL
 * needs the same mapping before Vite's single-page fallback would answer.
 */
function docsRoute(): Plugin {
  return {
    name: 'attestbook-docs-route',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url === '/docs' || request.url === '/docs/') {
          request.url = '/docs.html'
        }
        next()
      })
    },
  }
}

// The UI is built into the server's `dist/ui` directory so the Bun server can
// serve the catalog and the versioned API from one origin (issue #36). The
// second HTML entry is the self-hosted Scalar reference for the product API
// (issue #126).
export default defineConfig({
  root: uiRoot,
  plugins: [react(), docsRoute()],
  // Scalar's bundled Vue runtime reads these build-time feature flags. Vite's
  // React setup does not define them, so define them explicitly to avoid the
  // development warning and keep the production bundle predictable.
  define: {
    __VUE_OPTIONS_API__: 'true',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(uiRoot, 'index.html'),
        docs: resolve(uiRoot, 'docs.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/openapi.json': 'http://127.0.0.1:3000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    clearMocks: true,
  },
})
