# Rulebook catalog, detail and credential playground UI

**Status:** Phase 1 implementation of
[issue #36](https://github.com/ForkbombEu/credimi-attestbook/issues/36) (UI-001),
[issue #37](https://github.com/ForkbombEu/credimi-attestbook/issues/37) (UI-002),
[issue #38](https://github.com/ForkbombEu/credimi-attestbook/issues/38) (UI-005), the
draft-editor slice of [issue #40](https://github.com/ForkbombEu/credimi-attestbook/issues/40)
(UI-003), the lifecycle/comparison slice of
[issue #41](https://github.com/ForkbombEu/credimi-attestbook/issues/41) (UI-003) and the
mock-backed capture explorer of [issue #48](https://github.com/ForkbombEu/credimi-attestbook/issues/48)
(UI-006, FR-019). It delivers
a responsive, searchable catalog of rulebooks, a rulebook detail view with attestation types,
schema references, provenance, standards-compatibility disclosure, version history and
deterministic version comparison, a credential validation playground that calls the real
`POST /api/v1/credentials/validate` API, and a draft editor for rulebook creation, metadata
editing, JSON/schema editing, live validation and the draft lifecycle (freeze, refresh,
readiness and publish). All views are clients of the public AttestBook API. The slice does
not add the import UI or a dedicated publication-export view; the extra publication export
endpoints delivered by #42 are public API reads (the detail view keeps its exact-snapshot
export link), and later follow-ups cover an import UI.

**Authoritative spec:** [`docs/specification.md`](specification.md) §14
(UI-001/UI-002/UI-005/UI-006), §11 (FR-019) and §2.2 (independent standalone UI).
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
- a credential validation playground at `/playground`:
  - paste a credential artifact or load it from a local file;
  - select a rulebook, one of its versions and an attestation type, with an optional
    credential-format hint;
  - submit the real `POST /api/v1/credentials/validate` request and inspect the overall
    status, the eight FR-010 dimensions (status, applicability, execution, evidence and
    findings), the flattened violations, the explicit limitations and the schema references
    of the pinned version;
  - export the typed result as JSON, without the credential artifact or any claim value;
- the public `GET /api/v1/providers` read the catalog needs to show provider names, plus the
  existing public rulebook, attestation, schema-reference and version reads. These are
  additive `v1` public projections; publication authority, internal metadata, provenance
  and tokens are never returned;
- a draft editor at `/rulebooks/new` and `/rulebooks/<id>/edit` (#40):
  - metadata editing for name, description, source URL and applicable specification;
  - a developer-facing JSON editor for attestation types and per-attestation or
    rulebook-level schema references, with an immediate JSON syntax message;
  - live validation of the unsaved document against the real server: structural findings
    that block a save are shown separately from standards findings, and the validation
    boundaries are listed explicitly;
  - an explicit provider bearer-token field for the write. The token is held in the app's
    React memory for the current page session only, sent only in the `Authorization` header,
    and never written to browser storage, the URL or the rendered document;
  - creation of a new draft (one authenticated `POST /api/v1/rulebooks`) and full replacement
    of an existing draft (one authenticated `PUT /api/v1/rulebooks/<id>/draft`), followed by
    a persisted reload;
  - a read-only state for a published or historical rulebook, which the server also refuses
    to mutate. Editing never changes a frozen version snapshot or its content-addressed
    artifact;
  - an entry action on the catalog (`New rulebook`) and on the draft detail page
    (`Edit draft`);
- a deterministic version comparison panel on `/rulebooks/{id}` (#41):
  - two labelled version selects and an explicit `Compare` action; the public comparison
    endpoint returns JSON Pointer changes sorted by path, and snapshot identity fields are
    excluded so two labels with equal authored content compare as identical;
  - a table of path, change kind and before/after values, with explicit empty, loading and
    retryable error states;
- a mock-backed capture explorer at `/captures` and `/captures/<captureId>` (#48, UI-006):
  - the list shows one row per normalized capture with its source component and `mock`
    transport label, interaction and protocol, artifact type and credential format, capture and
    receipt times, correlation id, opaque test-execution reference, pinned rulebook version and
    validation status, and explicit evidence gaps;
  - the detail shows the normalized metadata, the source-declared redaction, the inline
    artifact only as its redacted default-policy projection (or an explicit "not fetched"
    notice for an external reference), the ordered evidence timeline and the explorer's
    limitations;
  - a validation form pins the capture to a real rulebook version and attestation type and runs
    the structural engine on the segregated inline artifact, then shows the linked findings;
    external, source-redacted and non-credential evidence state why they cannot be validated;
  - every view says that the evidence is mock-backed and that no live capture component is
    operational;
- a draft lifecycle and publication panel on `/rulebooks/{id}/edit` (#41):
  - the version history with status and digest, newest first;
  - authenticated `Freeze as draft version` with a typed label, `Refresh` of a draft
    snapshot, and `Check readiness` for a chosen draft version;
  - `Publish` is enabled only after the server's readiness checks for that exact draft
    version report ready; readiness checks and their limitations are shown individually;
  - the server's safe conflict and immutability messages are surfaced, and a successful
    transition updates the editor's read-only state without re-fetching the working copy;
  - creating a version from a published rulebook reopens the working copy for the next
    version while the published snapshot stays immutable.

Deliberately **not** in these slices:

- schema-document supply in the playground. The API accepts caller-supplied schema documents
  for the pinned references, but UI-005 does not require an editor for them, so schema
  validation is reported **not tested** unless a schema document is supplied through the
  API directly;
- a dedicated publication-export view beyond the existing exact-bytes link, and a publication
  signature. The #42 export artifact and manifest endpoints are public API reads; the UI only
  links the exact snapshot bytes, and OWF 0.5.4 does not support the TS11 catalogue-response
  JWS, so no signature is claimed. The remaining FR-008 publication work and the import UI
  (UI-003/UI-004 and a later import-UI issue) stay future slices. The comparison and
  readiness views make no conformance or publication claim of their own;
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
   snapshot bytes with `Content-Digest` and `ETag` so a consumer can verify the shown digest;
7. on `/playground`: `GET /api/v1/rulebooks?limit=100&offset=0` for the rulebook select, then
   `GET /api/v1/rulebooks/{id}/versions` and `GET /api/v1/rulebooks/{id}/attestations` for
   the dependent selects, one `POST /api/v1/credentials/validate` per run, and a client-side
   JSON download for the result;
8. on `/rulebooks/new`: no read is required; the editor validates the unsaved document with
   `POST /api/v1/rulebooks/validate-draft`, and `Create draft` performs one authenticated
   `POST /api/v1/rulebooks`;
9. on `/rulebooks/{id}/edit`: `GET /api/v1/rulebooks/{id}/draft` reads the editable document,
   live validation uses `POST /api/v1/rulebooks/validate-draft`, and `Save draft` performs one
   authenticated `PUT /api/v1/rulebooks/{id}/draft`;
10. on `/captures`: `GET /api/v1/captures?limit=100&offset=0`; the detail reads
    `GET /api/v1/captures/{captureId}` and, when a correlation is run,
    `POST /api/v1/captures/{captureId}/validate` with the selected rulebook, version and
    attestation type;
11. the lifecycle panel reads `GET /api/v1/rulebooks/{id}/versions` and
    `GET /api/v1/rulebooks/{id}/versions/{version}/publication-readiness`, and performs the
    authenticated `POST /api/v1/rulebooks/{id}/versions`, `.../{version}/refresh` and
    `.../{version}/publish` transitions;
12. the comparison panel calls
    `GET /api/v1/rulebooks/{id}/versions/{version}/compare?to={version}`; the result is
    rendered as returned and never re-derived client-side.

The client router uses real paths with the History API. The Bun server serves the built
entry document for `/`, `/rulebooks/*`, `/playground` and `/captures/*`; `/api/*` stays
separate and unknown non-UI paths keep the JSON not-found envelope. A deep link or a browser reload therefore
reaches the same view. Browser back/forward is handled with a `popstate` listener; in-page
links push a history entry. Modified clicks (new tab, copy address) keep the native anchor
behaviour.

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

### 3.3 Credential playground

`/playground` is a developer view over the real validation API, not a mock result screen:

- the rulebook list comes from the public catalog page (maximum 100 entries); a notice says so
  when the API page is truncated and only the loaded rulebooks are selectable. A rulebook must
  be selected before its versions and attestation types are loaded, and a failed related read
  degrades to a retryable notice rather than hiding the page;
- the optional format hint offers auto-detection plus exactly the pinned TS11 formats
  (`dc+sd-jwt`, `mso_mdoc`, `jwt_vc_json`, `jwt_vc_json-ld`, `ldp_vc`);
- a credential can be pasted or read from a local text file. The file size is bounded at
  512 KiB before reading, and the pasted text is bounded client-side at the API's 512 KiB
  credential limit. Leading and trailing whitespace is removed and the artifact is otherwise
  sent unchanged in the POST body; it never enters a URL, browser storage, a log or the
  displayed result;
- required fields and the credential bound are checked in the browser before any request; an
  incomplete request sends nothing;
- the result shows the overall status, the eight FR-010 dimensions in normative order with
  their status, applicability, execution flag, evidence scope/reason/details and findings, the
  flattened violations (severity, dimension, code, JSON Pointer path, expected constraint and
  message), the explicit limitations list, the pinned rulebook version and recomputed digest,
  and non-sensitive credential facts (format, vct, disclosure count and key-binding presence);
- a permanent notice counts how many applicable dimensions did not execute and how many are
  not applicable, and the table states that neither is a pass; `Not tested` and `Not
  applicable` never reuse the pass styling;
- the schema references of the pinned version are listed with their integrity pin, detected
  kind and whether this run applied them. The playground supplies no schema documents, so the
  schema dimension stays **not tested** (see §6);
- `Export result (JSON)` downloads the typed result as a Blob named from the run identity. It
  contains the API result only: no credential artifact and no claim values.

API failures use the safe message of the product API error envelope (for example a `400`, `413`
or `503` message) and never echo the credential. An unexpected failure shows a generic message.
Retrying re-sends the entered request; editing the form clears a stale result so the report
cannot be mistaken for the new input. The page makes no validity claim beyond the returned
dimensions.

### 3.4 Rulebook draft editor

`/rulebooks/new` and `/rulebooks/<id>/edit` are the UI-003 authoring view for the #40 slice:

- the rulebook metadata form edits name, description, source URL and applicable
  specification. The JSON editor edits one document containing the `attestations` array (with
  each type's level of assurance, binding type, supported formats and schema references) and
  the rulebook-level `schemaReferences` array. An empty document is offered for a new draft
  and the current working copy is loaded for an existing one;
- the JSON is parsed locally on every change so a syntax error is shown immediately and
  prevents a save. All deeper checks are server-side: a 350 ms debounced
  `POST /api/v1/rulebooks/validate-draft` runs the registry's structural bounds and projects
  each attestation type into a TS11 v1.0.1 `SchemaMeta` document validated by the real
  standards adapter. Findings show severity, draft path, message and stable code, and the
  report's limitations are listed so the view never presents live validation as a
  conformance claim;
- `saveable` separates structural failures, which disable the save button, from
  standards-level findings, which are displayed but do not block persisting a work-in-progress
  draft (the registry stores profile enumerations as extensible text, decision D-5). An
  unknown `applicableSpec` reports that no standards checks ran instead of validating it
  against the wrong baseline;
- the provider bearer token is entered in a password field. It is held only in the app's
  React memory for this page session, so navigating to another view and back keeps it but a
  reload clears it. It is sent only as the `Authorization` header of the write request. A
  missing token, a foreign provider's token and a published rulebook's mutation each produce
  the API's safe error message; nothing is saved on failure;
- a published or historical rulebook opens read-only with an explanation, and the server
  independently answers `409 immutable`, so the UI cannot bypass the guarantee. A successful
  save reports that frozen and published versions were not changed; the test suite verifies
  the exact published snapshot bytes and digest are identical before and after a working-copy
  edit;
- the page reuses the catalog/detail shell, a skip link, labelled fields with
  `aria-describedby`, an error summary with `role="alert"`, a live `role="status"` validation
  summary and table semantics for the findings. It is covered by component tests and a
  Playwright spec that runs against the real server, including a full axe-core scan and a
  390 px viewport check. The version comparison and lifecycle panels are covered by their own
  component tests and the lifecycle Playwright spec; a dedicated publication-export view and
  a publication signature are not exposed here (the #42 export endpoints are API-level).

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
- the credential playground: catalog loading/error/empty states, dependent version and
  attestation loading, related-read failure and retry, client-side required-field and
  credential-bound checks that send no request, request construction (trimmed artifact and
  optional format wrapper), success rendering of all eight dimensions with executed/
  not-executed and applicable/not-applicable labels, the untested-dimensions notice,
  limitations, individual violations, safe API error display without the credential, retry,
  file upload and oversized-file rejection, export of the typed JSON without the credential,
  clear-form behaviour and axe-core checks for the form and result;
- the draft editor: JSON parse/serialize/request helpers; loaded working-copy population;
  debounced live validation with structural errors disabling save and standards warnings
  keeping it available; immediate JSON-syntax feedback; authorized save with the token;
  missing-token handling without a write; create-and-navigate; read-only published state;
  the memory-only token field; axe-core checks for the editor page;
- the mock-backed capture explorer: loading, error and retry, empty and truncation states, the
  normalized summary columns and evidence gaps, the redacted projection (never the raw claim
  values), external and source-redacted evidence refusals, non-credential evidence, the
  correlation form and its complete-selection rule, a successful correlation rendering the
  linked findings, safe correlation errors, responsive labels, the shared header navigation and
  axe-core checks (`ui/src/CapturesPage.test.tsx`, `ui/src/CaptureDetailPage.test.tsx`,
  `ui/src/capture.test.ts`);
- the router: path parsing (including `/playground`, `/captures`, `/captures/<id>`,
  `/rulebooks/new` and `/rulebooks/<id>/edit`), encoded ids, malformed paths, history
  navigation and modified clicks keeping native anchor behaviour;
- an end-to-end component navigation test from the catalog to a detail page and back, from
  the catalog to the new-rulebook editor, and a direct deep-link render of both editors;
- axe-core accessibility checks for the catalog results/error states and the detail page and
  not-found state (colour contrast is disabled in jsdom because it cannot compute painted
  colours; the browser tests run the full rule set).

Browser tests (`ui/e2e/catalog.spec.ts`, `ui/e2e/detail.spec.ts`, `ui/e2e/editor.spec.ts`,
`ui/e2e/lifecycle.spec.ts`, `ui/e2e/playground.spec.ts`, Playwright + Chromium):

- seven seeded rulebooks from the real registry/API, including the published validation-smoke
  rulebook used by the playground, with provider, version, status,
  attestation, source and compatibility content;
- search, provider and status filters, filtered-empty state and reset;
- delayed-API loading state, injected API error and successful retry;
- catalog → detail navigation, deep-link reload, back-to-catalog, detail metadata,
  attestations, schema references, provenance, compatibility labels, version history and
  export links;
- unknown-rulebook not-found state, detail loading and detail API error + retry;
- credential playground success against the real validation engine with a freshly signed
  SD-JWT VC fixture, including the untested-dimensions notice, the dimension table and an
  exported JSON download that contains no credential artifact;
- a real validation `FAIL` with an individual attestation-constraint violation, an injected
  `503` error surfaced without leaking the credential and a successful retry, an incomplete
  request rejected in the browser with no API call, file upload validation and the exported
  report;
- the draft editor against the real server: live TS11 adapter findings as the JSON changes,
  immediate invalid-JSON feedback and a disabled save, an authorized save that persists the
  working copy, an unchanged published snapshot's exact bytes and `Content-Digest` after a
  working-copy edit, the API's `409 immutable` for a published rulebook, the read-only UI
  state, and an unchanged catalog total when the new-rulebook page renders;
- an authorized `Create draft` with the Source URL left empty, which must navigate to the new
  draft's editor and persist a `null` source URL; because this spec creates a rulebook in the
  one shared in-memory registry, the Playwright suite runs with one worker and catalog specs
  run before it;
- full axe-core scans and 390 px viewport checks for the catalog, detail, playground and
  editor views.

The capture explorer is covered by `ui/e2e/captures.spec.ts`: the eight seeded mock captures,
the mock labelling and explicit gaps, the redacted projection of one JSON fixture (and the
absence of its raw claim values), the external-reference and non-credential refusals, a real
correlation of the seeded signed SD-JWT VC against the `Validator Sandbox Rulebook` with the
structural findings and the exact pinned version, full axe-core scans of the list and detail,
and a 390 px no-horizontal-overflow check.

CI adds the `ui` job: `typecheck:ui`, `test:ui`, Chromium installation and `test:e2e`. The
`build` job verifies `dist/ui/index.html` exists and the Docker job checks that `/` serves
the catalog HTML.

The pull request for the draft-editor slice carries the required before/after captures at
1280 px and the same light theme. The baseline is `c35e160` (`main` before the slice):

- [before: `editor-before-catalog.png`](ui/editor-before-catalog.png) — the catalog has no
  authoring action;
- [before: `editor-before-detail.png`](ui/editor-before-detail.png) — the draft detail page
  has no edit action;
- [after: `editor-after-catalog.png`](ui/editor-after-catalog.png) — the catalog's
  `New rulebook` action;
- [after: `editor-after-detail.png`](ui/editor-after-detail.png) — the draft detail page's
  `Edit draft` action next to the version export;
- [after: `editor-after-new.png`](ui/editor-after-new.png) — the new-rulebook editor with
  metadata fields, the JSON editor, the token field and validation boundaries;
- [after: `editor-after-edit.png`](ui/editor-after-edit.png) — an existing draft loaded into
  the editor with a real live-validation warning;
- [after: `editor-after-validation.png`](ui/editor-after-validation.png) — real TS11 adapter
  findings with severity, draft path, message and stable code, kept separate from the
  save-able warning;
- [after, narrow viewport: `editor-after-mobile.png`](ui/editor-after-mobile.png) — the same
  editor at 390 px.

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

The pull request for the playground slice carries the same-viewport (1280 px) and theme
comparison for the new view:

- [before: `playground-before-catalog.png`](ui/playground-before-catalog.png) — baseline
  `f8a107a` (`main` before the playground slice): the shared header has no playground
  navigation;
- [before: `playground-before-404.png`](ui/playground-before-404.png) — the same baseline
  requesting `/playground`: the real server returns the JSON not-found envelope;
- [after: `playground-after-catalog.png`](ui/playground-after-catalog.png) — this slice: the
  header links to the new view;
- [after: `playground-after-form.png`](ui/playground-after-form.png) — the request form with a
  rulebook, version, attestation type and credential selected;
- [after: `playground-after-result.png`](ui/playground-after-result.png) — a real run against
  the seeded validation engine with the overall status, untested-dimensions notice, dimension
  table, violations and limitations;
- [after, narrow viewport: `playground-after-mobile.png`](ui/playground-after-mobile.png) — the
  same result at 390 px.

The pull request for the lifecycle and comparison slice carries the required before/after
captures at 1280 px and the same light theme, against the same seeded API state. The
baseline is `327a5a2` (`main` before the slice):

- [before: `lifecycle-before-detail.png`](ui/lifecycle-before-detail.png) — the baseline
  detail page ends at the version history and has no comparison panel;
- [after: `lifecycle-after-detail.png`](ui/lifecycle-after-detail.png) — the same rulebook
  with the deterministic `Compare versions` panel and the `/name` change between `1.0` and
  `1.1`;
- [before: `lifecycle-before-editor.png`](ui/lifecycle-before-editor.png) — the baseline
  editor shows the working copy and live validation but no lifecycle controls;
- [after: `lifecycle-after-editor.png`](ui/lifecycle-after-editor.png) — the same editor with
  the `Draft lifecycle and publication` panel, the `0.1` version row and the readiness
  checks for that draft.

The pull request for the capture-explorer slice carries the required before/after captures at
1280 px and the same light theme, against the same seeded API state. The baseline is `ebd09cb`
(`main` before the slice):

- [before: `captures-before-catalog.png`](ui/captures-before-catalog.png) — the baseline
  catalog's shared header has no capture-explorer entry;
- [before: `captures-before-404.png`](ui/captures-before-404.png) — the same baseline
  requesting `/captures`: the real server returns the JSON not-found envelope;
- [after: `captures-after-catalog.png`](ui/captures-after-catalog.png) — this slice: the header
  links to the new view;
- [after: `captures-after-list.png`](ui/captures-after-list.png) — the mock-labelled capture
  list with every artifact type, its source, correlation and test-execution references, and
  the explicit evidence gaps;
- [after: `captures-after-detail-before-validation.png`](ui/captures-after-detail-before-validation.png)
  — one capture's normalized metadata, full-redaction evidence notice, explicit gaps and
  timeline before any correlation;
- [after: `captures-after-detail.png`](ui/captures-after-detail.png) — the same capture after
  correlating the real signed SD-JWT VC with the `Validator Sandbox Rulebook` `1.0`, showing
  the pinned digest, the structural findings and the recorded validation in the timeline;
- [after, narrow viewport: `captures-after-mobile.png`](ui/captures-after-mobile.png) — the same
  explorer list at 390 px with labelled cards and no horizontal scrolling.

The catalog and detail slices' captures remain in the same directory
([`catalog-before.png`](ui/catalog-before.png),
[`catalog-after.png`](ui/catalog-after.png),
[`catalog-after-mobile.png`](ui/catalog-after-mobile.png),
[`detail-before-catalog.png`](ui/detail-before-catalog.png),
[`detail-before-404.png`](ui/detail-before-404.png),
[`detail-after-catalog.png`](ui/detail-after-catalog.png),
[`detail-after.png`](ui/detail-after.png),
[`detail-after-mobile.png`](ui/detail-after-mobile.png)).

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
- The detail view stays a read-only projection and only links to the draft editor. Version
  comparison is a public read; lifecycle writes live in the editor's publication panel.
  A dedicated publication-export view beyond the exact-bytes link, a publication signature
  and the remaining FR-008 publication work remain later slices; the #42 export endpoints are
  public API reads, and readiness is not a conformance claim.
- UI responses set `X-Content-Type-Options: nosniff` and Vite assets are immutable-cached;
  a content security policy and the rest of the HTTP hardening remain
  [issue #35](https://github.com/ForkbombEu/credimi-attestbook/issues/35).
- The playground supplies no schema documents, so schema validation remains **not tested**;
  a caller can still supply them through the API directly. Adding a schema-document editor is
  a later slice.
- The rulebook selector is the Phase 1 API page (maximum 100 entries); a truncation notice
  names the loaded and total counts, and there is no pagination control yet.
- The attestation-type select comes from the public working-copy attestation read. The
  editor can now change the working copy after a version is frozen, so the types a draft
  offers may differ from those of an older pinned version. A version-scoped attestation read
  is still needed before the playground can restrict a pinned version to the types that
  snapshot actually contains.
- Validation runs are not persisted. The exported JSON is the per-run result the API returned;
  there is no run history, comparison or saved-result list.
- The format hint covers the pinned TS11 format vocabulary, but only `dc+sd-jwt` has a
  structural parser; other formats are recognised or reported and never mocked as parsed.
- The draft editor's standards checks implement the TS11 v1.0.1 baseline only. An
  `applicableSpec` outside it is checked structurally with an explicit "no standards checks
  ran" warning instead of being validated against the wrong profile. The projection uses the
  source URL as the rulebook URI and a fixed placeholder when none is set; trusted
  authorities, the draft version label and the schema bodies are not edited or fetched. A
  saved draft is not a conformance result.
- The editor holds the provider bearer token in React memory only, so a full page reload
  clears it; it is never written to browser storage. There is no login or session endpoint.
  The save is a last-write-wins full replacement with no optimistic-concurrency token, so two
  open editor tabs can overwrite each other's working copy. The lifecycle panel surfaces the
  server's stale-snapshot, duplicate-label and immutability conflicts, and publish stays
  disabled until readiness passes for that exact draft version, but there is still no
  optimistic-concurrency token for the working copy itself.
- The capture explorer is deliberately mock-backed and in-memory: it shows deterministic local
  fixtures, never a live `capture-issuer`/`capture-verifier` interaction, and a recorded
  correlation is lost on restart. External artifact references are not fetched, a captured
  presentation submission is not unpacked into a credential, and only the latest correlation is
  kept per capture. The explorer page shows the first 100 captures.
- No dark theme or offline cache; routing covers the catalog, detail, playground, capture
  explorer, new-draft and edit-draft views, and any other path falls back to the catalog.
