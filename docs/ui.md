# Rulebook catalog and detail UI

**Status:** Phase 1 implementation of
[issue #36](https://github.com/ForkbombEu/credimi-attestbook/issues/36) (UI-001) and
[issue #37](https://github.com/ForkbombEu/credimi-attestbook/issues/37) (UI-002). It
delivers a responsive, searchable catalog of rulebooks and a rulebook detail view with
attestation types, schema references, provenance, standards-compatibility disclosure and
version history, all read from the public AttestBook API. It does not add the editor, import
UI, publication controls or credential playground; those remain #38, #40–#42 and later
follow-ups.

**Authoritative spec:** [`docs/specification.md`](specification.md) §14 (UI-001/UI-002) and
§2.2 (independent standalone UI).
**Architecture:** [`docs/architecture.md`](architecture.md) §5 (the web UI is a client of
the public API, not a bypass) and §6.
**Decisions:** [`docs/implementation-plan.md`](implementation-plan.md) D-8/D-17
(compatibility is never inferred) and D-14 (React + Vite, Playwright for browser tests).
**API:** [`docs/api.md`](api.md).

## 1. Scope and boundaries

Implemented by these slices:

- a single-page application served by the same Bun server that exposes the API, at `/` for
  the catalog and `/rulebooks/<id>` for a detail deep link;
- catalog results as a table on wide screens and labelled cards on narrow screens, with
  name, description, provider, latest version and version count, publication status,
  supported attestation types and formats, source, last-updated date and compatibility
  status for every rulebook;
- case-insensitive search across the displayed text fields, plus provider and publication
  status filters and a clear/reset action;
- rulebook detail with:
  - metadata: stable identifier, provider, publication status, applicable specification and
    record counts;
  - attestation types with level of assurance, binding type, supported formats and their
    schema references;
  - every schema reference, including rulebook-level references that belong to no
    attestation type, with format identifier, safe http(s)-only URI and SRI integrity;
  - source provenance: the source URL (or "locally authored") and registry timestamps;
  - standards-compatibility disclosure: the rulebook is always **Not tested**, and each
    FR-010 evaluation dimension states whether this build supports it per credential, has
    not tested it, or cannot apply it;
  - version history, newest first, with label, status, specification, SHA-256 content
    digest, creation/publication dates and an export of each exact immutable snapshot;
- loading, error (with retry), empty and not-found states, including section-level
  degradation when a related read fails;
- accessible markup (landmarks, breadcrumb, table semantics, labelled controls, live status,
  skip link, visible focus, reduced-motion support) checked by axe-core in component and
  browser tests;
- the public `GET /api/v1/providers` read the catalog needs to show provider names, plus the
  existing public rulebook, attestation, schema-reference and version reads. These are
  additive `v1` public projections; publication authority, internal metadata, provenance
  and tokens are never returned.

Deliberately **not** in these slices:

- credential validation playground (UI-005,
  [issue #38](https://github.com/ForkbombEu/credimi-attestbook/issues/38));
- editor, import UI, draft management, publication controls and version diff (UI-003/UI-004,
  #40–#42 and a later import-UI issue). The detail view is read-only and claims no Phase 2
  authoring functionality;
- catalogue- or rulebook-level validation/compatibility evaluation. The catalog reports
  **Not tested** for every rulebook and the detail view repeats that result, because
  structural validation is a per-credential operation against a pinned rulebook version and
  the API does not persist catalogue-level results.

## 2. Stack and compatibility probe

The intended stack in [`docs/implementation-plan.md`](implementation-plan.md) D-14 was a
verification gate: exact versions must be executed before being claimed. The UI pins and
exercises these exact versions (the lockfile is authoritative):

| Component | Version | Exercised by |
| --- | --- | --- |
| React / React DOM | 19.3.1 | `bun run test:ui`, `bun run test:e2e` |
| Vite | 8.3.6 | `bun run build:ui` (production build) |
| `@vitejs/plugin-react` | 6.2.1 | `bun run build:ui`, `bun run dev:ui` |
| Vitest | 5.1.0 | component and unit tests under jsdom 31.0.0 |
| `@testing-library/react` | 16.3.3 | component tests |
| `@testing-library/user-event` | 14.6.8 | navigation, search, filter and retry interactions |
| axe-core | 4.14.0 | component accessibility assertions |
| `@axe-core/playwright` | 4.14.0 | full-rule accessibility assertion in Chromium |
| `@playwright/test` | 1.65.0 | browser end-to-end tests against the real API |

The build and both test layers run in CI (`ui` job). The probe result is the green
production build plus passing component and browser tests listed below; no version is
claimed beyond what these checks execute. There are no React UI component libraries: the UI
is plain React and CSS, so no further library compatibility is claimed.

## 3. Routes and data flow

The browser is a client of the public API only:

1. `GET /api/v1/providers` — public provider names;
2. `GET /api/v1/rulebooks?limit=100&offset=0` — the catalogue page;
3. `GET /api/v1/rulebooks/{id}/attestations` — attestation types (with embedded schema
   references) for a catalog row;
4. `GET /api/v1/rulebooks/{id}/versions` — version metadata for the latest-version cell;
5. on `/rulebooks/{id}`: `GET /api/v1/rulebooks/{id}` plus the provider list, attestation
   list, `GET /api/v1/rulebooks/{id}/schema-references` and the version list;
6. exports are ordinary links to
   `GET /api/v1/rulebooks/{id}/versions/{version}/content`, which returns the exact stored
   snapshot bytes with `Content-Digest` and `ETag` so a consumer can verify the shown digest.

The client router uses real paths with the History API. The Bun server serves the built
entry document for `/` and `/rulebooks/*`; `/api/*` stays separate and unknown non-UI paths
keep the JSON not-found envelope. A deep link or a browser reload therefore reaches the same
detail view. Browser back/forward is handled with a `popstate` listener; in-page links push a
history entry. Modified clicks (new tab, copy address) keep the native anchor behaviour.

The latest displayed version is the most recently created **published** version, or the most
recently created version of any status when nothing is published. Rulebook no. 1 in
`ui/e2e/server.ts` covers this: it has a published `1.0` and a draft `1.1`, and the catalog
shows `1.0` while the detail history marks `1.0` **Latest** and lists both versions newest
first.

A failed per-rulebook detail read in the catalogue marks only that row as **Details
unavailable**; the rest of the catalog still renders. On a detail page the rulebook record is
required: a missing record is the **Rulebook not found** state and another failure offers
**Retry**. The related collections degrade section by section, so a failed version or
schema-reference read leaves the metadata, attestations and provenance visible with an
explicit unavailable notice.

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

### 3.2 Standards compatibility

UI-002 asks for standards compatibility, but Phase 1 has no persisted rulebook-level
compatibility result and FR-010/FR-012 forbid inferring one. The detail view therefore:

- reports **Rulebook-level compatibility: Not tested**;
- lists the eight FR-010 dimensions with an explicit support label: **Supported per
  credential** for the structural checks this build executes, **Not tested** for the
  cryptographic and issuer-trust checks it does not implement, and **Not applicable** for
  protocol conformance and interoperability, which a single credential artifact cannot
  exercise;
- states that a structural check never implies cryptographic, trust, protocol or
  interoperability success.

The table mirrors `src/validation/dimensions.ts`; `ui/src/compatibility.test.ts` compares it
with `DIMENSION_DEFINITIONS`, so the UI cannot claim support the engine does not have.
Neither **Not tested** nor **Not applicable** is presented as a pass.

## 4. Build, serve and develop

```bash
bun run build        # API bundles + Vite build into dist/ui
bun run dev          # Bun API server; serves dist/ui when it exists
bun run dev:ui       # Vite dev server on :5173, /api proxied to :3000
bun run typecheck:ui # strict TypeScript for the UI, Vitest and Playwright configs
bun run test:ui      # Vitest component, logic and accessibility tests
bun run test:e2e     # Playwright against the real API with seeded data
```

`src/server.ts` serves `dist/ui/index.html` at `/`, `dist/ui/favicon.svg` at that path,
Vite's content-addressed files under `/assets/*`, and the same entry document for
`/rulebooks/*` deep links. When `dist/ui` is absent (a source checkout without a UI build),
the UI routes are not registered, so `/` and `/rulebooks/*` keep the JSON 404 instead of
serving a broken page. The Dockerfile copies the `ui/` sources before building, so the
container serves the built UI from the same origin as the API. The browser never uses a
private backdoor.

## 5. Tests and evidence

Component and unit tests (`ui/src/*.test.ts[x]`, Vitest + jsdom):

- catalog loading, error + retry, empty catalog and filtered-empty states;
- catalog rendering of provider, version, publication status, attestation types, source,
  update date and the **Not tested** compatibility label;
- search, provider filter and status filter behavior and result counts;
- truncation handling: the notice stays visible when a search matches nothing, the no-match
  panel explains that only the loaded page was searched, the counter separates loaded from
  total, and providers with no loaded rulebook remain filterable;
- graceful handling of a failed per-rulebook detail read and of a truncated API page;
- detail loading, 404 **Rulebook not found**, API error + retry, and back-to-catalog
  navigation;
- detail metadata, provider fallback, attestation types, schema references (including
  rulebook-level ones), provenance, safe http(s)-only URI linking, compatibility disclosure
  and newest-first version history with digest and export URLs;
- section-level degradation when versions or schema references fail, and empty-version and
  malformed-record rendering;
- the router: path parsing, encoded ids, malformed paths, history navigation and modified
  clicks keeping native anchor behaviour;
- an end-to-end component navigation test from the catalog to a detail page and back, plus a
  direct deep-link render;
- axe-core accessibility checks for the catalog results/error states and the detail page and
  not-found state (colour contrast is disabled in jsdom because it cannot compute painted
  colours; the browser tests run the full rule set).

Browser tests (`ui/e2e/catalog.spec.ts`, `ui/e2e/detail.spec.ts`, Playwright + Chromium):

- six seeded rulebooks from the real registry/API, with provider, version, status,
  attestation, source and compatibility content;
- search, provider and status filters, filtered-empty state and reset;
- delayed-API loading state, injected API error and successful retry;
- catalog → detail navigation, deep-link reload, back-to-catalog, detail metadata,
  attestations, schema references, provenance, compatibility labels, version history and
  export links;
- unknown-rulebook not-found state, detail loading and detail API error + retry;
- full axe-core scans and 390 px viewport checks for the catalog and detail views.

CI adds the `ui` job: `typecheck:ui`, `test:ui`, Chromium installation and `test:e2e`. The
`build` job verifies `dist/ui/index.html` exists and the Docker job checks that `/` serves
the catalog HTML.

The pull request for the detail slice carries the required before/after captures at the same
viewport width (1280 px) and the same light theme:

- [before: `detail-before-catalog.png`](ui/detail-before-catalog.png) — baseline `257debb`
  (`main` before the detail slice): the catalog has no detail navigation;
- [before: `detail-before-404.png`](ui/detail-before-404.png) — the same baseline requesting
  a detail URL: the real server returns the JSON not-found envelope;
- [after: `detail-after-catalog.png`](ui/detail-after-catalog.png) — this slice: catalog
  rulebook names link to the detail view;
- [after: `detail-after.png`](ui/detail-after.png) — this slice: the PID Rulebook detail page
  served from `/rulebooks/<id>` with the seeded real API data;
- [after, narrow viewport: `detail-after-mobile.png`](ui/detail-after-mobile.png) — the same
  detail page at 390 px.

The catalog slice's captures remain in the same directory
([`catalog-before.png`](ui/catalog-before.png),
[`catalog-after.png`](ui/catalog-after.png),
[`catalog-after-mobile.png`](ui/catalog-after-mobile.png)).

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
- Compatibility and validation are always **Not tested** at catalogue and rulebook level.
  The detail view shows what the build supports per credential; it does not persist or
  infer a per-rulebook result.
- Provenance is the public projection only (source URL and registry timestamps). The public
  API deliberately does not expose registry-internal import provenance, so the detail view
  says so rather than inventing it.
- The detail view is read-only. Draft management, publication, editing, version diff and
  import remain Phase 2 or later UI slices; no Phase 2 editor functionality is claimed.
- UI responses set `X-Content-Type-Options: nosniff` and Vite assets are immutable-cached;
  a content security policy and the rest of the HTTP hardening remain
  [issue #35](https://github.com/ForkbombEu/credimi-attestbook/issues/35).
- No dark theme or offline cache; routing covers only the two Phase 1 views, and any other
  path falls back to the catalog.
