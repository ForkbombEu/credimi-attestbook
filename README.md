# AttestBook

AttestBook is a standalone, API-first platform for managing, validating and testing
Attestation Rulebooks in the European Digital Identity Wallet ecosystem. This repository
currently contains the Phase 0 research and architecture documents plus the Phase 1
application scaffold.

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
bun run dev
```

`bun run dev` rebuilds on change and listens on `http://localhost:3000`. The first endpoint is
the health check:

```bash
curl --fail http://localhost:3000/health
# {"status":"ok","service":"attestbook","version":"0.1.0"}
```

## Checks

```bash
bun run check        # formatting, lint, strict typecheck and tests
bun run format:check # Prettier only
bun run lint         # ESLint only
bun run typecheck    # tsc --noEmit only
bun run test         # Bun test runner only
bun run docs:check   # Phase 0 documentation consistency, plain Node
```

`bun run check` is the same sequence the `quality` and `test` CI jobs run. Tests include:

- `src/app.test.ts` — health endpoint and JSON error envelope;
- `src/config.test.ts` — runtime configuration validation;
- `src/dependencies.test.ts` — no Credimi/Temporal/StepCI/PocketBase runtime dependency;
- `src/owf.test.ts` — the real pinned `@owf/eudi-attestation-schema` package builds and
  structurally validates a `SchemaMeta` document;
- `src/sqlite-smoke.test.ts` — Bun's built-in SQLite supports WAL and foreign keys, closing
  the Phase 0 verification gate for the persistence decision (D-7) before issue #28 builds
  the registry.

## Build and run

```bash
bun run build   # bundles src/server.ts into dist/server.js
bun run start   # serves the built bundle from dist/server.js
```

The bundle is self-contained for the current dependency set; the runtime image therefore
needs only Bun and `dist/`. Use `bun run dev` for source watching during development.

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
`/health`. It bakes in no secrets and runs no migration step yet; persistence arrives with
issue #28. CI builds the image, starts a container and verifies the `/health` and unknown-route
API round-trip, so the image is exercised on every pull request.

## Configuration

| Variable | Default   | Meaning                                       |
| -------- | --------- | --------------------------------------------- |
| `PORT`   | `3000`    | Listener port; an integer between 1 and 65535 |
| `HOST`   | `0.0.0.0` | Listener hostname or address                  |

Invalid values fail fast at startup instead of silently binding elsewhere.

## Mandatory OWF dependency

`@owf/eudi-attestation-schema` is pinned to exactly **0.5.4** (no range, no `0.6.0-alpha`)
and recorded in `bun.lock`. `src/owf.test.ts` executes the real package under Bun and asserts
the manifest, the installed version and its structural validation behaviour. The Phase 0 audit
probe remains reproducible from
[`research/owf-audit/`](research/owf-audit/README.md); the `owf-compat` CI job re-runs it on
Node.js 22 and Bun 1.3.1. Any upgrade must repeat the audit described in
[`docs/standards.md`](docs/standards.md).

`skipLibCheck` is enabled in `tsconfig.json` only because the pinned
`@sd-jwt/sd-jwt-vc` 0.24.1 declarations conflict with `exactOptionalPropertyTypes`.
Application code still uses `strict`, `exactOptionalPropertyTypes` and
`noUncheckedIndexedAccess`.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`:

| Job                 | Checks                                                     |
| ------------------- | ---------------------------------------------------------- |
| `quality`           | Prettier, ESLint, strict TypeScript typecheck              |
| `test`              | Bun tests, including the real OWF package and SQLite smoke |
| `build`             | Production bundle and bundle presence                      |
| `docker smoke`      | Image build, container startup, health and 404 round-trip  |
| `docs`              | Phase 0 document consistency and the checker's own tests   |
| `owf compatibility` | Phase 0 OWF probe on Node.js 22 and Bun 1.3.1              |

No job deploys, publishes an image or needs a secret or a live external service.

## Repository layout

```text
src/                application code and Bun tests
docs/               specification, architecture and Phase 0 documents
research/owf-audit/ reproducible audit probe for the pinned OWF package
scripts/            dependency-free documentation checker
Dockerfile          multi-stage runtime image
compose.yaml        local container definition
```
