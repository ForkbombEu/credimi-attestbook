# Rulebook catalog, detail and credential playground UI

**Status:** Phase 1 implementation of
[issue #36](https://github.com/ForkbombEu/credimi-attestbook/issues/36) (UI-001),
[issue #37](https://github.com/ForkbombEu/credimi-attestbook/issues/37) (UI-002),
[issue #38](https://github.com/ForkbombEu/credimi-attestbook/issues/38) (UI-005), the
draft-editor slice of [issue #40](https://github.com/ForkbombEu/credimi-attestbook/issues/40)
(UI-003), the lifecycle/comparison slice of
[issue #41](https://github.com/ForkbombEu/credimi-attestbook/issues/41) (UI-003), the
mock-backed capture explorer of [issue #48](https://github.com/ForkbombEu/credimi-attestbook/issues/48)
(UI-006, FR-019), the session-auth migration of
[issue #91](https://github.com/ForkbombEu/credimi-attestbook/issues/91), the hosted schema
controls of [issue #100](https://github.com/ForkbombEu/credimi-attestbook/issues/100) and the
hosted/external schema provenance of
[issue #103](https://github.com/ForkbombEu/credimi-attestbook/issues/103). It delivers
a responsive, searchable catalog of rulebooks, a rulebook detail view with attestation types,
schema references, provenance, standards-compatibility disclosure, version history and
deterministic version comparison, a credential validation playground that calls the real
`POST /api/v1/credentials/validate` API, and a draft editor for rulebook creation, metadata
editing, JSON/schema editing, live validation and the draft lifecycle (freeze, refresh,
readiness and publish). All views are clients of the public AttestBook API. The slice does
not add the import UI or a dedicated publication-export view; the extra publication export
endpoints delivered by #42 are public API reads (the detail view keeps its exact-snapshot
export link), and later follow-ups cover an import UI.

The administrator sign-in slice of
[issue #90](https://github.com/ForkbombEu/credimi-attestbook/issues/90) adds a `/login`
screen, a session-aware shared header and client-side session restoration from
`GET /api/v1/auth/me`. [Issue #91](https://github.com/ForkbombEu/credimi-attestbook/issues/91)
moves the rulebook editor, its lifecycle panel and the capture correlation to that session:
those writes send the HttpOnly cookie and the session-bound `X-CSRF-Token`, the authoring
actions are gated on the session, and an anonymous deep link or an expired write shows a
sign-in prompt that keeps unsaved editor state. Provider bearer authentication stays in the
API for headless clients.

The API-reference slice of
[issue #126](https://github.com/ForkbombEu/credimi-attestbook/issues/126) adds a public
`/docs` page. It is a separate Vite entry document, not a route in the catalog SPA router: it
renders Scalar from assets bundled with the application and reads the generated same-origin
`/openapi.json`, so it needs no session and no third-party CDN. It documents the product API
only, not the TS11 catalogue API.

The product-guide slice of
[issue #130](https://github.com/ForkbombEu/credimi-attestbook/issues/130) adds a public,
Markdown-backed guide at `/guide` and a direct, reloadable `/guide/<slug>` page. The Markdown
is repository-owned (`docs/guides/*.md`) and bundled at build time, so the guide needs no
session, no API read and no remote host. It stays separate from the API reference at `/docs`
and the canonical `/openapi.json`.

The documentation-navigation slice of
[issue #131](https://github.com/ForkbombEu/credimi-attestbook/issues/131) makes that guide
discoverable from the shared header and gives the guide pages a documentation layout. The
header's `Guides` item uses the client router and marks the current guide view with
`aria-current="page"`; the separate `API reference` item points at `/docs` with a full page
load and a distinct outlined treatment. `/guide` adds a breadcrumb back to the catalog and an
API-reference panel, and `/guide/<slug>` adds a sidebar generated from the same
`GUIDE_DOCUMENTS` registry. The standalone Scalar page at `/docs` keeps its existing
reference and gains a small branded documentation header with links back to the catalog and
the guides. No guide or Scalar content is moved or reimplemented.

The concepts/quick-start slice of
[issue #132](https://github.com/ForkbombEu/credimi-attestbook/issues/132) adds two pages to that
same bundled guide: `docs/guides/concepts.md` defines the provider, rulebook, attestation type,
schema reference, draft, published/historical version, immutable snapshot, content digest and
structural-validation vocabulary, and `docs/guides/quick-start.md` walks an anonymous reader
from the catalog through one exact version to the credential playground. Both pages are
registered in `ui/src/guide.ts` and appear automatically in the index cards and the article
sidebar; no renderer, route, API or layout code changes, and both pages link only to routes the
application already serves (`/`, `/rulebooks/<rulebookId>`, `/playground`, `/docs`,
`/guide/<slug>`).

**Authoritative spec:** [`docs/specification.md`](specification.md) §14
(UI-001/UI-002/UI-005/UI-006), §15 (authentication and authorization), §11 (FR-019) and §2.2
(independent standalone UI).
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
    attestation type, with format identifier, source, safe http(s)-only URI, media type,
    SHA-256 digest, SRI integrity pin and a download link;
  - a **Hosted by AttestBook** row is derived from the exact stored-document association
    returned by the API (never from a URL prefix): it shows the immutable hosted URI, the
    stored media type and digest, and whether the persisted SRI pin identifies those bytes.
    Every other value stays an **External URL** and is never fetched just to render the view;
  - source provenance: the source URL (or "locally authored") and registry timestamps;
  - standards-compatibility disclosure: the rulebook is always **Not tested**, and each
    FR-010 evaluation dimension states whether this build supports it per credential, has
    not tested it, or cannot apply it;
  - version history, newest first, with label, status, specification, SHA-256 content
    digest, creation/publication dates and an export of each exact immutable snapshot;
  - **Inspect references** on each version reads the exact frozen snapshot and shows its
    schema references grouped by attestation type plus rulebook-level references, with the
    same hosted/external provenance, the version label and the pinned content digest;
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
  - session-gated writes: the view reads the administrator session and sends the HttpOnly
    cookie with the session-bound `X-CSRF-Token`; it never asks for, stores or sends a provider
    bearer token. An anonymous deep link shows a sign-in panel whose validated `next` target
    returns to the editor, and an expired session keeps the unsaved form and shows an inline
    re-sign-in form;
  - creation of a new draft (one session-authenticated `POST /api/v1/rulebooks`) and full
    replacement of an existing draft (one session-authenticated
    `PUT /api/v1/rulebooks/<id>/draft`), followed by a persisted reload;
  - a read-only state for a published or historical rulebook, which the server also refuses
    to mutate. Editing never changes a frozen version snapshot or its content-addressed
    artifact;
  - entry actions on the catalog (`New rulebook`) and on the detail page (`Edit draft` for a
    draft, `Create new version` for a published rulebook), shown only for an authenticated
    session bound to the owning provider;
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
  - a session-authenticated validation form pins the capture to a real rulebook version and
    attestation type and runs the structural engine on the segregated inline artifact, then
    shows the linked findings. The form sends the session cookie and `X-CSRF-Token`; anonymous
    readers see a sign-in prompt instead and no request is sent. External and non-credential
    evidence (and, defensively, source-declared redaction) state why it cannot be validated;
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
    version while the published snapshot stays immutable. The published rulebook's detail page
    offers **Create new version**, and the editor opens in a next-version flow whose
    **Create new version** action calls the same lifecycle endpoint, reopens the working copy
    in place without a reload and never publishes anything;
- an administrator sign-in screen at `/login` (#90):
  - a username/password form with submit, working and error states and no bearer-token field;
  - the auth client restores the session from `GET /api/v1/auth/me` on every load, treats an
    anonymous `401` as no session, and relies only on the server's HttpOnly session cookie:
    no `localStorage`, `sessionStorage` or bearer token is read or written;
  - the shared header shows the signed-in provider identity with a `Log out` action, or a
    `Log in` link that preserves the current path; logout is a same-origin
    `POST /api/v1/auth/logout` carrying the session-bound `X-CSRF-Token` returned by the auth
    responses, so the browser's `Origin`/`Sec-Fetch-Site` evidence and the token satisfy the
    server's CSRF check;
  - after sign-in the browser returns to a validated same-origin `next` destination; absolute,
    protocol-relative, backslash and off-origin targets are refused;
  - catalogue, rulebook detail, playground, capture-explorer reads and the public API stay
    usable anonymously; the editor, lifecycle and capture-correlation writes are the
    session-gated actions.
- a public interactive API reference at `/docs` (#126):
  - the page is a separate static Vite entry served anonymously at `/docs` and `/docs/`,
    with its JS and CSS bundled into `dist/ui/assets` and Scalar's remote fonts disabled;
  - it renders the canonical same-origin `/openapi.json` with Scalar and lists the generated
    operations, request/response schemas and declared authentication schemes;
  - no cookie, CSRF token, bearer token or provisioning secret is embedded in the page.
- a public Markdown-backed product guide at `/guide` and `/guide/<slug>` (#130):
  - `/guide` lists the bundled pages and `/guide/<slug>` renders one document with headings,
    paragraphs, ordered and unordered lists, inline links and fenced code;
  - the Markdown is repository-owned (`docs/guides/<slug>.md`), registered with its slug,
    title and description in `ui/src/guide.ts`, and inlined into the Vite build with `?raw`;
    the page never reads a filesystem path, a remote host or an API record;
  - the registered title is the page `h1` and the document body starts at `##`; adding a
    guide means adding its Markdown file and one registry entry;
  - embedded raw HTML stays literal text, and only root-relative, `http(s)` and `mailto`
    destinations become links; a `javascript:` or `data:` destination stays text;
  - a root-relative link to a route the SPA draws uses the in-app router, while a link to a
    page the server sends (`/docs`, `/openapi.json`) does a full page load, so the guide's
    API-reference link opens the Scalar page instead of the catalog fallback;
  - an unregistered slug shows an accessible guide not-found view and never falls back to
    the catalog. `/docs`, `/openapi.json` and the versioned API are untouched.
- product-guide and API-reference navigation (#131):
  - the shared `SiteHeader` carries a `Guides` link on the catalog, detail, playground,
    editor, capture and guide views; it uses the client router and marks
    `aria-current="page"` on `/guide` and `/guide/<slug>`;
  - the same header renders a separate, outlined `API reference` link with an arrow. It is a
    plain anchor to `/docs`, so the Scalar document gets a full page load instead of the SPA
    router falling back to the catalog;
  - `/guide` is a documentation landing page: a `Catalog / Guides` breadcrumb, guide cards in
    `GUIDE_DOCUMENTS` order and a separate API-reference panel. It needs no session;
  - `/guide/<slug>` places a persistent article sidebar beside the document. The sidebar lists
    `Guides overview`, every registered page and the separate API-reference block; the current
    page carries `aria-current="page"`, and the breadcrumb is `Catalog / Guides / <page>` so a
    reader can always return to the catalog or the index;
  - the landing cards, the sidebar and the page titles all derive from the single
    `GUIDE_DOCUMENTS` registry in `ui/src/guide.ts`; a later guide-only change adds its
    Markdown file and one registry entry, with no navigation component edit;
  - `/docs` keeps the existing standalone Scalar reference and adds only a small branded
    documentation header (`Catalog`, `Guides`, the current `API reference`) plus a skip link,
    giving a way back to the product. Scalar and `/openapi.json` are not embedded, moved or
    reimplemented. The docs entry does not load the SPA brand stylesheet, whose unlayered global
    rules would override Scalar's layered styles; its chrome stylesheet is scoped to the header
    and sets Scalar's `--scalar-custom-header-height` so Scalar's sticky sidebar and anchor
    offsets start below the header. At 640 px and below the header is static and that offset is
    reset;
  - wide screens keep the sidebar and API-reference panel sticky under the topbar; at 1000 px
    and below the layouts become a single column, so the sidebar becomes a keyboard-reachable
    list above the article at 390 px without horizontal scrolling. The shared header wraps its
    navigation at 960 px and lets the primary nav scroll horizontally, so the `Guides` and
    `API reference` links stay reachable at tablet widths.

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
   the public `POST /api/v1/rulebooks/validate-draft`, and `Create draft` performs one
   session-authenticated `POST /api/v1/rulebooks`;
9. on `/rulebooks/{id}/edit`: `GET /api/v1/rulebooks/{id}/draft` reads the editable document,
   live validation uses `POST /api/v1/rulebooks/validate-draft`, and `Save draft` performs one
   session-authenticated `PUT /api/v1/rulebooks/{id}/draft`;
10. on `/captures`: `GET /api/v1/captures?limit=100&offset=0`; the detail reads
    `GET /api/v1/captures/{captureId}` and, when a correlation is run,
    the session-authenticated `POST /api/v1/captures/{captureId}/validate` with the selected
    rulebook, version and attestation type;
11. the lifecycle panel reads `GET /api/v1/rulebooks/{id}/versions` and
    `GET /api/v1/rulebooks/{id}/versions/{version}/publication-readiness`, and performs the
    session-authenticated `POST /api/v1/rulebooks/{id}/versions`, `.../{version}/refresh` and
    `.../{version}/publish` transitions;
12. the comparison panel calls
    `GET /api/v1/rulebooks/{id}/versions/{version}/compare?to={version}`; the result is
    rendered as returned and never re-derived client-side;
13. on every view the session provider calls `GET /api/v1/auth/me` once; on `/login` the
    form posts `POST /api/v1/auth/login` with the username and password, and the header's
    `Log out` action posts `POST /api/v1/auth/logout` with the session CSRF token. The
    HttpOnly session cookie and its in-memory `X-CSRF-Token` are the only credentials
    involved, and no bearer token is read or written by these calls.

Every protected write in the client (create/save draft, freeze/refresh/publish a version and
record a capture correlation) is a same-origin fetch with `credentials: "same-origin"` and the
live session's `X-CSRF-Token` header, matching the server rule from #89. The UI never asks for,
stores or sends a provider bearer token; headless API clients keep using the bearer transport
documented in [`docs/security.md`](security.md) §2.

The client router uses real paths with the History API. The Bun server serves the built
entry document for `/`, `/rulebooks/*`, `/guide`, `/guide/*`, `/playground`, `/captures/*`
and `/login`, and the separate built `docs.html` for `/docs` and `/docs/`; `/api/*` stays
separate and unknown non-UI paths keep the JSON not-found envelope. A deep link or a browser
reload therefore reaches the same view, including a reload of an authenticated `/login` page,
of a guide page and of the API reference. A guide slug the bundle does not register renders the
guide not-found view; it is not treated as an unknown route, so it never looks like the
catalog. Browser back/forward is handled with a `popstate` listener; in-page links push
a history entry, and the router parses the pathname while preserving the login page's `next`
query string. Modified clicks (new tab, copy address) keep the native anchor behaviour.

The shared topbar links to the in-app guide with the client router (`Guides`, current on guide
routes) and to the standalone Scalar document with a plain `/docs` anchor, so the two kinds of
documentation stay distinct. The guide pages add `Catalog / Guides` (and, on an article,
`/ <page>`) breadcrumbs, and the separate `/docs` entry's own small header links back to `/`
and `/guide`; `/docs` itself remains a full page load in both directions.

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
- a **Schema references** card offers one row per attestation type and supported format, so
  multiple attestations and formats stay unambiguous. A row can add or replace
  `Upload/paste schema to AttestBook` or `Use existing external URL` (issue #100):
  - hosted mode accepts pasted text or a local `.json` file. A file is read as bytes and
    refused when it begins with a byte-order mark or is not valid UTF-8, so the text that is
    registered is the file's exact content. The browser checks the exact UTF-8 byte bound
    (256 KiB), parses the document, previews it as text without executing or fetching
    anything, and requires a JSON Schema 2020-12 object or boolean before the register button
    enables. Registration is `POST /api/v1/schema-documents?kind=json_schema_2020_12` with the
    session cookie, the `X-CSRF-Token` header and the exact document bytes; the returned
    canonical `url` and W3C SRI `integrity` become ordinary
    `schemaReferences[].uri`/`integrity` values in the Draft JSON;
  - external mode records an absolute `https` URL and an optional W3C SRI value without any
    upload or registration call; both modes replace the existing reference for the same
    attestation format instead of duplicating it, and a remove action edits the same JSON;
  - each row names its source from the API's stored-document association, never from a URL
    prefix (issue #103). A hosted row shows the document kind, stored media type, SHA-256
    digest, a download link and whether the persisted SRI pin matches; an external row stays
    **External URL**. The association is kept beside the raw Draft JSON, which continues to
    contain only `formatIdentifier`, `uri` and `integrity`;
  - every insertion or removal edits the existing Draft JSON text (preserving unknown
    members, including unrecognised members of references on other formats) and marks the
    form dirty, so it follows the ordinary save path. Registration is asynchronous while the
    Draft JSON stays editable: the reference is applied to the latest text, never the
    click-time copy, and a changed attestation name refuses the insert while keeping the
    registered URL and SRI visible. A published or historical rulebook renders the rows
    read-only, and an expired session keeps the pasted document mounted behind the inline
    **Sign in again** form so registration can be retried;
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
- the view is protected by the administrator session: an anonymous deep link renders a
  **Sign in to author rulebooks** panel with a `Sign in` link whose validated `next` value is
  the current editor path. The form is not rendered and no draft is read until
  `GET /api/v1/auth/me` confirms an authenticated session. The catalogue's **New rulebook**
  action and the detail view's **Edit draft**/**Create new version** actions appear only when
  the session is authenticated and bound to the owning provider;
- draft and lifecycle writes send the HttpOnly session cookie and its in-memory
  `X-CSRF-Token` only; there is no provider-token field to paste and no `Authorization`
  header. A `401` or a `403 csrf_failed` keeps the form mounted, shows an inline **Sign in
  again** form and preserves every unsaved field so the user can re-authenticate and save
  without losing work. A `403 forbidden` is an ownership refusal, not an expired session, so
  it shows the server's safe message without a re-sign-in prompt; a published rulebook's
  mutation still surfaces its safe error message. Nothing is saved on failure;
- a published rulebook's editor opens in a next-version flow: the page names the published
  status, requires a typed label and offers one **Create new version** action for the existing
  lifecycle endpoint. The server validates the label and rejects a duplicate as a
  conflict; the error is shown with the typed label kept, and a repeated submit sends at most
  one request. Creation reopens the working copy in place (no reload), keeps its metadata,
  attestations and schema references, and leaves the published bytes and digest untouched; the
  page then becomes the ordinary draft editor, and the lifecycle panel offers refresh,
  readiness and publish for the new draft version;
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

### 3.5 Administrator sign-in and session state

`/login` is the browser entry point for the optional, environment-configured administrator
delivered by #88; it is not a provider-bearer-token form:

- the page asks only for a username and a password. Required fields are checked in the
  browser first; while the request is in flight the button is disabled and the page states
  that it is verifying the credentials. A rejected request shows the product API's safe
  message (for example `Invalid username or password.`, the `429` rate-limit message or
  `503 auth_unavailable` when the server has no administrator configured), never a raw
  password or a token;
- the login request is same-origin JSON with credentials included. The server answers with an
  opaque, HttpOnly session cookie plus the session-bound CSRF token; the UI keeps that token
  in React memory only and stores no password, token or session material in `localStorage` or
  `sessionStorage`, and an expired or revoked cookie simply resolves
  `GET /api/v1/auth/me` to `401` and therefore to the anonymous state;
- the shared header renders the authenticated provider's name and a `Log out` button, or a
  `Log in` link. The link carries a `next` value for the current path so the visitor returns
  to the view they came from. `Log out` posts to `/api/v1/auth/logout` with the same-origin
  cookie and the live session's `X-CSRF-Token`; the browser supplies the
  `Origin`/`Sec-Fetch-Site` evidence the server checks, and the API's idempotent `204` then
  clears the local session state;
- after sign-in the browser navigates to the `next` value only when it resolves to a plain
  same-origin path. Absolute URLs, protocol-relative paths, backslash variants, control
  characters and normalised off-origin paths are dropped, so the form cannot be used as an
  open redirect; without a valid target it returns to the catalogue;
- the catalogue, rulebook detail, playground and capture explorer views remain reachable
  anonymously, and the public API reads keep working without a session. The authoring actions
  are session-gated as described in §3.4: **New rulebook**, **Edit draft**,
  **Create new version** and the protected capture correlation are hidden or replaced by a
  sign-in prompt when anonymous, and a direct editor URL renders the sign-in panel with the
  editor path as its `next` target;
- an expired session is detected when a write answers `401` (or `403 csrf_failed` after a
  session rotation). The editor and the capture correlation form keep their state and show an
  inline **Sign in again** form backed by the same auth API; a fresh sign-in clears the prompt
  and the user retries the write. Only those two answers trigger re-sign-in: a `403
  forbidden` ownership refusal keeps the server's message and does not ask for credentials
  that cannot help. The full `/login` page remains the destination for an anonymous deep
  link, so the same-origin return target is validated by the shared `safeRedirectPath`
  guard.

## 4. Build, serve and develop

```bash
bun run build        # API bundles + Vite build into dist/ui
bun run dev          # Bun API server; serves dist/ui when it exists
bun run dev:ui       # Vite dev server on :5173, /api proxied to :3000
bun run typecheck:ui # strict TypeScript for the UI, Vitest and Playwright configs
bun run test:ui      # Vitest component, logic and accessibility tests
bun run test:e2e     # Playwright against the real API with seeded data
```

`src/server.ts` serves `dist/ui/index.html` at `/`, Vite's content-addressed
files under `/assets/*`, the installed Credimi brand directory under `/brand/*`,
the same entry document for `/rulebooks/*`, `/guide`, `/guide/*`, `/playground`,
`/captures/*` and `/login` deep links, and the separate `dist/ui/docs.html` for `/docs`
and `/docs/`. When `dist/ui` is absent (a source checkout without a
UI build), the UI routes are not registered, so those paths keep the
JSON 404 instead of serving a broken page. The Dockerfile copies the `ui/`
sources before building, so the container serves the built UI from the same
origin as the API. The browser never uses a private backdoor. Because guide
Markdown is imported by the UI source, changing a guide requires a UI rebuild
(`bun run build:ui`).

### Brand assets and design checks

The UI adopts the Credimi Extras Template visual system. Its canonical assets are
installed byte-for-byte under `ui/public/brand/` and served unchanged at
`/brand/`:

- `/brand/style.css` — the Credimi brand stylesheet, loaded by `ui/index.html`
  before the application stylesheet;
- `/brand/fonts/InterVariable.ttf` and
  `/brand/fonts/SourceCodeProVariable.ttf` — the self-hosted families with their
  SIL OFL 1.1 licences;
- `/brand/logos/*.svg` — the four canonical Credimi logos; the mark is also the
  favicon, linked directly from `/brand/logos/credimi_logo.svg`.

No web asset is loaded from an external CDN, and the two banners mandated by
`DESIGN.md` §13 are rendered by the shared layout on every route.
`ui/src/brand.test.ts` pins the canonical logo and font bytes and fails if any
stylesheet or entry document starts loading an external asset.

Impeccable provides the design vocabulary and the anti-slop detector. Version
4.8.2 (engine 0.1.21, Apache-2.0, from
<https://github.com/pbakaus/impeccable>) is installed for the project under
`.dsh/skills/impeccable/` (with `PRODUCT.md`, `DESIGN.md` and
`.impeccable/config.json` as its project context), and
`bun run lint:design` runs the mechanical detector over `ui/src`. CI runs the
same command in the `quality` job, so a UI change that trips a design
anti-pattern does not merge. `.impeccable/config.json` records the two
deliberate brand exceptions: the overused-font rule for the self-hosted Inter
brand face, and the generic `kicker-above-heading` rule, because `DESIGN.md` §6
mandates the Credimi eyebrow pattern above every page heading.

### Visual comparison

`docs/ui/brand/` holds the before/after captures for the brand restyle, taken
from the seeded end-to-end server at 1440×1000 (and 390×844 for the mobile
catalog). The baseline is the pre-restyle application; the after set is the
Credimi-branded application with the same fixtures and viewport:

| View | Before | After |
| --- | --- | --- |
| Rulebook catalog | `brand/catalog-before.png` | `brand/catalog-after.png` |
| Rulebook catalog (mobile) | `brand/catalog-mobile-before.png` | `brand/catalog-mobile-after.png` |
| Rulebook details | `brand/detail-before.png` | `brand/detail-after.png` |
| Credential playground | `brand/playground-before.png` | `brand/playground-after.png` |
| Capture explorer | `brand/captures-before.png` | `brand/captures-after.png` |
| Draft editor | `brand/editor-before.png` | `brand/editor-after.png` |
| New-rulebook editor | `brand/editor-new-before.png` | `brand/editor-new-after.png` |

The per-attestation schema controls (issue #100) have their own pair, taken from the
seeded end-to-end server at 1280×1000 with the same Payment Account draft, theme and
signed-in administrator. The baseline is the editor before the controls existed; the after
set adds the **Schema references** card and the hosted preview state:

| State | Before | After |
| --- | --- | --- |
| Payment Account draft editor | `editor-schema-before.png` | `editor-schema-after.png` |
| Hosted schema form with a valid preview | — | `editor-schema-after-form.png` |

The hosted/external schema provenance slice (issue #103) has before/after captures at
1280×1000 in the same light theme, taken from the seeded end-to-end server with the same
mixed hosted/external PID rulebook, the same signed-in administrator and the same viewport.
The baseline is `908b4c9` (`main` before the slice); the after images are from this PR's
head. The same hosted document, external reference, version `1.0` and draft are present in
both revisions, so only the provenance presentation differs. The baseline run used the
same disposable seed through a test-only copy of the seed script; no baseline application
source was changed.

| View | Before (`908b4c9`) | After (this slice) |
| --- | --- | --- |
| Rulebook details: schema references | [`detail-before.png`](ui/schema-provenance/detail-before.png) | [`detail-after.png`](ui/schema-provenance/detail-after.png) |
| Version history: exact version references | [`version-before.png`](ui/schema-provenance/version-before.png) | [`version-after.png`](ui/schema-provenance/version-after.png) |
| Draft editor: schema rows | [`editor-before.png`](ui/schema-provenance/editor-before.png) | [`editor-after.png`](ui/schema-provenance/editor-after.png) |

The next-version flow slice (issue #112) has before/after captures at 1280 px in the same light
theme, taken from the seeded end-to-end server with the same published version `1.0` of a
rulebook owned by the seeded `Example Issuer` and the same signed-in administrator. The
baseline is `31827ea` (`main` before the slice); the after images are from this PR's head. In
both revisions the administrator creates version `1.1.0` from the published rulebook (the
baseline through the lifecycle panel at the bottom of the read-only editor, this slice through
the detail-page action and the next-version panel), so only the workflow and its discoverability
differ.

| View | Before (`31827ea`) | After (this slice) |
| --- | --- | --- |
| Published rulebook details: next-version action | [`detail-before.png`](ui/new-version/detail-before.png) | [`detail-after.png`](ui/new-version/detail-after.png) |
| Published rulebook editor: next-version flow | [`editor-before.png`](ui/new-version/editor-before.png) | [`editor-after.png`](ui/new-version/editor-after.png) |
| Reopened editable working copy after creating `1.1.0` | [`created-before.png`](ui/new-version/created-before.png) | [`created-after.png`](ui/new-version/created-after.png) |

The product-guide slice (issue #130) has before/after captures at 1440×1000 in the same light
theme, taken from the seeded end-to-end server in an anonymous browser. The baseline is
`c865904` (`main` before the slice), where `/guide` and `/guide/introduction` answered the JSON
not-found envelope; the after images are from this PR's head and render the bundled guide index
and the Introduction document with the same seeded API data. The header, banners and footer
are the unchanged shared layout; the guide adds the page content and no other view changes.

| View | Before (`c865904`) | After (this slice) |
| --- | --- | --- |
| Guide index (`/guide`) | [`guide-before.png`](ui/guide/guide-before.png) | [`guide-after-index.png`](ui/guide/guide-after-index.png) |
| Introduction (`/guide/introduction`) | [`introduction-before.png`](ui/guide/introduction-before.png) | [`introduction-after.png`](ui/guide/introduction-after.png) |

The documentation-navigation slice (issue #131) has before/after captures at 1440×1000 in the
same light theme, taken from the seeded end-to-end server in an anonymous browser. The baseline
is `aa6a780` (`main` after the guide slice, before this slice), which renders the same catalog,
guide pages and Scalar reference without documentation navigation; the after images are from
this PR's head. Both revisions use the same seeded data and viewport, and the narrow pair uses
390×844. The catalog pair shows the shared header change (a `Guides` item and the outlined
`API reference` link), the guide pairs show the landing panel, the article sidebar, the
breadcrumbs and the active page, and the `/docs` pair shows the new documentation header over
the unchanged Scalar reference.

| View | Before (`aa6a780`) | After (this slice) |
| --- | --- | --- |
| Catalog header | [`catalog-before.png`](ui/guide-navigation/catalog-before.png) | [`catalog-after.png`](ui/guide-navigation/catalog-after.png) |
| Guide index (`/guide`) | [`guide-index-before.png`](ui/guide-navigation/guide-index-before.png) | [`guide-index-after.png`](ui/guide-navigation/guide-index-after.png) |
| Introduction (`/guide/introduction`) | [`guide-introduction-before.png`](ui/guide-navigation/guide-introduction-before.png) | [`guide-introduction-after.png`](ui/guide-navigation/guide-introduction-after.png) |
| Introduction, 390 px | [`guide-introduction-narrow-before.png`](ui/guide-navigation/guide-introduction-narrow-before.png) | [`guide-introduction-narrow-after.png`](ui/guide-navigation/guide-introduction-narrow-after.png) |
| API reference (`/docs`) | [`docs-before.png`](ui/guide-navigation/docs-before.png) | [`docs-after.png`](ui/guide-navigation/docs-after.png) |

The API-integration guide slice (issue #137) adds one repository-owned Markdown page to the
existing guide, so it changes no renderer, route or layout. The before/after captures are at
1440×1000 in the same light theme, taken from the seeded end-to-end server in an anonymous
browser. The baseline is `1299235` (`main` after the capture-explorer guide), where the guide
index lists the Introduction and Capture explorer and `/guide/api-integration` renders the
guide's not-found view; the after images are from this PR's head and show the new index card
and the rendered API-integration page. Both revisions use the same seeded data and viewport,
and only the guide content differs.

| View | Before (`1299235`) | After (this slice) |
| --- | --- | --- |
| Guide index (`/guide`) | [`guide-index-before.png`](ui/api-integration/guide-index-before.png) | [`guide-index-after.png`](ui/api-integration/guide-index-after.png) |
| API integration (`/guide/api-integration`) | [`api-integration-before.png`](ui/api-integration/api-integration-before.png) | [`api-integration-after.png`](ui/api-integration/api-integration-after.png) |

The publication-events guide slice (issue #136) has before/after captures at 1440×1000 in the
same light theme, taken from the seeded end-to-end server in an anonymous browser. The baseline
is `16afaef` (`main` after the API-integration guide, before this slice), where `/guide` listed
the Introduction, Capture explorer and API integration cards and `/guide/publication-events`
rendered the guide not-found view. The after images are from this PR's head and show the
additional Publication events card and the rendered page over the same seeded data; the header,
sidebar and footer are unchanged.

| View | Before (`16afaef`) | After (this slice) |
| --- | --- | --- |
| Guide index (`/guide`) | [`guide-index-before.png`](ui/publication-events/guide-index-before.png) | [`guide-index-after.png`](ui/publication-events/guide-index-after.png) |
| Publication events (`/guide/publication-events`) | [`guide-page-before.png`](ui/publication-events/guide-page-before.png) | [`guide-page-after.png`](ui/publication-events/guide-page-after.png) |

The credential-validation guide slice (issue #135) has before/after captures at 1440×1000 in
the same light theme, taken from the seeded end-to-end server in an anonymous browser. The
baseline is `b52c606` (`main` after the publication-events guide), where the guide index lists
the Introduction, Capture explorer, API integration and Publication events cards and
`/guide/credential-validation` renders the guide's not-found view; the after images are from
this PR's head and show the same index with the new card and the rendered credential-validation
guide. No other view changes.

| View | Before (`b52c606`) | After (this slice) |
| --- | --- | --- |
| Guide index (`/guide`) | [`guide-before.png`](ui/credential-validation/guide-before.png) | [`guide-after.png`](ui/credential-validation/guide-after.png) |
| Credential validation (`/guide/credential-validation`) | [`page-before.png`](ui/credential-validation/page-before.png) | [`page-after.png`](ui/credential-validation/page-after.png) |

The credential-schemas guide slice (issue #134) has before/after captures at a 1440×1000 viewport
in the same light theme, taken from the seeded end-to-end server in an anonymous browser. The
guide index is captured full-page so every guide card stays visible. The baseline is `14a96cf`
(`main` after the documentation-navigation slice, before this slice), where `/guide` listed only
the Introduction card and `/guide/credential-schemas` rendered the guide not-found view. The
after images are from this PR's head and show the new Credential schemas card alongside the
existing guide cards and the rendered Credential schemas page over the same seeded data; the
header, sidebar and footer are unchanged.

| View | Before (`14a96cf`) | After (this slice) |
| --- | --- | --- |
| Guide index (`/guide`) | [`guide-index-before.png`](ui/credential-schemas/guide-index-before.png) | [`guide-index-after.png`](ui/credential-schemas/guide-index-after.png) |
| Credential schemas (`/guide/credential-schemas`) | [`guide-page-before.png`](ui/credential-schemas/guide-page-before.png) | [`guide-page-after.png`](ui/credential-schemas/guide-page-after.png) |

The concepts/quick-start guide slice (issue #132) has before/after captures at 1440×1000 in the
same light theme, taken from the seeded end-to-end server in an anonymous browser. The guide
index is captured full-page so every existing guide card stays visible; the article pages use
the viewport. The baseline is `2e62909` (`main` before this slice), where `/guide` lists the
seven existing guides without Concepts or Quick start and `/guide/concepts` and
`/guide/quick-start` render the guide's not-found view; the after images are from this PR's
head and show the two new cards and the rendered pages with the same seeded API data and
unchanged shared chrome. The guide index, renderer, route and article sidebar are unchanged;
only the registered page set and the Markdown content differ.

| View | Before (`2e62909`) | After (this slice) |
| --- | --- | --- |
| Guide index (`/guide`) | [`guide-index-before.png`](ui/concepts-quick-start/guide-index-before.png) | [`guide-index-after.png`](ui/concepts-quick-start/guide-index-after.png) |
| Core concepts (`/guide/concepts`) | [`concepts-before.png`](ui/concepts-quick-start/concepts-before.png) | [`concepts-after.png`](ui/concepts-quick-start/concepts-after.png) |
| Quick start (`/guide/quick-start`) | [`quick-start-before.png`](ui/concepts-quick-start/quick-start-before.png) | [`quick-start-after.png`](ui/concepts-quick-start/quick-start-after.png) |

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
- hosted/external schema provenance (#103): the stored-document association marks a
  reference **Hosted by AttestBook** with its kind, media type, SHA-256 digest and download
  link, a look-alike URL without an association stays **External URL**, a matching or
  missing SRI pin is reported explicitly, and the exact-version panel reads the frozen
  snapshot and shows the same provenance with the version label and content digest
  (`ui/src/detail.test.ts`, `ui/src/RulebookDetailPage.test.tsx`);
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
  keeping it available; immediate JSON-syntax feedback; session-authenticated save with the
  CSRF token and no bearer header; anonymous deep-link gating with the safe `next` target;
  inline re-sign-in after a `401` with the unsaved description preserved; create-and-navigate;
  read-only published state; absence of a bearer-token field; the API-derived hosted
  association and download/digest display, including a near-miss URL that stays external;
  the owner-only published-to-next-version flow with its typed label, duplicate, ownership
  and session errors, a single request on repeated submit and the in-place reopening of the
  working copy (`ui/src/RulebookDetailPage.test.tsx`,
  `ui/src/RulebookDraftEditorPage.test.tsx`); axe-core checks for the editor page;
- the mock-backed capture explorer: loading, error and retry, empty and truncation states, the
  normalized summary columns and evidence gaps, the redacted projection (never the raw claim
  values), external and non-credential evidence refusals, the correlation form and its
  complete-selection and anonymous sign-in gating, a successful session correlation rendering
  the linked findings, safe correlation errors including an expired session that keeps the
  selected rulebook/version/attestation, responsive labels, the shared header navigation and
  axe-core checks (`ui/src/CapturesPage.test.tsx`, `ui/src/CaptureDetailPage.test.tsx`,
  `ui/src/capture.test.ts`);
- the shared chrome: the Credimi Extras top and footer strips (text, the single
  `https://credimi.io` link with `target="_blank"` and `rel="noopener"`, wordmark
  alt text, DOM order), the header logo lockup, the anonymous `Log in` link and the
  authenticated identity/`Log out` controls, and axe-core checks
  (`ui/src/components/Layout.test.tsx`);
- the administrator session client (`ui/src/auth.test.ts`): `auth/me` session parsing
  including the CSRF token, anonymous `401`/missing-route handling, safe error messages,
  same-origin JSON login with no `Authorization` header, logout's same-origin `POST` with
  `X-CSRF-Token`, and the redirect guard rejecting absolute, protocol-relative, backslash,
  control-character and normalised off-origin `next` values;
- the session provider (`ui/src/session.test.tsx`): restoration from `auth/me`, the
  anonymous fallback for a missing or failed session, sign-in/sign-out transitions carrying
  the session CSRF token, and the stale-initial-read race guard;
- the administrator sign-in page (`ui/src/LoginPage.test.tsx`): username/password only (two
  inputs, no token field), client-side required-field checks that send nothing, the pending
  working state, safe API errors, intended-destination navigation, refusal of an off-site
  `next`, the authenticated identity view, logout, a failed logout, and axe-core checks;
- the router: path parsing (including `/playground`, `/captures`, `/captures/<id>`,
  `/guide`, `/guide/<slug>`, `/rulebooks/new`, `/rulebooks/<id>/edit` and `/login`), encoded
  ids and slugs, malformed paths, history navigation including a query-bearing login path,
  and modified clicks keeping native anchor behaviour;
- the product guide (`ui/src/guide.test.tsx`): the registered page conventions (unique
  URL-safe slugs, non-empty title/description, body starting at `##`), exact-slug resolution
  that refuses file paths, Markdown block and inline parsing, safe-link filtering
  (root-relative, `http(s)` and `mailto` accepted; script/data/protocol-relative/backslash
  destinations rejected), raw HTML staying inert text, heading/list/code/link rendering,
  in-app links using the client router while `/docs` gets a full page load, the index and
  deep-link views, the unknown-slug not-found view without a catalog fallback, the
  `Catalog / Guides` and `Catalog / Guides / <page>` breadcrumbs, the registry-derived guide
  cards and sidebar order, the current-page `aria-current`, the API-reference panel and
  sidebar links, the API-integration page's bearer-token and administrator-session sections
  with its `/openapi.json` and `/docs` links, the credential-validation page's no-over-claim
  and synthetic-data warnings with its named untested dimensions and its playground and
  API-document links, the credential-schemas page's hosted/external guidance, syntactically
  valid JSON example and catalog/API links, and axe-core checks for the guide index, every
  guide page and the not-found view;
- the shared header's documentation navigation (`ui/src/components/Layout.test.tsx`): the
  in-app `Guides` link, the plain `/docs` `API reference` link that the SPA router never
  handles, and `aria-current="page"` moving with the current view;
- a client-side navigation from the catalog to `/guide` and back through the guide
  breadcrumb, plus a deep-linked guide page with its sidebar (`ui/src/App.test.tsx`);
- an end-to-end component navigation test from the catalog to a detail page and back, from
  the catalog to the new-rulebook editor, from the catalog to the administrator sign-in
  page, a direct deep-link render of both editors and the login page, and a direct render of
  `/login?next=…` with the anonymous header sign-in link suppressed;
- axe-core accessibility checks for the catalog results/error states and the detail page and
  not-found state (colour contrast is disabled in jsdom because it cannot compute painted
  colours; the browser tests run the full rule set).

Browser tests (`ui/e2e/catalog.spec.ts`, `ui/e2e/detail.spec.ts`, `ui/e2e/editor.spec.ts`,
`ui/e2e/lifecycle.spec.ts`, `ui/e2e/playground.spec.ts`, `ui/e2e/auth.spec.ts`,
`ui/e2e/guide.spec.ts`, Playwright + Chromium):

- seven seeded rulebooks from the real registry/API, including the published validation-smoke
  rulebook used by the playground, with provider, version, status,
  attestation, source and compatibility content;
- search, provider and status filters, filtered-empty state and reset;
- every status chip keeps its label inside the pill on the catalog and the
  detail version history;
- delayed-API loading state, injected API error and successful retry;
- catalog → detail navigation, deep-link reload, back-to-catalog, detail metadata,
  attestations, schema references, provenance, compatibility labels, version history and
  export links;
- hosted and external references in the same published rulebook, the hosted content URL
  fetched anonymously with its media type, `Content-Digest` and immutable caching, and the
  exact published version's reference inspection with the same hosted provenance
  (`ui/e2e/detail.spec.ts`);
- unknown-rulebook not-found state, detail loading and detail API error + retry;
- credential playground success against the real validation engine with a freshly signed
  SD-JWT VC fixture, including the untested-dimensions notice, the dimension table and an
  exported JSON download that contains no credential artifact;
- a real validation `FAIL` with an individual attestation-constraint violation, an injected
  `503` error surfaced without leaking the credential and a successful retry, an incomplete
  request rejected in the browser with no API call, file upload validation and the exported
  report;
- the draft editor against the real server after signing in through `/login`: live TS11
  adapter findings as the JSON changes, immediate invalid-JSON feedback and a disabled save,
  a session-authenticated save that persists the working copy without a token field, an
  unchanged published snapshot's exact bytes and `Content-Digest` after a working-copy edit,
  the API's `409 immutable` for a published rulebook, the read-only UI state, and an unchanged
  catalog total when the new-rulebook page renders;
- anonymous authoring: `/rulebooks/new` shows the sign-in panel with the editor path as its
  `next` target, the catalog hides `New rulebook`, and the catalogue stays readable; clearing
  the session cookie before a save keeps the typed description in the editor and shows the
  inline **Sign in again** form;
- an authorized `Create draft` with the Source URL left empty, which must navigate to the new
  draft's editor and persist a `null` source URL; because this spec creates a rulebook in the
  one shared in-memory registry, the Playwright suite runs with one worker and catalog specs
  run before it;
- the published-to-next-version flow through the real UI: the detail page's owner-only
  **Create new version** action, the anonymous and other-provider restrictions with the API's
  `401`/`403`, a schema-reference replacement on the reopened working copy, refresh →
  readiness → publish, the previous version becoming historical with unchanged bytes and
  digest, and a duplicate label leaving the published artifact untouched
  (`ui/e2e/lifecycle.spec.ts`);
- the administrator login against the real server: sign-in from `/login`, the authenticated
  provider identity and logout control, an empty `localStorage`/`sessionStorage`, session
  restoration after a reload, logout back to anonymous with the seven-rulebook catalogue still
  usable, intended-destination navigation, refusal of an off-site `next`, the pending working
  state and the safe `401` message;
- full axe-core scans and 390 px viewport checks for the catalog, detail, playground, editor
  and login views.

The capture explorer is covered by `ui/e2e/captures.spec.ts`: the eight seeded mock captures,
the mock labelling and explicit gaps, the redacted projection of one JSON fixture (and the
absence of its raw claim values), the external-reference and non-credential refusals, a real
correlation of the seeded signed SD-JWT VC against the `Validator Sandbox Rulebook` with the
structural findings and the exact pinned version, the anonymous sign-in gating with the
capture path as its `next` target, full axe-core scans of the list and detail, and a 390 px
no-horizontal-overflow check.

The product guide is covered by `ui/e2e/guide.spec.ts` against the production Vite build: the
`/guide` index, following its Introduction link to `/guide/introduction` with the document
heading, body heading, code block and `/docs` link visible, following the API-integration card
to `/guide/api-integration` with its bearer-token and administrator-session sections, its
`/openapi.json` and `/docs` links and the served OpenAPI 3.1 document, following the
API-reference link to the full Scalar page, reloads that keep both guide deep links on the
same document, an accessible not-found view for an unknown slug with no catalog fallback, and
a request watcher asserting that reading the guide loads no third-party asset. The
credential-validation page added by #135 is covered by the same spec: opening it from the
index, the visible no-over-claim and synthetic-data warnings, the named untested dimensions in
their real report titles, the `/docs` and `/openapi.json` link targets and following its
playground link to `/playground`. The same spec covers the two #132 pages: the index cards
for `Core concepts` and `Quick start`, the `/guide/concepts` definitions with their `/`,
`/playground` and `/guide/quick-start` links and its reload, and the `/guide/quick-start`
journey whose `/playground` link reaches the public validation form (`Run validation` and the
`Rulebook` select enabled) without a sign-in page, plus axe-core scans and the
no-third-party-asset watcher for both. `ui/src/guide.test.tsx` covers the two registry
entries, the index cards, both pages' heading structure and their catalog, playground and
cross-guide links.

The credential-schemas guide (#134) is covered in the same spec: opening it from the index,
its hosted/external guidance, pin and JSON Schema sections, the catalog and `/docs` links, and
a 390 px check with no horizontal overflow and a full axe-core scan.

The documentation navigation (#131) is covered by the same spec and
`ui/e2e/docs.spec.ts`: opening `/guide` from the catalog's primary `Guides` link, the
`aria-current="page"` state on the header and sidebar, the `Catalog / Guides` breadcrumb back
to the catalog, the current guide page in the article sidebar, following the API-reference
link to the Scalar page and back through the reference's own `Guides` link, and a 390 px
check that keeps the sidebar keyboard focusable, the article readable and the page free of
horizontal scrolling with a full axe-core scan. The reference spec also asserts its
documentation header links to the catalog and the guides and marks `API reference` current; that
the docs entry loads no SPA brand stylesheet, so Scalar's section-header rules stay untouched;
that the sticky header's height is exposed to Scalar so its sidebar and search field stay below
the header after scrolling; and that `/docs` has no horizontal overflow at 390 px.

CI adds the `ui` job: `typecheck:ui`, `test:ui`, Chromium installation and `test:e2e`. The
`build` job verifies `dist/ui/index.html` exists and the Docker job checks that `/` serves
the catalog HTML.

The pull request for the administrator login slice carries the required before/after captures
at 1440×1000 (and 390×844 for the narrow views) in the same light theme, against the seeded
end-to-end server. The baseline is `162b441` (`main` before the slice, after the #88 backend
merge):

| View | Before (`162b441`) | After (this slice) |
| --- | --- | --- |
| `/login` | [`login-before.png`](ui/auth/login-before.png) — the real server answers the JSON `not_found` envelope | [`login-after.png`](ui/auth/login-after.png) — the accessible sign-in form with username and password only |
| `/login`, 390 px | [`login-before-mobile.png`](ui/auth/login-before-mobile.png) — the same JSON 404 | [`login-after-mobile.png`](ui/auth/login-after-mobile.png) — the same form at 390 px |
| Anonymous catalog header | [`catalog-before.png`](ui/auth/catalog-before.png) — no session control | [`catalog-after.png`](ui/auth/catalog-after.png) — the `Log in` link next to the navigation |
| Authenticated catalog header | no authenticated browser state existed | [`catalog-authenticated-after.png`](ui/auth/catalog-authenticated-after.png) — `Signed in: E2E Administrator` and `Log out` |
| Login error state | none (no login screen) | [`login-error-after.png`](ui/auth/login-error-after.png) — the API's generic `Invalid username or password.` message |

The session-auth migration (issue #91) carries these before/after captures at 1440×1000 in
the same light theme, against the seeded end-to-end server. The baseline is `dd7a9e8`
(`main` after #90, before this slice); the after images are from this PR's head. The
authenticated pair signs in through the real `/login` form as the same disposable
administrator (bound to the seeded `Example Issuer` provider) in both revisions, so only the
write-transport and session-gating difference is visible.

| View | Before (`dd7a9e8`) | After (this slice) |
| --- | --- | --- |
| Anonymous catalog | [`catalog-anonymous-before.png`](ui/session-auth/catalog-anonymous-before.png) — `New rulebook` is shown to everyone | [`catalog-anonymous-after.png`](ui/session-auth/catalog-anonymous-after.png) — the authoring action is session-gated |
| Anonymous `/rulebooks/new` | [`editor-new-anonymous-before.png`](ui/session-auth/editor-new-anonymous-before.png) — the editor renders with the provider bearer-token field | [`editor-new-anonymous-after.png`](ui/session-auth/editor-new-anonymous-after.png) — a sign-in panel with the editor path as the validated `next` target |
| Authenticated `/rulebooks/new` | [`editor-new-authenticated-before.png`](ui/session-auth/editor-new-authenticated-before.png) — the administrator session is signed in, but the form still asks for a bearer token | [`editor-new-authenticated-after.png`](ui/session-auth/editor-new-authenticated-after.png) — no token field; the session cookie and CSRF token authorize the write |
| Anonymous capture correlation | [`capture-correlation-before.png`](ui/session-auth/capture-correlation-before.png) — the correlation form asks for a provider token | [`capture-correlation-after.png`](ui/session-auth/capture-correlation-after.png) — a sign-in prompt replaces the token input and the action stays disabled |

The draft-editor slice's captures at 1280 px and the same light theme follow; the baseline is
`c35e160` (`main` before the slice):

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
- The hosted/external distinction is derived at read time from the configured
  `PUBLIC_BASE_URL` and the stored document association. If the public origin changes or is
  unset, a previously published hosted reference cannot be matched and is shown as an
  external URL even though its old content URL may still resolve; the UI never guesses from
  the URL shape to avoid a false provenance claim. The persisted draft, snapshot and TS11
  `SchemaMeta` still carry only the URI and optional pin.
- External schema references are shown as inert links with their recorded pin; the UI never
  fetches them merely to render or validate their content. A validity, availability or
  trust claim about an external document therefore requires a validation flow that was
  explicitly supplied those bytes.
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
- The editor and capture correlation now authenticate only with the administrator session.
  There is no password reset, account management or multi-user administration, and the
  session is still read on mount and after a reload rather than polled. An expiry is
  therefore detected by the next protected write (`401`/`403 csrf_failed`), which shows the inline
  re-sign-in prompt and keeps the form; a tab that only reads never notices its session
  ended. The save is a last-write-wins full replacement with no optimistic-concurrency
  token, so two open editor tabs can overwrite each other's working copy. The lifecycle panel
  surfaces the server's stale-snapshot, duplicate-label and immutability conflicts, and
  publish stays disabled until readiness passes for that exact draft version, but there is
  still no optimistic-concurrency token for the working copy itself.
- The inline re-sign-in form requests the administrator username and password again; it does
  not silently refresh a session, and a failed attempt leaves the unsaved form in place. A
  sign-out from the header while an editor has unsaved changes also keeps the form and offers
  the same prompt instead of discarding it.
- The capture explorer is deliberately mock-backed and in-memory: it shows deterministic local
  fixtures, never a live `capture-issuer`/`capture-verifier` interaction, and a recorded
  correlation is lost on restart. External artifact references are not fetched, a captured
  presentation submission is not unpacked into a credential, and only the latest correlation is
  kept per capture. The explorer page shows the first 100 captures.
- No dark theme or offline cache; routing covers the catalog, detail, playground, capture
  explorer, product guide, administrator sign-in, new-draft and edit-draft views, and any
  other path falls back to the catalog except a `/guide/<slug>` address, which shows the
  guide not-found view.
- The product guide is a fixed set of repository-owned Markdown pages registered in
  `ui/src/guide.ts`; there is no guide search or in-page table of contents, and editing a page
  requires rebuilding the UI. The guide cards and article sidebar both derive from that
  registry, but the standalone `/docs` header is part of its own Vite entry, so a future
  top-level navigation change must update it there as well as in the shared `SiteHeader`.
