# AttestBook — Phase 1 Acceptance Report

**Status:** Phase 1 acceptance evidence for
[issue #39](https://github.com/ForkbombEu/credimi-attestbook/issues/39), produced from the
merged Phase 1 slices (#26–#38). The automated acceptance workflow is in
[`src/acceptance/workflow.ts`](https://github.com/ForkbombEu/credimi-attestbook/blob/main/src/acceptance/workflow.ts)
and
[`src/acceptance/workflow.test.ts`](https://github.com/ForkbombEu/credimi-attestbook/blob/main/src/acceptance/workflow.test.ts);
it is run in CI by the `acceptance` job in
[`.github/workflows/ci.yml`](https://github.com/ForkbombEu/credimi-attestbook/blob/main/.github/workflows/ci.yml).

This report records what was actually executed and what remains unverified. It makes **no
standards-conformance, security-certification or production-readiness claim** for AttestBook
or for any validator it does not run. The authoritative requirements are in
[`docs/specification.md`](specification.md); the Phase 1 exit criteria and issue mapping are in
[`docs/implementation-plan.md`](implementation-plan.md) §9–§10; the requirement-to-test record
is in [`docs/traceability.md`](traceability.md).

## 1. What was verified

The acceptance workflow drives the real application over its HTTP surface with a fresh
temporary SQLite database:

1. all checked-in migrations apply to an empty database;
2. the real `@owf/eudi-attestation-schema` 0.5.4 package validates an OWF `SchemaMeta`
   document and rejects a TS11-shaped document (OWF parsing is never treated as TS11
   validation);
3. an OWF 0.5.4 document previews as a structurally valid, `partial`-against-TS11 entry;
4. a valid EC TS11 v1.0.1 `SchemaMeta` document previews as `conformant_subset` with one
   pinned schema reference, and imports as a draft rulebook;
5. the draft's attestation type, level of assurance, binding type, supported format and
   schema reference (URI + W3C SRI `sha256` pin) are read back through the public API;
6. the working copy is frozen into version `1.0.0` and published; the exact snapshot bytes
   are downloaded and their SHA-256 is recomputed and compared with the published
   `contentDigest` and the `Content-Digest` header;
7. a real signed SD-JWT VC (issued at runtime with a throwaway key by
   `@sd-jwt/sd-jwt-vc`) is validated against that pinned version with the pinned JSON Schema
   document supplied, and the dimension-aware result is exported as JSON;
8. negative cases run against the same application: an attribute type violation, an
   unsupported credential format, a missing schema document and an invalid TS11 import;
9. the built UI entry document is required and is served for `/`, `/rulebooks/<id>` and
   `/playground`; `bun run acceptance` fails with a `ui.built` check when `dist/ui` is
   missing rather than skipping the UI evidence.

The workflow passed **112/112 checks** locally (`bun run acceptance`). It also runs as a
Bun test in the `test` CI job with `uiRoot: false` (the `test` job does not build the UI;
the workflow then records that the UI check was opted out and fails if a built UI is
missing when it is requested), and as the dedicated `acceptance` CI job after
`bun run build`, which verifies that the exported evidence recorded all three UI routes.

### 1.1 Dimension-aware validation evidence

For the structurally valid credential the exported result is:

| Dimension | Status | Applicable | Executed |
| --- | --- | --- | --- |
| `credential_parsing` | `PASS` | yes | yes |
| `format_recognition` | `PASS` | yes | yes |
| `cryptographic_verification` | `NOT_TESTED` | yes | no |
| `schema_validation` | `PASS` | yes | yes |
| `attestation_constraints` | `PASS` | yes | yes |
| `issuer_trust` | `NOT_TESTED` | yes | no |
| `protocol_conformance` | `NOT_APPLICABLE` | no | no |
| `interoperability` | `NOT_APPLICABLE` | no | no |
| **Overall** | **`NOT_TESTED`** | | |

The result pins the rulebook id, version `1.0.0` and the recomputed snapshot digest, and
carries explicit limitations for the unverified issuer JWS signature, key-binding proof,
status-list check, issuer trust, protocol conformance and end-to-end interoperability. The
exported JSON contains no credential artifact and no claim values.

## 2. Issue acceptance criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| OWF compatibility and negative cases verified | Passed | `src/owf.test.ts` (real package, pinned 0.5.4, valid/invalid documents), the `owf compatibility` CI job (`research/owf-audit` probe on Node 22 and Bun 1.3.1: 46 runtime exports, 35 checks), and the acceptance workflow's OWF valid/TS11-negative/OWF-import checks. |
| API, UI, migrations and Docker smoke tests pass in CI | Required CI jobs | `test` (API, migrations, OWF), `ui` (component, axe-core and Playwright browser flows against the real API), `docker smoke` (image build, startup, health, catalogue and 404 round-trip), and the new `acceptance` job. The merge gate requires all of them green on the same commit. Locally, the Bun and Vitest suites, migrations, OpenAPI and build passed; Docker is not installed in this environment and the browser suite needs Chromium OS libraries, so those two are executed by the CI jobs that install them. |
| No conflation of schema, crypto, trust or interoperability | Passed | The acceptance workflow asserts the structural `PASS` does not produce an overall `PASS`, cryptography and trust stay `NOT_TESTED`, protocol and interoperability stay `NOT_APPLICABLE`, a schema failure is an executed `FAIL`, an unsupported format is never reported `PASS`, and a missing schema document is `NOT_TESTED`. The exhaustive negatives are in `src/validation/non-conflation.test.ts` and `src/validation/dimensions.test.ts`. |
| Publish Phase 1 acceptance report with outstanding limitations | This document | §1–§4 record the executed evidence and §5 lists the limitations. |

## 3. Specification acceptance criteria

Phase 1 scope is AC-01–AC-08 and AC-16–AC-18 (specification §18–§19 and
[`docs/implementation-plan.md`](implementation-plan.md) §10.2). AC-09–AC-15 belong to later
phases and are not claimed here.

| Criterion | Status | Evidence or limitation |
| --- | --- | --- |
| AC-01 runs independently from Credimi | Verified | `src/dependencies.test.ts` rejects Credimi/Temporal/StepCI/PocketBase runtime dependencies; the acceptance run needs no external service, only the local SQLite file and Bun. |
| AC-02 actual OWF package installed, used and integration-tested | Verified | `src/owf.test.ts`, the version/transitive pins in `bun.lock`, the `owf compatibility` CI job and the acceptance OWF checks. |
| AC-03 supported TS11 rulebooks imported and inspected | Verified | Acceptance import preview/import, API reads of the attestation type and schema reference, and the catalog/detail UI tests in `ui/src/` and `ui/e2e/`. |
| AC-04 metadata managed/exported without normative loss | Verified for the implemented path | The version snapshot keeps the attestation type, LoS, binding type, supported formats and schema URI/integrity; the exact bytes are downloadable through the API and the detail UI. There is no rulebook editor in Phase 1 (see §5). |
| AC-05 reproducible versioning | Verified | The acceptance run freezes one version, downloads its exact snapshot bytes and recomputes the published SHA-256; `src/registry/versions.test.ts` covers deterministic snapshots and by-digest retrieval. |
| AC-06 published versions immutable | Verified | `src/registry/versions.test.ts` and `src/db/migrations.test.ts` attempt updates/deletes through the service and SQLite triggers; the acceptance run publishes and reads back the immutable version. |
| AC-07 credential validated against a selected rulebook version | Verified | Acceptance validation against version `1.0.0`; `src/app.validation.test.ts`, `src/validation/engine.test.ts` and the playground browser test. |
| AC-08 errors identify constraints and failing attributes | Verified | The acceptance negative schema case reports a JSON Pointer `path` and an `expected` constraint; the playground test shows the individual violations. |
| AC-16 dimensions remain distinguishable | Verified | §1.1 table, the acceptance non-conflation assertions and `src/validation/non-conflation.test.ts`. |
| AC-17 unsupported functionality is explicit | Verified | Unsupported formats, unexecuted dimensions, unsupported schema keywords and missing schema documents are reported `NOT_TESTED`/`INCONCLUSIVE`/`NOT_APPLICABLE`, never `PASS`. |
| AC-18 tests, Docker and developer documentation | Verified | The CI matrix, `Dockerfile`/`compose.yaml`, the `docs/` set and this report. Docker execution is a CI job because Docker is unavailable in this environment. |
| AC-09 create/edit/publish a rulebook | Deferred | API create, freeze and publish exist; the editor UI is Phase 2 (#40–#42). |
| AC-10/AC-11 issuer/verifier consume definitions/constraints | Deferred | Phase 3 (#43–#45); public read API exists but no issuer/verifier integration is claimed. |
| AC-12 capture design needs no engine redesign | Deferred | Phase 4; contracts are in [`docs/capture-integration.md`](capture-integration.md). |
| AC-13/AC-14 mock capture artifacts and correlation | Deferred | Phase 4 (#46–#48). |
| AC-15 Credimi consumes results without database access | Deferred | Phase 5 (#49–#51). |

## 4. Local verification results

Run from the repository root on 2026-11-06 with Bun 1.3.1 and Node.js 22.23.4 on Linux x64:

| Command | Result |
| --- | --- |
| `bun install --frozen-lockfile` | 232 packages installed |
| `bun run format:check` | passed |
| `bun run lint` | passed |
| `bun run typecheck` | passed |
| `bun run typecheck:ui` | passed |
| `bun run test` | 423 pass, 0 fail (includes the three acceptance workflow tests) |
| `bun run test:ui` | 115 pass, 0 fail across 9 files |
| `bun run openapi:check` | OpenAPI 3.1.0 document validated (15 operations, 26 schemas) |
| `bun run docs:check` | 12 pass, 0 fail |
| `bun run build` | passed; `dist/server.js`, `dist/validation/schema-sandbox-entry.js` and `dist/ui/` produced |
| `bun run acceptance` | 112/112 checks passed; evidence written to `dist/acceptance-evidence.json` with `ui.checked: true` and three served routes |
| `research/owf-audit`: `node probe.mjs`, `bun probe.mjs`, `npx tsc --noEmit` | 35 checks passed on both runtimes; typecheck passed |
| `bun run test:e2e` | Not runnable locally: the environment lacks the Chromium OS libraries (`libnspr4`, `libnss3`, …). The `ui` CI job installs Chromium with `--with-deps` and runs the same 22 browser tests. |

Docker is not installed in this environment, so `docker build` / `docker compose up` were not
run locally. The `docker smoke` CI job builds the image, starts a container, waits for
`/health`, checks the built catalog page, the empty catalogue API and the unknown-route 404.

CI is the merge gate for the jobs that need system tooling: the repository's merge procedure
requires every CI job green on the reviewed commit before the squash merge
([`docs/implementation-plan.md`](implementation-plan.md) §7).

## 5. Outstanding limitations

These are deliberate Phase 1 boundaries or residual gaps, not silent successes:

- **Cryptography, trust and interoperability are not implemented.** Signature
  verification, key-binding proof verification and status-list checks are `NOT_TESTED`;
  issuer trust is `NOT_TESTED` because no trust anchors are applied; protocol conformance and
  interoperability are `NOT_APPLICABLE` to a single credential artifact. A structural `PASS`
  never produces an overall `PASS` (FR-010, FR-012, D-8, D-17).
- **Only `dc+sd-jwt` is structurally parsed.** `mso_mdoc`, `jwt_vc_json`, `jwt_vc_json-ld`
  and `ldp_vc` are recognised and reported `NOT_TESTED`/`INCONCLUSIVE`; no mdoc parser exists.
- **Schema documents are caller-supplied.** The validation API does not fetch remote schemas,
  and import retains but does not fetch, resolve or SRI-verify schema references. JSON Schema
  keywords that cannot be bounded (`format`, `pattern`, `patternProperties`, `uniqueItems`,
  `dependencies`, the `$ref` family) are `NOT_TESTED` rather than executed.
- **Validation results are not persisted.** There is no `GET /api/v1/validations/{id}`;
  the exported JSON is the only evidence artifact.
- **No rulebook editor, import UI or publication workflow.** Version history and exact
  snapshot export exist, but authoring/publication controls are Phase 2 (#40–#42).
- **Import is API-only and bounded.** There is no scheduled catalogue synchronisation and no
  import UI; re-import is idempotent and conflicts are reported, never overwritten.
- **Provisional security model.** Bearer tokens are hashed and provider ownership is
  enforced, but token expiry/rotation, provider-management routes and HTTP rate limiting are
  not implemented; the TS11 §5.2.2 authorisation mechanism is unspecified and is not claimed.
  The service is a single SQLite instance with no high availability.
- **Pagination is in memory.** Catalogue filtering happens before the page slice; it is
  acceptable for the bounded MVP and is a documented limitation.
- **OWF 0.5.4 is experimental.** The dependency is pinned exactly; an upgrade requires the
  documented re-audit. ETSI EN 319 482-3 draft v0.0.6 content is unverified and no
  clause-level ETSI claim is made.
- **Tested baseline is Bun 1.3.1 on Linux x64.** Other runtimes and architectures (including
  ARM and non-Linux sandbox behaviour) are not claimed; the schema sandbox's RSS watchdog
  needs Linux `/proc`.
- **Capture and Credimi integration are later phases.** There are no capture artifacts,
  capture adapters, Credimi orchestration or external interoperability runs in Phase 1.
- **Local browser and Docker execution.** The browser suite and Docker smoke were not run in
  this environment; their CI jobs are the executed evidence.

## 6. Reproducing the acceptance run

```bash
bun install --frozen-lockfile
bun run build            # produces dist/server.js, the sandbox child and dist/ui
bun run acceptance       # runs the workflow and writes dist/acceptance-evidence.json
bun run check            # format, lint, typecheck, tests and UI tests
bun run openapi:check
bun run docs:check
```

`bun run acceptance` fails with the list of failed checks when any acceptance assertion does
not hold. The JSON evidence contains the pinned version/digest, every dimension's status,
applicability, execution and finding codes, the negative-case results and the non-conflation
facts.
