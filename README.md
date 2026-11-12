# AttestBook

AttestBook is a standalone, API-first platform for managing, validating and testing
Attestation Rulebooks in the European Digital Identity Wallet ecosystem. This repository
currently contains the Phase 0 research and architecture documents, the Phase 1 application
scaffold, the persistent provider/rulebook registry slice, the bounded URL/JSON rulebook
import slice, SD-JWT VC structural validation with dimension-aware evidence, the
versioned REST/OpenAPI contract over those services and the standalone UI: a searchable
rulebook catalog, rulebook detail/version history, a credential validation playground, a
rulebook draft editor (UI-001/UI-002/UI-005 and the working-copy slice of UI-003), a
mock-backed capture explorer with pinned-rulebook correlation (UI-006, FR-019), a
read-only headless-wallet comparison evidence report (FR-021) and reproducible
continuous-conformance results with stable result references (FR-022).

It is independent of Credimi's runtime: it does not require Temporal, StepCI, PocketBase, a
particular wallet, issuer or verifier, or any mandatory external service. See
[`docs/specification.md`](docs/specification.md) for the authoritative requirements,
[`docs/implementation-plan.md`](docs/implementation-plan.md) for the Phase 1 plan and
[`docs/acceptance-phase1.md`](docs/acceptance-phase1.md) for the Phase 1 acceptance report
and its outstanding limitations.

## Prerequisites

