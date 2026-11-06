# Rulebook catalog UI

**Status:** Phase 1 implementation of
[issue #36](https://github.com/ForkbombEu/credimi-attestbook/issues/36). It delivers UI-001
of [`docs/specification.md`](specification.md) §14: a responsive, searchable catalog of
rulebooks shown from the public AttestBook API. It does not add the rulebook detail page,
the editor, the import UI or the credential playground; those remain #37, #38, #40–#42 and
the later import-UI follow-up.

**Authoritative spec:** [`docs/specification.md`](specification.md) §14 (UI-001) and §2.2
(independent standalone UI).
**Architecture:** [`docs/architecture.md`](architecture.md) §5 (the web UI is a client of
the public API, not a bypass) and §6.
**Decisions:** [`docs/implementation-plan.md`](implementation-plan.md) D-8/D-17
(compatibility is never inferred) and D-14 (React + Vite, Playwright for browser tests).
**API:** [`docs/api.md`](api.md).

## 1. Scope and boundaries

Implemented by this slice:

- a single-page catalog served at `/` by the same Bun server that exposes the API;
- responsive results (table on wide screens, labelled cards on narrow screens);
- name, description, provider, latest version and version count, publication status,
  supported attestation types and formats, source, last-updated date and compatibility
  status for every rulebook;
- case-insensitive search across the displayed text fields, plus provider and publication
  status filters and a clear/reset action;
- loading, error (with retry), empty-catalog and no-matches states;
- accessible markup (landmarks, table semantics, labelled controls, live status, skip link,
  visible focus, reduced-motion support) checked by axe-core in component and browser tests;
- the public `GET /api/v1/providers` read the catalog needs to show provider names. It is an
  additive `v1` read of the public projection (id, name, creation time); publication
  authority, internal metadata and tokens are never returned.

Deliberately **not** in this slice:

- rulebook detail navigation, version history, schema references and export (UI-002,
  [issue #37](https://github.com/ForkbombEu/credimi-attestbook/issues/37));
- credential validation playground (UI-005,
  [issue #38](https://github.com/ForkbombEu/credimi-attestbook/issues/38));
- editor, import UI, draft management and publication actions (UI-003/UI-004, #40–#42 and
  a later import-UI issue);
- catalogue-level validation or compatibility evaluation. The catalog displays **Not
  tested** for every rulebook, because structural validation is a per-credential operation
  against a pinned rulebook version and the API does not persist catalogue-level results.
  The footer states that the catalog does not test or claim trust, interoperability or
  standards conformance.

## 2. Stack and compatibility probe

The intended stack in [`docs/implementation-plan.md`](implementation-plan.md) D-14 was a
verification gate: exact versions must be executed before being claimed. The catalog pins
and exercises these exact versions (the lockfile is authoritative):

| Component | Version | Exercised by |
| --- | --- | --- |
| React / React DOM | 19.3.1 | `bun run test:ui`, `bun run test:e2e` |
| Vite | 8.3.6 | `bun run build:ui` (production build) |
| `@vitejs/plugin-react` | 6.2.1 | `bun run build:ui`, `bun run dev:ui` |
| Vitest | 5.1.0 | component and unit tests under jsdom 31.0.0 |
| `@testing-library/react` | 16.3.3 | component tests |
| `@testing-library/user-event` | 14.6.8 | search, filter and retry interactions |
| axe-core | 4.14.0 | component accessibility assertions |
| `@axe-core/playwright` | 4.14.0 | full-rule accessibility assertion in Chromium |
| `@playwright/test` | 1.65.0 | browser end-to-end tests against the real API |

The build and both test layers run in CI (`ui` job). The probe result is the green
production build plus passing component and browser tests listed below; no version is
claimed beyond what these checks execute. There are no React UI component libraries: the
catalog is plain React and CSS, so no further library compatibility is claimed.

## 3. Data flow

The browser is a client of the public API only:

1. `GET /api/v1/providers` — public provider names;
2. `GET /api/v1/rulebooks?limit=100&offset=0` — the catalogue page;
3. `GET /api/v1/rulebooks/{id}/attestations` and
   `GET /api/v1/rulebooks/{id}/versions` — per-rulebook attestation types and versions.

The latest displayed version is the most recently created **published** version, or the
most recently created version of any status when nothing is published. Rulebook no. 1 in
`ui/e2e/server.ts` covers this: it has a published `1.0` and a draft `1.1`, and the catalog
shows `1.0` while reporting two versions.

A failed per-rulebook detail read marks only that row as **Details unavailable**; the rest
of the catalog still renders. A failed provider or catalogue listing fails the page and
offers **Retry**.

### 3.1 Search and filter semantics

- Search is case-insensitive and requires every whitespace-separated term to match the
  rulebook name, description, provider name, profile, displayed version, attestation type
  name, level of assurance, binding type or supported format.
- The provider filter matches the rulebook's owning provider; the status filter matches the
  rulebook's working-copy publication status (`draft`, `published`, `historical`).
- Filtering happens in the browser over the fetched page, so it also covers fields that
  the API query parameters do not expose. The API page cap is 100; when `total` exceeds the
  returned page, a truncation notice stays visible in every ready state, including the
  no-match state, and the no-match panel says that only the loaded page was searched. The
  result counter distinguishes loaded rulebooks from the catalog total.
- The provider filter lists every provider returned by `GET /api/v1/providers`, including
  providers whose rulebooks are not on the loaded page; a rulebook whose provider is absent
  from that list is still filterable under its provider identifier. Search and the provider
  and status filters apply only to the loaded page, as the truncation notice states.

## 4. Build, serve and develop

```bash
bun run build        # API bundles + Vite build into dist/ui
bun run dev          # Bun API server; serves dist/ui when it exists
bun run dev:ui       # Vite dev server on :5173, /api proxied to :3000
bun run typecheck:ui # strict TypeScript for the UI, Vitest and Playwright configs
bun run test:ui      # Vitest component, logic and accessibility tests
bun run test:e2e     # Playwright against the real API with seeded data
```

`src/server.ts` serves `dist/ui/index.html` at `/`, `dist/ui/favicon.svg` at that path and
Vite's content-addressed files under `/assets/*`. When `dist/ui` is absent (a source
checkout without a UI build), the UI routes are not registered, so `/` keeps the JSON 404
instead of serving a broken page. The Dockerfile copies the `ui/` sources before building,
so the container serves the built catalog from the same origin as the API. The browser
never uses a private backdoor.

## 5. Tests and evidence

Component and unit tests (`ui/src/*.test.ts[x]`, Vitest + jsdom):

- loading, error + retry, empty catalog and filtered-empty states;
- rendering of provider, version, publication status, attestation types, source, update
  date and the **Not tested** compatibility label;
- search, provider filter and status filter behavior and result counts;
- truncation handling: the notice stays visible when a search matches nothing, the
  no-match panel explains that only the loaded page was searched, the counter separates
  loaded from total, and providers with no loaded rulebook remain filterable;
- graceful handling of a failed per-rulebook detail read and of a truncated API page;
- axe-core accessibility checks for the results and error states (colour contrast is
  disabled in jsdom because it cannot compute painted colours; the browser test runs the
  full rule set).

Browser tests (`ui/e2e/catalog.spec.ts`, Playwright + Chromium):

- six seeded rulebooks from the real registry/API, with provider, version, status,
  attestation, source and compatibility content;
- search, provider and status filters, filtered-empty state and reset;
- delayed-API loading state, injected API error and successful retry;
- a full axe-core scan in a real browser;
- a 390 px viewport check for a readable layout without horizontal scrolling.

CI adds the `ui` job: `typecheck:ui`, `test:ui`, Chromium installation and `test:e2e`. The
`build` job verifies `dist/ui/index.html` exists and the Docker job checks that `/` serves
the catalog HTML.

The pull request for this slice carries the required before/after captures at the same
viewport width (1280 px) and the same light theme:

- [before: `catalog-before.png`](ui/catalog-before.png) — baseline revision `0efbaf1`
  (current `main` before this slice). The application has no web UI, so `GET /` returns the
  JSON not-found envelope; the capture is the real server response, not a mockup;
- [after: `catalog-after.png`](ui/catalog-after.png) — this slice, served from `/` with the
  seeded real API data (six rulebooks, three providers, published/draft rulebooks and one
  rulebook with a published plus a draft version);
- [after, narrow viewport: `catalog-after-mobile.png`](ui/catalog-after-mobile.png) — the
  same catalog at 390 px showing the card layout.

## 6. Limitations

- The catalogue listing is the Phase 1 API page (maximum 100 entries); there is no
  pagination control, so larger catalogues are shown truncated with an explicit notice.
  Search and filters cover only that loaded page, and the notice and counter say so in every
  ready state, including no matches.
- Per-rulebook attestations and versions are fetched with one request pair per listed
  rulebook (N+1 reads). This is acceptable for the bounded MVP page and should be replaced
  by a catalog projection endpoint if catalogue size grows.
- "Last updated" is the rulebook's `updatedAt`; the registry does not track import
  synchronisation timestamps separately, so the UI does not claim a last-sync time.
- Compatibility and validation are always **Not tested** at catalogue level. A later slice
  may link to persisted per-version results, but this slice does not infer them.
- UI responses set `X-Content-Type-Options: nosniff` and Vite assets are immutable-cached;
  a content security policy and the rest of the HTTP hardening remain
  [issue #35](https://github.com/ForkbombEu/credimi-attestbook/issues/35).
- No dark theme, offline cache or client-side routing yet; the rulebook detail page is
  issue #37.
