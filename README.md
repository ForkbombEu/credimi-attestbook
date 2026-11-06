# AttestBook

AttestBook is a standalone, API-first platform for managing, validating and testing
Attestation Rulebooks in the European Digital Identity Wallet ecosystem. This repository
currently contains the Phase 0 research and architecture documents, the Phase 1 application
scaffold, the persistent provider/rulebook registry slice, the bounded URL/JSON rulebook
import slice, SD-JWT VC structural validation with dimension-aware evidence, the
versioned REST/OpenAPI contract over those services and the standalone UI: a searchable
rulebook catalog, rulebook detail/version history and a credential validation playground
(UI-001/UI-002/UI-005).

It is independent of Credimi's runtime: it does not require Temporal, StepCI, PocketBase, a
particular wallet, issuer or verifier, or any mandatory external service. See
[`docs/specification.md`](docs/specification.md) for the authoritative requirements and
[`docs/implementation-plan.md`](docs/implementation-plan.md) for the Phase 1 plan.

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
UI at `/`, `/rulebooks/<id>` and `/playground`, with the versioned API under `/api/v1`. Run
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
bun run test:e2e      # Playwright catalog, detail and playground tests against the real API
bun run openapi:check # generated OpenAPI 3.1 document validation
bun run docs:check    # Phase 0 documentation consistency, plain Node
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
- `src/api/` — the versioned REST/OpenAPI contract: generated-document validation against
  the official OpenAPI 3.1 schema, an exact comparison of documented operations with the
  routes Hono registered, success/error contract tests for every exposed resource, and
  HTTP-level write-authentication/provider-ownership tests; see [`docs/api.md`](docs/api.md)
  and [`docs/security.md`](docs/security.md);
- `src/app.validation.test.ts` — the typed `POST /api/v1/credentials/validate` contract,
  400/404/413/503 cases and non-disclosure of credential material;
- `src/sqlite-smoke.test.ts` — Bun's built-in SQLite supports WAL and foreign keys, closing
  the Phase 0 verification gate for the persistence decision (D-7);
- `ui/src/` — catalog, detail and playground data logic, API client and React component tests,
  including loading, error, empty, search/filter and axe-core accessibility states;
- `ui/e2e/` — Playwright browser tests against the real registry and API with seeded data,
  a full axe-core scan and a narrow-viewport layout check. See [`docs/ui.md`](docs/ui.md).

## Registry persistence and versions

The registry services in `src/registry/` store providers, rulebooks, attestation types, schema
references, provisional write tokens and an audit trail in a SQLite database. Writes are
authenticated with provider-scoped bearer tokens whose raw value is never stored, and every
mutation enforces provider ownership. Migrations live in `migrations/` and are applied by the
runner in `src/db/migrations.ts`; editing an already-applied migration is rejected by its
checksum.

A rulebook's content can be frozen as a draft version, then published. Each version stores the
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
publication; authenticated import preview and import; and credential validation. Successful responses use
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

| Variable                     | Default             | Meaning                                                             |
| ---------------------------- | ------------------- | ------------------------------------------------------------------- |
| `PORT`                       | `3000`              | Listener port; an integer between 1 and 65535                       |
| `HOST`                       | `127.0.0.1`         | Listener hostname or address                                        |
| `DATABASE_PATH`              | `attestbook.sqlite` | SQLite file opened at startup; `:memory:` is accepted for local use |
| `SCHEMA_SANDBOX_TIMEOUT_MS`  | `2000`              | Hard wall-clock limit for one schema-evaluation child               |
| `SCHEMA_SANDBOX_MAX_RSS_MB`  | `256`               | RSS limit for one schema-evaluation child                           |
| `SCHEMA_SANDBOX_CONCURRENCY` | `2`                 | Maximum concurrent schema-evaluation children                       |

Local development binds loopback only. The Docker image and `compose.yaml` set
`HOST=0.0.0.0` so the published port is reachable. Invalid values fail fast at startup
instead of silently binding elsewhere.

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
| `docs`              | Phase 0 document consistency and the checker's own tests             |
| `owf compatibility` | Phase 0 OWF probe on Node.js 22 and Bun 1.3.1                        |

No job deploys, publishes an image or needs a secret or a live external service.

## Repository layout

```text
src/                application code and Bun tests (api, registry, import, validation)
migrations/         ordered SQL schema migrations
docs/               specification, architecture, registry, validation and Phase 0 documents
research/owf-audit/ reproducible audit probe for the pinned OWF package
scripts/            dependency-free documentation checker
Dockerfile          multi-stage runtime image
compose.yaml        local container definition
```