- [Bun](https://bun.sh/) **1.3.1** (runtime, package manager and test runner)
- Node.js **22** only for the dependency-free documentation check and the vendored OWF audit
  probe
- Docker with Compose (optional, for the container smoke test)

The tested baseline is Bun 1.3.1 on Linux x64. Other runtimes and architectures are not
claimed.

## Clean setup

```bash
git clone https://github.com/ForkbombEu/credimi-attestbook.git
cd credimi-attestbook
bun install --frozen-lockfile
bun run build
bun run dev
```

`bun run dev` rebuilds on change and listens on `http://localhost:3000`, serving the built
UI at `/`, `/rulebooks/<id>`, `/rulebooks/new`, `/rulebooks/<id>/edit`, `/playground` and
`/captures`, with
the versioned API under `/api/v1`. Run
`bun run build:ui` after UI changes, or use `bun run dev:ui` for Vite hot reload on port 5173
with `/api` proxied to the Bun server. The health check is:

```bash
curl --fail http://localhost:3000/health
# {"status":"ok","service":"attestbook","version":"0.1.0"}
```

## Checks

```bash
bun run check         # formatting, lint, server + UI typecheck, unit and component tests
bun run format:check  # Prettier only
bun run lint          # ESLint only
bun run typecheck     # server tsc --noEmit only
bun run typecheck:ui  # UI, Vitest and Playwright config typecheck only
bun run test          # Bun server test runner only
bun run test:ui       # Vitest UI unit, component and axe-core tests
bun run test:e2e      # Playwright catalog, detail, playground and capture tests against the real API
bun run acceptance    # Phase 1 end-to-end workflow; writes dimension-aware evidence
bun run openapi:check # generated OpenAPI 3.1 document validation
bun run docs:check    # documentation consistency, plain Node
```

`bun run check` is the same sequence the `quality` and `test` CI jobs run. Tests include:

- `src/app.test.ts` — health endpoint and JSON error envelope;
- `src/config.test.ts` — runtime configuration validation;
- `src/dependencies.test.ts` — no Credimi/Temporal/StepCI/PocketBase runtime dependency;
- `src/owf.test.ts` — the real pinned `@owf/eudi-attestation-schema` package builds and
  structurally validates a `SchemaMeta` document;
- `src/standards/` — canonical model, TS11 v1.0.1 and OWF 0.5.4 codecs, strict JOSE policy
  and SRI reference resolution, all exercised against the real package; see
  [`docs/standards-adapter.md`](docs/standards-adapter.md);
- `src/db/migrations.test.ts` — ordered SQL migrations apply from an empty database,
  checksums reject edited/unknown migrations and the schema enforces foreign keys,
  uniqueness and JSON-column constraints;
- `src/registry/` — provider provisioning, hashed bearer tokens, rulebook/attestation/schema
  reference CRUD, draft/published/historical versions with content-addressed snapshots,
  digests, persistence across a database reopen, cross-provider authorization denial and
  immutable published/historical state; see [`docs/registry.md`](docs/registry.md);
- `src/import/` — bounded `https`/JSON rulebook import with SSRF prevention, address
  pinning, redirect, time, size and JSON limits, catalog preview, conformance and compatibility
  reporting, provenance, and authenticated draft import; see [`docs/import.md`](docs/import.md);
- `src/validation/` — real SD-JWT VC parsing with `@sd-jwt/core`, Type Metadata and JSON
  Schema 2020-12 attribute checks, pinned-version/digest evidence, dimension statuses and a
  timeout/memory-bounded schema-evaluation sandbox; see
  [`docs/validation.md`](docs/validation.md);
- `src/fixtures/` — rulebook-driven issuer fixtures: deterministic unsigned claim payloads
  synthesized from integrity-verified JSON Schema 2020-12 references of a pinned version,
  effective attribute definitions, JSON-Pointer overrides and labelled negative cases each
  verified to fail the supplied documents; see [`docs/fixtures.md`](fixtures.md);
- `src/verifier/` — typed verifier constraints from integrity-verified JSON Schema
  references of a pinned version, with supported verifier-policy interfaces and an explicitly
  partial OpenID4VP DCQL mapping that reports every unexpressible constraint; see
  [`docs/verifier.md`](verifier.md);
- `src/capture/` — the versioned capture artifact envelope: bounded untrusted-input
  validation, secure external references, SHA-256 integrity, preserved provenance and
  correlation, segregated raw evidence and path-preserving redaction, typed push/pull
  adapter contracts, a deterministic offline mock source (only transport: `mock`) and the
  mock-backed explorer read model that correlates a captured issued credential with a pinned
  rulebook version; see [`docs/capture.md`](capture.md) §9;
- `src/integration/credimi/` — the standalone Credimi adapter: rulebook selection,
  exact-version pinning, version-pinned validation evidence, capture correlation,
  headless-wallet comparison and reproducible conformance runs over the public `/api/v1`
  API, with typed error codes, bounded timeouts/retries and real-server round-trip tests; see
  [`docs/credimi-integration.md`](credimi-integration.md);
- `src/comparison/` — the read-only headless-wallet comparison evidence: a versioned
  `attestbook.headless-wallet-comparison@1` report that links a correlated capture to its
  exact pinned rulebook version/digest, separates the AttestBook schema results from a
  caller-supplied external wallet observation and lists every unsupported dimension
  explicitly; see [`docs/headless-wallet-comparison.md`](headless-wallet-comparison.md);
- `src/conformance/` — reproducible continuous-conformance results: a deterministic
  `attestbook.conformance-result@1` with a canonical-JSON `inputDigest`, a content-addressed
  `resultReference`, stable failure classes and explicit version references, exposed by
  `POST /api/v1/conformance/runs` without scheduling or persisting a run; see
  [`docs/conformance.md`](docs/conformance.md);
- `src/api/` — the versioned REST/OpenAPI contract: generated-document validation against
  the official OpenAPI 3.1 schema, an exact comparison of documented operations with the
  routes Hono registered, success/error contract tests for every exposed resource, and
  HTTP-level write-authentication/provider-ownership tests; see [`docs/api.md`](docs/api.md)
  and [`docs/security.md`](docs/security.md);
- `src/app.validation.test.ts` — the typed `POST /api/v1/credentials/validate` contract,
  400/404/413/503 cases and non-disclosure of credential material;
- `src/sqlite-smoke.test.ts` — Bun's built-in SQLite supports WAL and foreign keys, closing
  the Phase 0 verification gate for the persistence decision (D-7);
- `ui/src/` — catalog, detail, playground and capture-explorer data logic, API client and
  React component tests, including loading, error, empty, search/filter and axe-core
  accessibility states;
- `ui/e2e/` — Playwright browser tests against the real registry and API with seeded data,
  a full axe-core scan and a narrow-viewport layout check. See [`docs/ui.md`](docs/ui.md);
- `src/acceptance/` — the Phase 1 end-to-end acceptance workflow: TS11 import, version
  inspection and publication, real SD-JWT VC validation, evidence export and the negative and
  non-conflation cases, run as a Bun test and by `bun run acceptance`. See
  [`docs/acceptance-phase1.md`](docs/acceptance-phase1.md).

## Registry persistence and versions

The registry services in `src/registry/` store providers, rulebooks, attestation types, schema
references, provisional write tokens and an audit trail in a SQLite database. Writes are
authenticated with provider-scoped bearer tokens whose raw value is never stored, and every
mutation enforces provider ownership. Migrations live in `migrations/` and are applied by the
runner in `src/db/migrations.ts`; editing an already-applied migration is rejected by its
checksum.

A rulebook's draft working copy (metadata, attestation types and schema references) can be
read and replaced as one document through `GET`/`PUT /api/v1/rulebooks/{id}/draft`; the
editor also validates an unsaved document through `POST /api/v1/rulebooks/validate-draft`.
Only a draft working copy can change, and a full replacement never mutates a frozen or
published version snapshot. A rulebook's content can be frozen as a draft version, then
published. Each version stores the
SHA-256 digest of its exact snapshot bytes in a content-addressed artifact, and published and
historical versions are immutable in the service and in SQLite triggers. Versions can be
retrieved by `(rulebookId, version)` or by content digest. Re-import conflict handling is
implemented by the import pipeline; the version-history UI comes in a later issue.

The server opens the registry database and applies migrations at startup, so credential
validation can read rulebooks from the same process. The versioned REST API exposes the
implemented registry, import and validation resources; its authentication, provider
ownership and secret-handling model is documented in
[`docs/security.md`](docs/security.md). The service contract, stable identifier rules,
standards-metadata boundary, authorization model and version lifecycle are documented in
[`docs/registry.md`](docs/registry.md).

## Versioned REST API and OpenAPI

The product API lives under `/api/v1` and is generated from a single route/schema source of
truth. It exposes public rulebook, attestation, schema-reference and version reads; the exact
version snapshot bytes with a verifiable digest; authenticated rulebook/version creation and
publication; authenticated import preview and import; authenticated issuer metadata
discovery; public issuer fixture generation; public verifier constraints with partial
OpenID4VP DCQL mappings; and credential validation. Successful responses use
a `{ "data": ... }` envelope and failures use a stable `{ "error": { "code", "message" } }`
envelope. Writes and the import preview require a provider bearer token.

`bun run openapi:check` validates the generated OpenAPI 3.1 document against the official
OpenAPI 3.1 schema, and the contract tests compare the documented operations with the routes
Hono actually registered. The `openapi` CI job runs that check on every pull request.
Versioning, idempotency, error mapping, resource paths and limitations are documented in
[`docs/api.md`](docs/api.md).

## Credential validation

`POST /api/v1/credentials/validate` validates a real SD-JWT VC artifact against one immutable
rulebook version and returns the pinned version/digest, per-dimension statuses, structured
violations with JSON Pointer paths and the reference `#integrity` result. The request selects
`rulebookId`, `rulebookVersion`, `attestationType` and the `credential`, and may carry the
exact schema document text for the pinned schema references:

```json
{
  "rulebookId": "<rulebook-id>",
  "rulebookVersion": "1.0",
  "attestationType": "PID",
  "credential": "<compact SD-JWT VC>",
  "schemaDocuments": [
    { "uri": "https://example.org/vct/pid", "content": "{\"vct\":\"https://example.org/vct/pid\"}" }
  ]
}
```

The structural dimensions (`credential_parsing`, `format_recognition`,
`schema_validation`, `attestation_constraints`) can pass; `cryptographic_verification` and
`issuer_trust` are returned `NOT_TESTED` and protocol/interoperability `NOT_APPLICABLE`, so a
structurally valid credential is never reported as fully valid or interoperable. Unsupported
formats are recognised and reported `NOT_TESTED` rather than mocked; JSON Schema keywords that
need unbounded regex/format evaluation (`format`, `pattern`, `patternProperties`,
`uniqueItems`, the legacy `dependencies` applicator, `$ref` and its variants) are reported
`NOT_TESTED` instead of executed; ambiguous `vct`/JSON Schema documents, unpinned references
and unresolved Type Metadata `extends` are not treated as validated.
Credential contents and claim values are never logged or returned. The response is wrapped
in `{ "data": ... }` like the other product-API successes. See
[`docs/validation.md`](docs/validation.md) for the contract, statuses, limits and non-claims.

## Issuer fixtures

`POST /api/v1/issuers/fixtures` synthesizes an **unsigned** credential claim payload from the
JSON Schema 2020-12 attribute constraints referenced by one pinned rulebook version. It is
not an issuer: the response carries `kind: "attestbook.unsigned-issuer-fixture@1"`,
`signed: false`, `issued: false` and an explicit limitations list. As with credential
validation, the caller supplies the exact schema document bytes; each URI must be a schema
reference of the selected attestation type in that version and its sha256 SRI value must
match before it grounds a payload. References without a verifiable pin, references without a
supplied document and Type Metadata references are reported, never silently used.

Schema compilation, payload synthesis and negative-case verification run in the same
resource-bounded sandbox as credential validation, so a hostile pinned schema cannot block the
HTTP event loop. The response contains the effective attribute definitions (JSON Pointer,
required flag, types and supported constraints), the generated payload, its validation against
the supplied documents, the applied JSON-Pointer overrides and deterministic, labelled
negative cases.
Each negative case is verified to fail before it is returned and carries a stable
`<category>:<path>` id. The supported synthesis subset, the unsigned boundary and the
non-claims (no signing, issuance, schema fetching, cryptography or interoperability) are
documented in [`docs/fixtures.md`](fixtures.md).

## Verifier constraints

`POST /api/v1/verifiers/constraints` returns the **typed attribute and format constraints** of
one pinned rulebook version and the verifier-policy interfaces AttestBook can map them to. It
is not an OpenID4VP endpoint: the DCQL mapping is an explicitly partial credential-query
fragment (`complete: false`) and the result carries `nonClaims` stating that no presentation
request, proof, cryptographic verification, trust decision or protocol result is produced.

As with credential validation and issuer fixtures, the caller supplies the exact JSON Schema
document bytes; each URI must be a schema reference of the selected attestation type and its
sha256 SRI value must match before its constraints are inspected. The response reports the
per-format grounding, typed attributes (JSON Pointer, required flag, types, extracted
constraints and DCQL claim paths), every unresolved JSON Schema keyword and every unsupported
mapping with a stable code and reason. Because the pinned snapshot stores no `vct`/`doctype`
or trusted authorities, DCQL `meta` and `trusted_authorities` are reported unsupported rather
than fabricated; Presentation Exchange is reported unsupported rather than guessed. See
[`docs/verifier.md`](verifier.md) for the contract, extraction subset, bounds and non-claims.

## Capture artifact envelope

`src/capture/` validates and normalizes untrusted capture evidence before any capture
transport exists. A versioned, closed envelope (`attestbook.capture-artifact@1`) carries
correlation and provenance metadata separately from the raw artifact: an inline artifact is
returned in a segregated `sensitive` field and never appears in the metadata envelope, while
an external `artifactRef` must be a default-port `https` URL on a public host. Malformed,
ambiguous and unsupported submissions are rejected with stable codes and messages that do not
echo artifact bytes; the caller's `capturedAt` text and correlation identifiers are preserved
verbatim and normalization adds only `receivedAt`. SHA-256 integrity covers the exact raw
bytes (recomputed for inline evidence, explicitly unverified for external references), and
partial/full redaction keeps only an allow-listed set of non-personal protocol members while
replacing every other scalar with path-preserving placeholders.

`src/capture/adapters/` exposes the push and pull contracts around that envelope
(`CaptureSource`, `CapturePullAdapter`, `CapturePushAdapter`) and one implementation,
`MockCaptureSource`: deterministic synthetic fixtures for every artifact type, opaque paging
cursors, `captureId` idempotency, hashed bearer-credential authorization that fails closed,
and simulated transport faults for deterministic error tests. It contacts no network endpoint
and labels every result `transport: "mock"`. This is not a live
`capture-issuer`/`capture-verifier` integration: real connectors must wait for those
components' actual APIs.

`src/capture/explorer.ts` is the FR-019/UI-006 read model over that mock evidence. It joins
one normalized artifact with its source-declared redaction, the opaque correlation and test
execution references and, once recorded, the exact pinned rulebook version and digest plus the
structural validation findings. The explorer never returns the raw inline artifact — the API
exposes only the redacted default-policy projection — and it names external, source-redacted,
unbound and unvalidated evidence as explicit gaps instead of treating absence as a pass. The
pinned-rulebook correlation runs the real structural engine on a captured issued credential and
refuses evidence it cannot validate honestly. Storage, fetching, persistence and a live
component integration remain later issues. See [`docs/capture.md`](capture.md) §9 and
[`docs/ui.md`](ui.md).

## Credimi integration adapter

`src/integration/credimi/` is the FR-020/AC-15 client Credimi uses to consume AttestBook over
HTTP: list rulebooks, select an attestation type, pin one exact version and its snapshot
digest, request structural validation, read the dimension-aware evidence and correlate a
capture with an opaque test-execution reference. The adapter reads no AttestBook database and
has no Temporal, StepCI or PocketBase dependency; every response is parsed against the API's
own schema and every pinned response is checked against the pin, with typed failures for
contract drift, stale pins, timeouts and transient server errors. The contract, error codes,
retry/timeout bounds and non-claims are documented in
[`docs/credimi-integration.md`](credimi-integration.md).

## Headless-wallet comparison evidence

`src/comparison/` and `POST /api/v1/captures/{captureId}/compare` provide the FR-021
AttestBook-side evidence for a headless-wallet comparison. The read-only report links a
correlated capture to the exact pinned rulebook version and snapshot digest, carries the
AttestBook structural/schema evidence, and places an optional caller-supplied external wallet
observation next to it in separate schema, protocol, interoperability and trust groups. Every
dimension AttestBook does not execute or cannot establish is explicit in
`comparison.unsupported`, and an external observation never becomes an AttestBook status. No
wallet is started or observed and no Credimi execution is orchestrated. The contract, bounds
and non-claims are documented in
[`docs/headless-wallet-comparison.md`](headless-wallet-comparison.md).

## Reproducible continuous-conformance results

`src/conformance/` and `POST /api/v1/conformance/runs` provide the FR-022 result for
recurring rulebook checks driven by external orchestration. A run executes the real
structural engine against one exact pinned rulebook version and returns an
`attestbook.conformance-result@1`: a canonical-JSON `inputDigest` over the pin, credential
and supplied schema documents; a content-addressed `resultReference` over that input and the
structural evidence; stable failure classes; the exact version/digest/specification
references; and explicit non-claims. Repeating the same pinned run reproduces both digests,
while a changed credential, schema document, snapshot or evidence changes them; a run cut
short by a schema-sandbox/runtime condition reports `deterministic: false` and its
`environmentConditions` for retry. AttestBook schedules no recurrence and persists no run, so
external orchestration owns the run history.
See [`docs/conformance.md`](conformance.md) and
[`docs/credimi-integration.md`](credimi-integration.md) §3.5.

## Safe URL and JSON import

The service-level import pipeline in `src/import/` retrieves a supported TS11/OWF rulebook
or catalog JSON document from an `https` URL or accepts it as JSON bytes, validates every
entry through the real standards adapter, and returns a preview with structural diagnostics,
conformance classification, a compatibility report and provenance (final source URL,
retrieval time, exact-bytes SHA-256 digest and the source's own conformance claim).
`RulebookImporter.import` authenticates the provider, refuses a source with any incompatible
entry, and creates draft rulebooks with their attestation types and schema references.

Remote retrieval is untrusted-input code: https-only, DNS/SSRF address checks with address
pinning, redirect re-validation, request and total timeouts, response-size and JSON shape
limits, bounded catalog entries and schema-reference fan-out. Schema references are
retained but not fetched or SRI-verified in this slice, and re-import/conflict handling is
implemented. The HTTP preview route requires a provider token because a URL preview performs
a bounded outbound fetch; rate limiting remains future hardening work. See
[`docs/import.md`](docs/import.md) for the full contract, limits and limitations.

## Rulebook UI

The catalog at `/` is a standalone React client of the public API: it lists rulebook name,
description, provider, latest version and version count, publication status, supported
attestation types, source, last-updated date and compatibility status, with text search plus
provider and status filters. It has loading, error/retry, empty-catalogue and no-match states,
and is responsive and keyboard accessible. Compatibility is always shown as **Not tested**;
the catalog does not infer validation, trust or interoperability results. The implementation,
data flow, accessibility checks, pinned UI stack and limitations are documented in
[`docs/ui.md`](docs/ui.md).

The credential playground at `/playground` calls the real structural validation API for a
selected rulebook version and attestation type. A credential can be pasted or read from a
local file; the result shows the overall status, every FR-010 dimension with its
applicability, execution, evidence and findings, the individual violations, the explicit
limitations, and exports the typed JSON result. Untested and not-applicable dimensions are
never presented as a pass, and the credential is never exported.

## Build and run

```bash
bun run build   # bundles the server, schema worker and Vite UI into dist/
bun run start   # serves dist/server.js, including dist/ui at /
```

The bundle is self-contained for the current dependency set; `bun run build` emits
`dist/server.js`, the sandbox child at `dist/validation/schema-sandbox-entry.js` and the UI
under `dist/ui/`, so the runtime image needs only Bun and `dist/`. Use `bun run dev` for
source watching during development and `bun run dev:ui` for the Vite UI dev server.

## Docker

```bash
docker build --tag attestbook:local .
docker run --rm --publish 3000:3000 attestbook:local
```

Or with Compose:

```bash
docker compose up --build --wait
```

The image is multi-stage, runs as the non-root `bun` user and defines a `HEALTHCHECK` against
`/health`. It bakes in no secrets. The server opens the SQLite database and applies migrations
at startup; the image stores it at `/data/attestbook.sqlite` and Compose mounts a named volume
there. CI builds the image, starts a container and verifies the `/health`, the built catalog
page at `/`, the empty rulebook-catalogue and unknown-route API round-trips, so the image is
exercised on every pull request.

## Configuration

| Variable                       | Default             | Meaning                                                             |
| ------------------------------ | ------------------- | ------------------------------------------------------------------- |
| `PORT`                         | `3000`              | Listener port; an integer between 1 and 65535                       |
| `HOST`                         | `127.0.0.1`         | Listener hostname or address                                        |
| `DATABASE_PATH`                | `attestbook.sqlite` | SQLite file opened at startup; `:memory:` is accepted for local use |
| `SCHEMA_SANDBOX_TIMEOUT_MS`    | `2000`              | Hard wall-clock limit for one schema-evaluation child               |
| `SCHEMA_SANDBOX_MAX_RSS_MB`    | `256`               | RSS limit for one schema-evaluation child                           |
| `SCHEMA_SANDBOX_CONCURRENCY`   | `2`                 | Maximum concurrent schema-evaluation children                       |
| `VALIDATION_CACHE_MAX_ENTRIES` | `64`                | Maximum parsed immutable rulebook snapshots cached in-process       |
| `VALIDATION_CACHE_MAX_MB`      | `16`                | Maximum snapshot bytes cached in-process                            |
| `ADMIN_USERNAME`               | unset               | Browser administrator username; the group is all-or-nothing         |
| `ADMIN_PASSWORD_HASH`          | unset               | Argon2id PHC hash of the administrator password, never plaintext    |
| `ADMIN_PROVIDER_ID`            | unset               | Identifier of an existing provider the administrator is bound to    |

Local development binds loopback only. The Docker image and `compose.yaml` set
`HOST=0.0.0.0` so the published port is reachable. Invalid values fail fast at startup
instead of silently binding elsewhere.

## Administrator browser login

AttestBook has a minimal single-administrator login for the browser. It is optional and
separate from the provider bearer-token API: login never creates a provider, never mints or
returns a provider token and never stores one in the session. The public catalogue,
validation and download reads stay anonymous, and existing `Authorization: Bearer` writes
keep working unchanged.

Set the following three variables together; a partial group is invalid and the login
answers `503 auth_unavailable` while the rest of the server keeps working. The administrator
is bound to an **existing** provider, so provision the provider first (the Docker image
starts with an empty database and an operator provisions providers out of band).

```bash
# Generate a strong Argon2id hash; Bun is the pinned runtime.
ADMIN_PASSWORD_HASH="$(bun -e 'console.log(await Bun.password.hash(process.env.ADMIN_PASSWORD))')"

export ADMIN_USERNAME='attestbook-admin'
export ADMIN_PASSWORD_HASH
export ADMIN_PROVIDER_ID='<existing provider id>'
```

The login endpoints are:

- `POST /api/v1/auth/login` with `{"username": "...", "password": "..."}` sets the opaque
  session cookie. The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, has an eight-hour
  absolute lifetime and is marked `Secure` when the request is HTTPS (directly or through a
  TLS-terminating proxy that sets `X-Forwarded-Proto: https`).
- `GET /api/v1/auth/me` returns the authenticated provider's public projection and the
  session expiry, or `401` when there is no live session.
- `POST /api/v1/auth/logout` revokes the server-side session and expires the cookie.

Only a SHA-256 hash of the session identifier is stored in `admin_sessions`; the raw value
exists only in the browser cookie. Every successful login mints a new identifier and retires
the one the browser presented, and logout revokes the row server-side. Login failures are
rate limited (five per account and twenty per client address in fifteen minutes), answer the
same generic `401` for an unknown username and a wrong password, and never log credentials.
Login and logout reject a cross-site `Origin`/`Sec-Fetch-Site`; login additionally requires
`Content-Type: application/json`. Plain HTTP on loopback is the supported local test mode
(the cookie is then not `Secure`); deploy behind HTTPS in any other environment.

The UAT sandbox provisions this test-only configuration itself: `bun scripts/uat-setup.ts`
creates a disposable SQLite database, provisions the existing test provider, generates a
fresh Argon2id hash for the fixed test password and writes `dist/uat/admin.env`, which
`scripts/uat-start.sh` sources. The test username is `uat-admin` and the test password is
`uat-test-password`; neither is a committed secret or a production credential.

## Mandatory OWF dependency

`@owf/eudi-attestation-schema` is pinned to exactly **0.5.4** (no range, no `0.6.0-alpha`)
and recorded in `bun.lock`. `package.json` `overrides` pin its audited transitive tree
(`@sd-jwt/sd-jwt-vc` 0.24.1, `@sd-jwt/core` 0.24.1, `@owf/crypto`/`@owf/identity-common`/
`@owf/cose`/`@owf/token-status-list` 0.6.2 and `zod` 4.6.7), so the application installs the
versions the Phase 0 audit exercised. `src/owf.test.ts` executes the real package under Bun
and asserts the manifest, the installed package and transitive versions, and its structural
validation behaviour. The Phase 0 audit probe remains reproducible from
[`research/owf-audit/`](research/owf-audit/README.md); the `owf-compat` CI job re-runs it on
Node.js 22 and Bun 1.3.1. Any upgrade must repeat the audit described in
[`docs/standards.md`](docs/standards.md).

The validation engine uses the pinned `@sd-jwt/core` 0.24.1 and `@sd-jwt/sd-jwt-vc` 0.24.1
parsers directly, plus Ajv 8.20.0 for JSON Schema 2020-12 instance validation. All three are
exact dependencies in `package.json` and `bun.lock`.

`skipLibCheck` is enabled in `tsconfig.json` only because the pinned
`@sd-jwt/sd-jwt-vc` 0.24.1 declarations conflict with `exactOptionalPropertyTypes`.
Application code still uses `strict`, `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess`.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`:

| Job                 | Checks                                                               |
| ------------------- | -------------------------------------------------------------------- |
| `quality`           | Prettier, ESLint, strict TypeScript typecheck                        |
| `test`              | Bun tests, including the real OWF package and SQLite smoke           |
| `openapi`           | Generated OpenAPI 3.1 document validation                            |
| `build`             | Production bundle and bundle presence                                |
| `docker smoke`      | Image build, container startup, health, catalogue and 404 round-trip |
| `ui`                | UI typecheck, component/axe tests and Playwright browser flows       |
| `acceptance`        | Phase 1 end-to-end workflow and dimension-aware evidence export      |
| `docs`              | Documentation consistency and the checker's own tests                |
| `owf compatibility` | Phase 0 OWF probe on Node.js 22 and Bun 1.3.1                        |

No job deploys, publishes an image or needs a secret or a live external service.

## Repository layout

```text
src/                application code and Bun tests (api, integration, registry, import, validation)
src/acceptance/     Phase 1 end-to-end acceptance workflow and evidence export
migrations/         ordered SQL schema migrations
docs/               specification, architecture, registry, validation and Phase 0 documents
research/owf-audit/ reproducible audit probe for the pinned OWF package
scripts/            dependency-free documentation checker
Dockerfile          multi-stage runtime image
compose.yaml        local container definition
```
