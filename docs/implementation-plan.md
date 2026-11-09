# AttestBook — Phase 1 Implementation Plan (Phase 0 consolidated)

**Status:** Phase 0 consolidated. This document is the implementation baseline for Phase 1.
It records the architecture decisions adopted from the Phase 0 research, the tested
dependency baselines, the known risks and a dependency-ordered Phase 1 plan. It makes
**no standards-conformance, security-certification or production-readiness claim**.

There is **no human approval gate**. Phase 1 begins when the pull request for
[issue #25](https://github.com/ForkbombEu/credimi-attestbook/issues/25) merges and the
dependent issues unblock through their normal `Depends on` lines and the repository's
autonomous workflow. This plan replaces the approval-gate wording of the original
[issue #5](https://github.com/ForkbombEu/credimi-attestbook/issues/5); it does not require a
separate sign-off.

**Authoritative specification:** [`docs/specification.md`](specification.md). Where this
plan and the specification conflict, the specification wins.

## Phase 0 document set

The five Phase 0 documents required by specification §18 are:

| Document | Role | Cross-reference |
| --- | --- | --- |
| [`docs/architecture.md`](architecture.md) | Modules, data model, security outline, decision context | Adopted decisions in §3; persistence in §5 |
| [`docs/standards.md`](standards.md) | OWF audit, TS11/ETSI/ARF baseline, capability gaps | OWF reconciliation in §4; risks R-1–R-4 |
| [`docs/requirements.md`](requirements.md) | Requirement index, Phase 1 scope, catalog-domain requirements | Scope and acceptance mapping in §9–§10 |
| [`docs/capture-integration.md`](capture-integration.md) | Proposed capture contracts (Phase 4 design) | Non-goals in §1; open findings in §11 |
| [`docs/implementation-plan.md`](implementation-plan.md) | This consolidated plan | All sections |

Supporting research is in [`docs/traceability.md`](traceability.md),
[`docs/catalog-research.md`](catalog-research.md) and the reproducible
[`research/owf-audit/`](../research/owf-audit/README.md) probe.

## 1. Purpose and scope

Phase 0 established what the standards require, what the mandatory OWF package actually
does, which external catalogs expose, and what a standalone architecture needs (issues
#1–#4). This plan turns those findings into an executable Phase 1 plan:

1. adopts the architecture decisions so implementation issues do not re-litigate them;
2. pins the tested dependency and runtime baselines, and separates them from unverified
   claims;
3. gives a database, API, CI and test strategy that fits one standalone deployable
   application;
4. orders the Phase 1 slices by real dependency, not by phase label;
5. carries forward the open findings from issue #5 without importing its approval gate.

### Phase 1 goal

A genuinely working standalone vertical slice: scaffold, OWF-backed TS11 adapter with
immutable multi-provider registry and provenance, safe URL/JSON import and re-import,
SD-JWT VC structural validation with dimension-aware evidence, versioned REST/OpenAPI
contracts, a catalog/detail UI, a validation playground and an end-to-end acceptance run
(specification §18 Phase 1; AC-01–AC-08, AC-16–AC-18).

### Phase 1 non-goals

These are deliberate exclusions, not forgotten work. A later phase issue owns most of them;
the two without a current migrated issue are marked explicitly.

- Rulebook editor, publication workflow and provider-management UI (FR-007/FR-008,
  UI-003) — Phase 2, issues
  [#40](https://github.com/ForkbombEu/credimi-attestbook/issues/40),
  [#41](https://github.com/ForkbombEu/credimi-attestbook/issues/41) and
  [#42](https://github.com/ForkbombEu/credimi-attestbook/issues/42).
- Full catalog synchronization scheduling (FR-005 beyond idempotent safe re-import) and
  the import UI (UI-004) — later phase; #30/#31 deliver the safe API path only, and no
  migrated issue currently owns these two follow-ups.
- Issuer discovery (FR-006) was delivered by
  [#43](https://github.com/ForkbombEu/credimi-attestbook/issues/43); issuer fixtures (FR-013)
  were delivered by [#44](https://github.com/ForkbombEu/credimi-attestbook/issues/44) as
  unsigned, integrity-grounded payloads, overrides and verified negative cases. Verifier
  constraints and OpenID4VP-aware mappings (FR-014) were delivered by
  [#45](https://github.com/ForkbombEu/credimi-attestbook/issues/45) as typed, bounded
  constraints and explicitly partial DCQL mappings; verifier negative cases and presentation
  request generation remain unimplemented.
- Capture artifact ingestion, mock/real capture adapters and the capture explorer
  (FR-015–FR-019, UI-006) — Phase 4, issues
  [#46](https://github.com/ForkbombEu/credimi-attestbook/issues/46),
  [#47](https://github.com/ForkbombEu/credimi-attestbook/issues/47) and
  [#48](https://github.com/ForkbombEu/credimi-attestbook/issues/48). Delivered:
  #46 shipped the versioned envelope, normalization, secure references, integrity and
  redaction; #47 delivered the typed push/pull adapter contracts and a deterministic offline
  mock source ([`docs/capture.md`](capture.md)). Real `capture-issuer`/`capture-verifier`
  connectors (gated on their actual APIs), persistence and the correlated capture explorer
  (#48) remain unimplemented.
- Credimi orchestration, headless-wallet workflow and continuous conformance
  (FR-020–FR-022) — Phase 5, issues
  [#49](https://github.com/ForkbombEu/credimi-attestbook/issues/49),
  [#50](https://github.com/ForkbombEu/credimi-attestbook/issues/50) and
  [#51](https://github.com/ForkbombEu/credimi-attestbook/issues/51).
- Security hardening, performance/caching and ETSI migration or external interoperability
  checks — Phase 6, issues
  [#52](https://github.com/ForkbombEu/credimi-attestbook/issues/52),
  [#53](https://github.com/ForkbombEu/credimi-attestbook/issues/53) and
  [#54](https://github.com/ForkbombEu/credimi-attestbook/issues/54).
- mdoc/mDL validation. Phase 1 recognises the format from metadata but reports it
  `NOT_TESTED`; no fake parser and no implied support (FR-011).
- Real cryptographic, trust, protocol or interoperability validation of credentials.
  Phase 1 reports those dimensions `NOT_TESTED` or `INCONCLUSIVE`; it never derives PASS
  from structural checks (FR-010, FR-012, AC-16, AC-17).
- The TS11 catalogue `/schemas` write API. The product API is separate and is not a TS11
  catalogue implementation; the adapter keeps the translation boundary so the catalogue
  API can be added later (architecture §5).
- Production deployment, high availability, PostgreSQL operations and multi-tenant SSO.
  Phase 1 runs as a single standalone instance.

## 2. Sources and tested baselines

Versions in this table were inspected or executed during Phase 0. Values marked
**UNVERIFIED** must not be turned into an implementation claim without a new check.

| Item | Tested / inspected value | Status | Evidence |
| --- | --- | --- | --- |
| EC TS11 | v1.0.1 (2026-01-30) | verified | [`docs/standards.md`](standards.md) Part II §2, §3; specification §3.2 |
| EUDI ARF | 3.0.0 (tag 2026-07-21), §5.5/§5.6 | verified | [`docs/standards.md`](standards.md) Part II §4 |
| ETSI EN 319 482-3 | draft v0.0.6 (2026-10-27), content restricted | **UNVERIFIED** | [`docs/standards.md`](standards.md) Part II §6, §8 |
| OWF package | `@owf/eudi-attestation-schema` **0.5.4** (published 2026-10-30) | verified, 46 runtime exports | [`docs/standards.md`](standards.md) §2–§3; `research/owf-audit` |
| OWF dependencies | `@owf/crypto` 0.6.2, `@owf/identity-common` 0.6.2, `@owf/cose` 0.6.2, `@owf/token-status-list` 0.6.2, `@sd-jwt/sd-jwt-vc` 0.24.1, `@sd-jwt/core` 0.24.1, `zod` 4.6.7 | verified via lockfile and pinned by `overrides` | `research/owf-audit/package-lock.json`, `bun.lock`, `src/owf.test.ts` |
| Node.js | 20.20.2, 22.23.4, 24.22.2 | verified | [`docs/standards.md`](standards.md) §8 |
| Bun | 1.3.1 (Linux x64) | verified in the Phase 0 audit environment | [`docs/standards.md`](standards.md) §8 |
| OWF probe re-run | Node.js 24.22.2, 35 checks passed | re-verified 2026-11-05 | `research/owf-audit` run for this plan |
| SQLite via Bun | Bun 1.3.1 built-in `bun:sqlite`; WAL and foreign keys enabled | verified | `src/sqlite-smoke.test.ts`; #26 |
| Hono HTTP library | 4.13.16 | verified (health endpoint under Bun) | `src/app.test.ts`, Docker smoke job; #26 |
| UI libraries | React/React DOM 19.3.1, Vite 8.3.6, Vitest 5.1.0, `@playwright/test` 1.65.0 (exact set in [`docs/ui.md`](ui.md) §2) | verified: production build plus component and browser tests executed | `docs/ui.md`, `ui/src/*.test.ts[x]`, `ui/e2e/`; #36 |

Rules that follow from this table:

- Pin `@owf/eudi-attestation-schema` to **exactly 0.5.4** with the lockfile, and do not use
  a range or the `0.6.0-alpha-*` prerelease. Any upgrade repeats the audit (D-1, R-1).
- Do not cite ETSI EN 319 482-3 clause by clause. The version-aware adapter is the only
  mitigation until the draft is public (D-4, R-4).
- A library chosen for the implementation is pinned in the lockfile and covered by a test
  in the issue that introduces it. This plan names the intended stack but does not claim
  untested versions are verified. If a candidate fails its compatibility probe, the
  implementing issue substitutes a maintained equivalent and records the substitution in
  its PR and the lockfile; the architecture decision itself does not change.

## 3. Consolidated architecture decisions

These decisions close the open decisions in
[`docs/architecture.md`](architecture.md) §12 (AD-1–AD-12) and add the implementation
decisions that were not visible at research time (D-13–D-17). The rationale and primary
issue make each decision traceable; the decisions are normative for Phase 1 issues until a
later issue explicitly supersedes one.

| ID | Architecture ref | Decision | Rationale and source | Primary issue |
| --- | --- | --- | --- | --- |
| **D-1** | AD-1 | Pin `@owf/eudi-attestation-schema` **0.5.4** exactly; pin the lockfile and exercise the real package in integration tests. | 0.5.4 is the tested `latest`; 0.6.0-alpha is a prerelease on `@owf/*` 0.7.0-alpha. Spec §2.1; standards §2, §9.2. | #27 |
| **D-2** | AD-2 | Keep a canonical AttestBook domain model and a narrow, version-aware codec between TS11 v1.0.1, the OWF 0.5.4 profile and AttestBook metadata. Never expose OWF `SchemaMeta` as the TS11 public contract. | The models diverge in id, integrity placement, trust frameworks, `supportedFormats`, schema references and format set (standards §6). Spec §2.1; AC-04. | #27 |
| **D-3** | AD-3 | Wrap JOSE verification in a strict policy: no `alg: none`, no unbound `alg`/key, reject header/payload inconsistencies, allowlist algorithms (ES256 first), reject synthetic `iat`, and verify `x5c`/trust separately or report it `NOT_TESTED`. | OWF `verifySchemaMeta` accepts inconsistent headers and synthesises `iat` (standards §5.4). Spec §15; SR-16. | #27 |
| **D-4** | AD-4 | Pin **EC TS11 v1.0.1** as the Phase 1 baseline, store the applicable spec version per rulebook/schema, and treat ETSI EN 319 482-3 as an evolving, UNVERIFIED target. | Standards Part II §6, §9; specification §3.2. No clause-level ETSI delta exists yet. | #27, #29 |
| **D-5** | AD-5 | Store TS11/OWF enumerated values as extensible data, validating membership against the pinned baseline; do not make them closed TypeScript unions. Unknown future values are preserved and reported, not silently coerced. | The TS11→ETSI migration may add values (e.g. `etsi_lote`); standards §9.2, architecture §4.2. | #27 |
| **D-6** | AD-6 | A version's content digest is **SHA-256 over the exact stored artifact bytes**. Published bytes are immutable and content-addressed. No semantic canonicalization is required in Phase 1; if a canonical form is needed later, use RFC 8785 JCS. Known limitation: re-serialized source JSON (key order or whitespace) gets a different digest; #31 compares normalized content for change detection and reports serialization-only changes instead of silently ignoring them (R-17). | Byte-exact storage is reproducible and needs no unverified canonicalizer; OWF has no canonicalization API (architecture §9). | #29 |
| **D-7** | AD-7 | Use a **single SQLite database file** for Phase 1, with WAL, foreign keys, checked-in migrations and a repository interface. PostgreSQL is not a Phase 1 dependency; adopting it later requires a separate decision. | Zero-config local development, no external service, portable Docker, strong relational integrity for provider→rulebook→version invariants (architecture §10, spec §17). | #28 |
| **D-8** | AD-8 | Overall validation status is conservative: **FAIL** if any dimension FAILs; else **INCONCLUSIVE** if any is INCONCLUSIVE; else **NOT_TESTED** if any applicable dimension was not executed; else **PASS** only when every applicable dimension PASSed; **NOT_APPLICABLE** only when no dimension is applicable. Per-dimension statuses are always returned. A dimension is applicable when the selected rulebook, credential format and request require it; whether AttestBook already has an implementation does not change applicability. A required dimension with no implementation is `NOT_TESTED`, never `NOT_APPLICABLE`, so an overall PASS cannot hide untested cryptography or trust. | Never let a structural PASS imply cryptographic or interoperability success (FR-012, AC-16, AC-17). #33 defines and tests the per-dimension applicability table. | #33 |
| **D-9** | AD-9 | Validate `attestationLoS` and `bindingType` as TS11 vocabulary and for consistency with the selected rulebook version. Do **not** enforce issuer-side issuance/LoS processes, and do not infer assurance from the values. | TS11 defines the enum but delegates LoS enforcement; OQ-2 and standards Part II §8 item 3. | #32 |
| **D-10** | AD-10 | Use a provisional, self-contained bearer-token/actor model bound to provider accounts for write APIs; public reads stay public. Do not claim the unspecified TS11 §5.2.2 authorisation mechanism, and do not expose a TS11 catalogue write API in Phase 1. | TS11 defers the concrete auth mechanism; OQ-3. Spec §13/§15; FR-003. | #35 |
| **D-11** | AD-11 | Verify W3C SRI `#integrity` only over bytes fetched through the SSRF-safe, size/time-limited fetcher. Use OWF SRI for `sha256`; report other algorithms as unsupported/`NOT_TESTED` rather than PASS. Remote `$ref` resolution is restricted, bounded and same-origin by default. | OWF supports sha256 only; untrusted remote content needs the §15 controls (OQ-4, SR-19, R-7). | #30 |
| **D-12** | AD-12 | Record catalogue registration claims, source conformance and AttestBook compatibility as separate metadata. Never infer mandatory registration from ARF or TS11, and never treat registration as conformance. | ARF §5.6.3 vs TS11 §4.1/§4.2 tension (OQ-1, standards Part II §4.1). | #30 |
| **D-13** | — | Make **Bun 1.3.1** the primary Phase 1 runtime and package manager; produce ESM and strict TypeScript; use Node 20+ only for the OWF compatibility probe and the dependency-free documentation check. Use `skipLibCheck: true` because of the `@sd-jwt/sd-jwt-vc` 0.24.1 declarations, while keeping `strict` and `exactOptionalPropertyTypes` for application code. | Spec §2.2 prefers Bun subject to compatibility; the audit verified Bun 1.3.1 with the OWF package (standards §8). | #26 |
| **D-14** | — | Baseline stack: Hono with a Zod/OpenAPI layer for the HTTP API; React + Vite for the standalone UI; `@sd-jwt/sd-jwt-vc` plus Ajv 2020-12 for SD-JWT VC parsing/structural validation; Playwright for browser tests. Exact versions are pinned by #26/#32 after a compatibility probe. | Lightweight, ESM/TypeScript-native, no microservices, same API for UI (spec §2.2, §13, §14). | #26, #32 |
| **D-15** | — | CI is GitHub Actions with pinned Bun 1.3.1, frozen lockfile, and separate quality, test, build, Docker-smoke, docs and OpenAPI jobs. Every check must pass before merge; no deployment job and no secrets. The agent does not alter branch-protection settings: #26 verifies whether the checks are required on `main`, reports any gap in its PR, and the repository owner opens the repository-administration issue (the agent does not open issues as itself). | Spec §16/§17; issue #26. AGENTS.md backlog step 2 asks for required checks, but the agent's delivery policy forbids changing repository settings, so #26 records the deviation instead of silently leaving checks advisory. | #26 |
| **D-16** | — | Add a repository documentation check (`node scripts/check-docs.mjs`) that verifies the five Phase 0 documents, relative links and required cross-references. #25 runs it directly and in `.github/workflows/docs.yml`; #26 folds it into the `docs` job of `.github/workflows/ci.yml`. | Acceptance criterion "documentation consistency checks pass"; R-14. | #25, #26 |
| **D-17** | — | Phase 1 validates SD-JWT VC structure and attestation constraints only. Cryptographic, trust, protocol and interoperability dimensions are returned as `NOT_TESTED` unless a real external check runs; mdoc and other formats are recognised or reported, never mocked as valid. | FR-010–FR-012, AC-16/AC-17; standards capability matrix. | #32, #33 |

### Decision traceability

| Decision | Requirements / obligations | Planned verification |
| --- | --- | --- |
| D-1 | Spec §2.1; AC-02 | Lockfile audit, OWF integration test, upgrade runbook |
| D-2 | FR-001, AC-04; SR-08/SR-09 | Round-trip and unknown-member tests for TS11/OWF profiles |
| D-3 | FR-008, SR-16; security T4 | Negative JOSE tests (alg none, mismatch, missing/forged iat, x5c) |
| D-4 | SR-08, SR-12; D-9–D-12 resolve the related OQs | Stored `specVersion`; no ETSI claim |
| D-5 | SR-10, migration | Unknown enum values preserved and reported |
| D-6 | FR-002, AC-05/AC-06; SR-12 | Digest stability, immutability and tamper tests |
| D-7 | FR-001–FR-003, spec §17 | Migration and isolation tests on a temporary SQLite file |
| D-8 | FR-010, FR-012, AC-16/AC-17 | Table-driven aggregation tests, including negative implications |
| D-9 | FR-010, standards Part II §8 | Vocabulary and consistency tests; no issuer-side claim |
| D-10 | FR-003, spec §13/§15 | Cross-provider write denial tests |
| D-11 | SR-19, security T1–T3 | SSRF, size, depth, `$ref`, SRI mismatch and unsupported-algorithm tests |
| D-12 | FR-004, SR-23/SR-24 | Imported metadata retains separate conformance/registration signals |
| D-13 | Spec §2.2, AC-02 | CI on Bun 1.3.1 plus Node OWF compatibility probe |
| D-14 | Spec §13/§14/§16 | Contract, UI and browser tests |
| D-15 | Spec §16, AC-18 | Required checks green on every PR |
| D-16 | Issue #25 acceptance; R-14 | `node scripts/check-docs.mjs` in CI |
| D-17 | FR-010–FR-012, AC-16/AC-17 | Negative dimension tests; no PASS without execution |

## 4. OWF dependency reconciliation

`@owf/eudi-attestation-schema` 0.5.4 remains mandatory (spec §2.1). It is a useful
primitives library, not a TS11 v1.0.1 codec and not a credential validator.

### 4.1 Reuse versus AttestBook responsibility

| Boundary | Reuse from OWF 0.5.4 | AttestBook owns |
| --- | --- | --- |
| `SchemaMeta` codec | OWF builders, Zod schemas and structural validation for the OWF profile | Profile detection, TS11 ↔ canonical model translation, lossless unknown-member handling, unmappable-field reports |
| JOSE | Compact-JWS parsing, signature primitive, certificate parsing | `typ`/`alg`/`kid`/`x5c` policy, algorithm allowlist, key resolution, chain/trust verification, `iat` semantics |
| References | SRI verification, Type Metadata merge, `extends` bounds | SSRF-safe fetch, timeouts, size/JSON limits, redirect policy, caching, provenance |
| DCQL / issuer metadata | Claim extraction, DCQL mapping, template/profile checks | OID4VCI version choice, ambiguity handling, trust completeness (Phase 3) |
| Credential validation | None — the package exposes no credential parser or validator | SD-JWT VC parsing, structural/attestation checks, dimension-aware evidence |
| Registry, API, UI, capture | None | Persistence, versions, publication, authorization, OpenAPI, UI, capture |

The adapter must not reimplement OWF-supported `SchemaMeta` validation. It calls OWF for the
OWF profile and implements only the documented, narrow TS11 translation extension allowed
by spec §2.1.

### 4.2 Compatibility findings that shape the implementation

- **Profile divergence is real.** OWF 0.5.4 rejects a TS11 v1.0.1-shaped document and
  strips unknown top-level members during `SchemaMetaSchema.parse`; a round-trip through
  OWF must not be used as the AttestBook persistence format (D-2).
- **JOSE is permissive.** `verifySchemaMeta` accepts `typ: "JWT"`, `alg: "none"`, an
  `alg` that does not match the key, missing `x5c` and missing `iat`, then injects the
  verifier's clock. AttestBook must not use the returned header or synthesised `iat` as
  evidence (D-3).
- **SRI is sha256-only.** `sha384`/`sha512` references cannot be verified with the package;
  they must be reported as unsupported, not silently accepted (D-11).
- **No credential validation.** All credential-level checks belong to the AttestBook
  validation engine and external libraries; OWF's `{ valid, errors }` result is not a
  credential result (D-17).
- **Runtime shape is ESM-only.** Node 20+ is the practical floor; Bun 1.3.1 passed the
  probe. AttestBook uses ESM and does not rely on CommonJS interop (D-13).
- **The package is experimental.** Any upgrade repeats the audit and updates the plan's
  tested baseline; `0.6.0-alpha` is not adopted (D-1, R-1).

### 4.3 Upstream gaps

The nine upstream issue candidates in [`docs/standards.md`](standards.md) §10 remain
upstream work, not blockers for Phase 1. The two high-priority ones — strict JOSE
validation and a versioned TS11 codec — are mitigated locally by D-2 and D-3. The audit
probe is the regression harness for every OWF upgrade.

## 5. Persistence and database

### 5.1 Decision

**SQLite is the Phase 1 database engine** (D-7), accessed through a repository layer. It
is a file on disk, not a service: local development needs no container, CI uses a
temporary file, and Docker mounts a volume for persistence. The Phase 1 deployment is a
single writer instance; that limitation is explicit and tested.

Why not PostgreSQL now: it adds a mandatory external service and a second dialect to test
before the MVP has demonstrated the need. The repository interface and typed domain model
keep the door open; adopting PostgreSQL later is a separate decision with its own
migration plan, not an implied Phase 1 commitment.

### 5.2 Initial schema (logical)

Migrations live in `migrations/` and are applied in order by a small runner. The initial
schema covers the architecture §7 entities; the exact column types are fixed by #28/#29,
not by this plan.

| Table | Purpose | Key invariants |
| --- | --- | --- |
| `providers` | Attestation Scheme Providers and publication authority | Provider identity is not inferred from a URL (FR-003) |
| `rulebooks` | Stable rulebook identity, provider, source and status | `provider_id` foreign key; stable id |
| `rulebook_versions` | Draft/published/historical versions | `UNIQUE(rulebook_id, version)`; published rows immutable; digest and `spec_version` required on publication |
| `attestations` | Attestation types bound to a rulebook version | Values stored as extensible data (D-5) |
| `schema_refs` | Format identifier, URI, SRI and resolved reference | `formatIdentifier` unique per version; resolution status recorded |
| `artifacts` | Content-addressed exact bytes | `digest` primary key; `bytes` immutable; SHA-256 over exact bytes (D-6) |
| `import_runs` / `import_entries` | Import attempt, adapter, source, conformance and conflicts | Idempotency key; no destructive overwrite |
| `validations` | Validation request/result snapshots | References `rulebook_version` + digest; result is reproducible |
| `audit_log` | Publication and privileged mutations | Actor, action, entity, timestamp, digest |
| `auth_tokens` | Provisional write credentials | Only a hash is stored; bound to a provider (D-10) |
| `schema_migrations` | Applied migration bookkeeping | Append-only |

The #28 implementation lives in `src/db/`, `src/registry/` and
`migrations/0001_registry.sql`; #29 added the version and artifact tables in
`migrations/0002_versions_artifacts.sql`. Their concrete columns, stable identifiers,
standards-metadata boundary, authorization model and version lifecycle are documented in
[`docs/registry.md`](registry.md): versioned content is stored beside the product columns, not
merged into them.

### 5.3 Storage rules

- Enable `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON` and a busy timeout.
- Published `rulebook_versions` and `artifacts` are protected by application checks **and**
  database triggers that reject `UPDATE`/`DELETE`; tests attempt both.
- A published version is retrievable by `(rulebook_id, version)` and by its content digest.
  Validation always records the exact version and digest used (FR-002, AC-05, AC-06).
- Imported bytes are stored exactly once in `artifacts`; metadata points at the digest. A
  re-import of identical bytes is a no-op (idempotency, #31).
- Migrations run in a transaction per version and are exercised from an empty database in
  CI. The Docker entrypoint runs the migration command before serving.
- Backup and portability are documented as "copy the database file (plus WAL checkpoint)",
  not as a production HA promise.

## 6. Runtime, API and UI baseline

- **Runtime:** Bun 1.3.1, ESM, strict TypeScript. `skipLibCheck: true` is a documented
  workaround for the `@sd-jwt/sd-jwt-vc` declarations, not a relaxation of application
  strictness (D-13).
- **HTTP:** Hono with a Zod/OpenAPI layer, typed requests/responses, consistent error
  envelopes and URL-prefixed `v1` versioning under `/api`. The product API is not the TS11
  catalogue API; TS11-shaped resources are implemented separately and exactly if a later
  issue adds them (architecture §5).
- **Validation libraries:** `@sd-jwt/sd-jwt-vc` (version aligned with OWF's pinned
  transitive version) for SD-JWT VC parsing and Ajv 2020-12 for JSON Schema validation.
  The exact versions are pinned and tested in #32.
- **UI:** React 19 + Vite 8, consuming the same public API, with the built assets served
  from `/` by the Bun server. Phase 1 builds UI-001, UI-002 and UI-005 only; the catalog
  (#36), rulebook-detail (#37) and credential-playground (#38) slices are implemented, and
  the editor, import UI and capture explorer are not claimed.
- **Docker:** multi-stage image based on `oven/bun:1.3.1`, non-root runtime user, health
  endpoint, migration entrypoint, no secrets baked in.
- **Observability:** structured logs with request ids and a redaction layer; no raw
  credential, token, key or personal attribute is logged by default (spec §15).

## 7. CI and quality gates

CI is GitHub Actions, with versions pinned and dependencies installed from the frozen
lockfile. The repository requires no deployment job; nothing in CI publishes an image or
touches production.

| Job | What it does | Introduced by |
| --- | --- | --- |
| `quality` | Format check, lint and strict typecheck, including the UI project | #26, extended by #36 |
| `test` | Unit + integration tests on Bun 1.3.1, including the real OWF package and a temporary SQLite database | #26, extended by #27–#33 |
| `build` | Production build and bundle, including `dist/ui/index.html` | #26, extended by #36 |
| `docker` | Build image, start container, wait for health, run a catalog-page and API round-trip, stop | #26, extended by #36 |
| `docs` | `node scripts/check-docs.mjs` (five documents, relative links, cross-references) | #25, wired into main CI by #26 |
| `openapi` | Validate the generated OpenAPI 3.1 document and contract tests | #34 |
| `owf-compat` | Re-run the Phase 0 OWF probe on Node 22 and Bun 1.3.1 against the pinned lockfile | #26 |
| `ui` | UI typecheck, component/accessibility tests and Playwright end-to-end tests against the real API | #36, extended by #37–#38 |

Rules:

- No live external catalog, issuer or capture endpoint is required in CI; tests use
  vendored fixtures and local mock servers (spec §16).
- A test that is expected to fail or is not executed is reported as such; skipped tests do
  not count as coverage of a requirement (AC-17).
- The agent verifies all checks are green and the head commit is the reviewed commit before
  merging. It does not change branch protection or repository settings. #26 verifies whether
  the workflow checks are required on `main`, reports any gap in its PR, and the repository
  owner opens the required-settings issue (the agent does not open issues as itself).
- The docs check is deliberately dependency-free and runs under plain Node so it also works
  before the application scaffold exists.

## 8. Risks and mitigations

| ID | Risk | Likelihood / impact | Mitigation | Residual / trigger |
| --- | --- | --- | --- | --- |
| R-1 | OWF 0.5.4 is experimental and may break on upgrade or with TS11/ETSI changes | medium / high | Exact pin, lockfile, adapter boundary, audit probe, re-audit every upgrade | Upgrade issue required; no automatic version range |
| R-2 | OWF JOSE permissiveness leaks into AttestBook | high / high | Strict wrapper D-3, negative tests for every observed permissive case | x5c/trust chain remains `NOT_TESTED` until a trust configuration exists |
| R-3 | TS11/OWF profile divergence causes data loss | high / medium | Canonical model, lossless unknown members, round-trip tests, no OWF parse as persistence | Unmappable fields are reported, not silently dropped |
| R-4 | ETSI EN 319 482-3 content is unverified and may change the model | high / medium | Version-aware adapter, stored `specVersion`, no ETSI claim | Re-verify when the draft is public |
| R-5 | Bun or a native/optional dependency fails on another platform or in Docker | medium / medium | Audit verified Bun 1.3.1; pin image; Node 22 compatibility job for OWF; document Linux x64 baseline | If Bun is blocked, revisit runtime with evidence before changing |
| R-6 | SQLite single-writer limits or backup mistakes | medium / medium | WAL, busy timeout, repository layer, single-instance documentation, backup guidance | PostgreSQL adoption requires a new decision |
| R-7 | SSRF, oversized responses, deep JSON or remote `$ref` attacks | high / high | https-only, DNS/address checks, redirect re-validation, timeouts, size/depth limits, same-origin `$ref`, no code execution | Security negative-test suite in #30 |
| R-8 | Credential or capture data leaks into logs/artifacts | medium / high | Redaction by default, no raw logging, secret-free fixtures, external artifact refs | Capture storage details remain Phase 4 (CD-6) |
| R-9 | A structural PASS is misread as cryptographic/trust validity | high / high | Dimension model D-8/D-17, conservative overall status, UI labels, negative tests | No hidden "valid" boolean that ignores dimensions |
| R-10 | ARF/TS11 registration discrepancy is encoded as a hard rule | medium / medium | D-12, separate conformance/registration metadata, no inference | Re-check when standards change |
| R-11 | Unspecified TS11 authorisation is invented as normative | medium / medium | D-10 provisional product auth, no TS11 catalogue write API, no conformance claim | Replace when TS11 §5.2.2 is specified |
| R-12 | mdoc or unsupported formats are claimed from generic JSON Schema checks | medium / high | D-17, explicit `NOT_TESTED`, no fake parser, UI disclosure | mdoc parser is a later issue |
| R-13 | Version drift in new dependencies makes the plan's stack claim stale | medium / medium | Pin in lockfile, record exact versions in the introducing PR, OWF compatibility job | This plan is updated when the stack changes |
| R-14 | Documentation drifts from code and decisions | medium / low | `scripts/check-docs.mjs`, cross-reference requirement, docs gate in CI | Fix links and decision references in the same PR |
| R-15 | Phase 1 grows into Phase 2 features | medium / medium | Explicit non-goals in §1, issue scope, review against acceptance criteria | Defer to the later phase issue |
| R-16 | Optional native `cbor-extract` binding is unavailable on some architectures | medium / low | Audit notes it is optional; Docker/CI pin Linux x64; document limitation | Test the chosen Docker image; do not claim ARM support |
| R-17 | Re-serialized source JSON (key order/whitespace) gets a new byte-exact digest and looks changed | medium / low | #31 compares normalized content for change detection and reports serialization-only changes rather than silently ignoring them (D-6) | Documented limitation; no semantic-identity claim |

## 9. Dependency-ordered Phase 1 plan

The Phase 1 backlog is the migrated issue set #26–#39. The original Phase 1 issues #6–#14
were closed as duplicates, and the Phase 0 approval gate in #5 is superseded by #25. An
issue starts only when every issue on its `Depends on` line is **CLOSED with stateReason
COMPLETED**, as the repository workflow requires.

| Wave | Issue | Slice | Depends on | Exit evidence |
| --- | --- | --- | --- | --- |
| 0 | [#25](https://github.com/ForkbombEu/credimi-attestbook/issues/25) | Consolidate Phase 0 and reconcile decisions (this plan) | — | Five documents cross-referenced; docs check green |
| 1 | [#26](https://github.com/ForkbombEu/credimi-attestbook/issues/26) | Scaffold TypeScript app, test harness, CI and Docker | #25 | Setup/build/test documented; CI green; Docker smoke; OWF smoke |
| 2 | [#27](https://github.com/ForkbombEu/credimi-attestbook/issues/27) | OWF-backed TS11 adapter and data models | #26 | Real-package adapter tests; JOSE policy negatives; gap report |
| 3 | [#28](https://github.com/ForkbombEu/credimi-attestbook/issues/28) | Persistent provider and rulebook registry | #27 | Migrations, CRUD, ownership/isolation tests |
| 4 | [#29](https://github.com/ForkbombEu/credimi-attestbook/issues/29) | Immutable versions, digests and provenance | #28 | Published immutability, digest and version-retrieval tests |
| 5 | [#30](https://github.com/ForkbombEu/credimi-attestbook/issues/30) | Safe URL/JSON imports and preview | #29 | SSRF/limit/fixture tests; provenance retained |
| 5 | [#32](https://github.com/ForkbombEu/credimi-attestbook/issues/32) | SD-JWT VC structural validation and evidence API | #29, #27 | Positive/negative attribute tests; typed validate endpoint |
| 6 | [#31](https://github.com/ForkbombEu/credimi-attestbook/issues/31) | Idempotent re-import and conflict detection | #30 | Idempotency/conflict tests; history preserved |
| 6 | [#33](https://github.com/ForkbombEu/credimi-attestbook/issues/33) | Independent crypto/trust/protocol dimensions | #32 | Status-semantics and negative-implication tests |
| 7 | [#34](https://github.com/ForkbombEu/credimi-attestbook/issues/34) | Versioned REST and OpenAPI contracts | #28, #31, #33 | Contract tests; OpenAPI validates; no placeholder handlers |
| 8 | [#35](https://github.com/ForkbombEu/credimi-attestbook/issues/35) | Secure write APIs and provider authorization | #34 | Cross-provider denial and auth tests |
| 8 | [#36](https://github.com/ForkbombEu/credimi-attestbook/issues/36) | Searchable rulebook catalog UI | #34 | Real-data search/filter; loading/error/empty tests |
| 9 | [#37](https://github.com/ForkbombEu/credimi-attestbook/issues/37) | Rulebook detail and version-history UI | #36, #29 | Real detail/history; unsupported states labelled |
| 10 | [#38](https://github.com/ForkbombEu/credimi-attestbook/issues/38) | Credential validation playground UI | #37, #33 | Real API use; dimension display; e2e success/failure |
| 11 | [#39](https://github.com/ForkbombEu/credimi-attestbook/issues/39) | MVP end-to-end acceptance | #38, #35 | Full CI matrix and Phase 1 acceptance report |

The two equally long dependency chains are
#26 → #27 → #28 → #29 → #30 → #31 → #34 → #36 → #37 → #38 → #39 and
#26 → #27 → #28 → #29 → #32 → #33 → #34 → #36 → #37 → #38 → #39. Both the import and
validation branches must finish before #34; #30/#32 and #31/#33 can run in parallel, as can
#35/#36. This ordering is a dependency statement, not a request for human approval.

### Phase 1 exit criteria

Phase 1 is complete when #39's acceptance report, produced from a green CI run on the
merged head, shows:

- every Phase 1 acceptance criterion in §10.2 passing against the real OWF package, real
  SQLite migrations, the real API and the real UI (not mocks standing in for implemented
  features);
- Docker startup and the documented local setup working from a clean checkout;
- no unexecuted dimension or unsupported format reported as PASS, and the limitations list
  published with the evidence;
- the five Phase 0 documents still internally consistent after the implementation changes
  (`node scripts/check-docs.mjs` green).

### Slice boundaries

- **#26:** repository layout, `package.json`, Bun lockfile, strict `tsconfig`, format/lint,
  test harness, health endpoint, Dockerfile/compose, CI workflows, docs-check wiring, pinned
  OWF dependency and a smoke test. No product features.
- **#27:** canonical model, profile detection, TS11/OWF codecs, strict JOSE wrapper, SRI
  reference resolution boundary, adapter diagnostics. No registry, HTTP or credential
  validation.
- **#28:** SQLite schema/migrations, provider/rulebook repositories, authentication and
  ownership plumbing, service-level authorization. No version publishing.
- **#29:** version lifecycle subset required by the MVP (draft/published/historical),
  content-addressed artifacts, digests, provenance, immutable publication and
  version-specific retrieval.
- **#30:** import adapters for URL/JSON, preview, structural validation, compatibility
  report, conformance classification, source/provenance recording, bounded fetching.
- **#31:** idempotent re-import, conflict diagnostics and safe re-import that never
  overwrites local or published content (implementation in `docs/import.md` §5).
- **#32:** SD-JWT VC parse and structural/attestation checks against a pinned rulebook
  version; typed validation API; mdoc/other formats explicitly unsupported/`NOT_TESTED`.
- **#33:** the eight-dimension status model, conservative aggregation, evidence payload and
  negative tests proving dimensions are not conflated.
- **#34:** versioned API surface for implemented rulebooks, versions, imports and
  validation; consistent typed errors; OpenAPI generated/validated.
- **#35:** bearer-token auth, provider ownership enforcement, audit logging for writes.
- **#36–#38:** catalog, detail/history and playground UIs against the real API.
- **#39:** end-to-end acceptance, Docker/migrations/UI/API/OWF checks, limitations report.

## 10. Testing and acceptance mapping

### 10.1 Test layers

| Layer | Scope | Required evidence |
| --- | --- | --- |
| Unit | Codecs, JOSE policy, validation rules, aggregation, URL/limit policy | Fast, deterministic, table-driven cases including negative inputs |
| Integration | HTTP handlers + services + temporary SQLite + real OWF package | Migrations from empty, transaction rollback, OWF adapter, import/validate round-trips |
| Contract | OpenAPI document vs handlers and error envelopes | Generated/validated OpenAPI; success and failure responses |
| UI | Catalog, detail and playground against a real API | Loading/error/empty states, accessibility checks, Playwright e2e |
| Security | SSRF, redirects, DNS/IP ranges, size/depth limits, `$ref`, JOSE forgery, redaction | Negative tests that would fail on an unsafe implementation |
| End-to-end | #39 workflow | Import → inspect versions → validate → export evidence in CI |

All tests use offline fixtures or local mock servers. Fixtures record their provenance and
never contain real credentials, tokens or personal data. No test marks an unexecuted
dimension as PASS.

### 10.2 Acceptance criteria mapping

| Acceptance criterion | Phase | Covered by |
| --- | --- | --- |
| AC-01 independent from Credimi | Phase 1 | #26, #39 |
| AC-02 actual OWF package installed, used, tested | Phase 1 | #26, #27, #39 |
| AC-03 supported TS11 rulebooks imported and inspected | Phase 1 | #30, #31, #36, #39 |
| AC-04 metadata managed/exported without normative loss | Phase 1 | #27, #29, #37 |
| AC-05 reproducible versioning | Phase 1 | #29 |
| AC-06 published versions immutable | Phase 1 | #29, #37 |
| AC-07 credential validated against a selected version | Phase 1 | #32, #38 |
| AC-08 errors identify constraints and attributes | Phase 1 | #32, #33, #38 |
| AC-09 create/edit/publish a rulebook | Phase 2 | #40, #41, #42 |
| AC-10 issuer consumes definitions via API | Phase 3 | #43, #44 |
| AC-11 verifier consumes constraints via API | Phase 3 | #45 |
| AC-12 capture design needs no validation-engine redesign | Phase 4 | #46 (envelope/normalization implemented; see capture.md), #47 (push/pull adapter contracts and mock source implemented; the validation engine is untouched), #48; contracts in capture-integration.md |
| AC-13 mock capture artifacts validate | Phase 4 | #47: the deterministic mock source normalizes every version 1 artifact type; its artifacts are validated only as untrusted capture evidence, not yet against a rulebook (#48) |
| AC-14 capture evidence correlates with results | Phase 4 | #48 |
| AC-15 Credimi consumes results without DB access | Phase 5 | #49 |
| AC-16 dimensions remain distinguishable | Phase 1 | #33 |
| AC-17 unsupported functionality is explicit | Phase 1 | #32, #33 |
| AC-18 tests, Docker and developer documentation | Phase 1 | #26, #39 |

Specification §16 test categories (standards, registry, validation, capture, integration)
map to the layers above. Capture tests are executed for the envelope/normalization slice in #46
(`src/capture/*.test.ts`) and for the push/pull contracts, mock source, authorization and
transport-error handling in #47 (`src/capture/adapters/*.test.ts`); correlation tests arrive
with #48. The matrix in [`docs/traceability.md`](traceability.md) remains the normative-to-test
record.

## 11. Open findings carried forward

These findings were open in the Phase 0 research or in issue #5. They are recorded here so
a later issue can act on them; they do not block autonomous Phase 1 work.

| Finding | Status / decision | Owner or trigger |
| --- | --- | --- |
| Issue #5 required a human approval gate before Phase 1 | **Dropped** by issue #25 and repository policy; Phase 1 is dependency-driven, not sign-off-driven. | Resolved in this plan |
| Original Phase 1 issues #6–#14 carry stale "blocked until approval" wording | Closed as duplicates and superseded by #26–#39; not executed. | No action |
| FR-005 periodic synchronization and UI-004 import interface have no current roadmap child issue | Phase 1 delivers only safe API import/re-import (#30/#31); a follow-up issue is needed for scheduling and the import UI. The agent does not open issues as itself, so the repository owner must open it. | Backlog planning by the repository owner |
| OWF `verifySchemaMeta` accepts inconsistent JOSE headers and synthesises `iat` | Mitigated by D-3; upstream issue candidates remain open. | #27; upstream OWF |
| OWF `SchemaMeta` diverges from TS11 v1.0.1 (id, integrity, trust, formats, schema URIs) | Mitigated by D-2; no public OWF model. | #27 |
| OWF SRI supports sha256 only | Unsupported algorithms reported, not PASS (D-11). | #30 |
| OWF 0.6.0-alpha is a prerelease on `@owf/*` 0.7.0-alpha | Not adopted; upgrade needs a new audit (D-1). | Future upgrade issue |
| ETSI EN 319 482-3 draft v0.0.6 is restricted | No clause-level delta; adapter is version-aware (D-4). | Re-verify when public |
| ARF vs TS11 registration-obligation discrepancy | Separate metadata, no hard rule (D-12). | #30 |
| TS11 catalogue authorisation mechanism is unspecified (§5.2.2) | Provisional product auth only (D-10). | #35; re-check TS11 |
| `isLOTE` vs `isLoTE` spelling and future `etsi_lote` value | Preserve both/unknown values as extensible data (D-5). | #27 |
| mdoc/mDL, browser, Deno and ARM behaviour are untested | Explicit `NOT_TESTED` / documented limitation (D-17, R-5, R-12). | Later format/runtime issue |
| Capture decisions CD-1, CD-2, CD-3, CD-4, CD-5, CD-6 (field set, redaction depth, pull schedule, sync/async push, correlation ownership, artifact storage) | CD-1 (field set), CD-2 (default redaction: a preserved-member allow-list with full fallback) and CD-6 (reference-only external storage, not fetched) are provisionally settled for envelope version 1 by #46 in [`docs/capture.md`](capture.md); #47 provisionally settles CD-3 for the mock source (on-demand pull, hashed bearer credential) and CD-4 as an asynchronous push contract, while a real source's authentication/polling schedule and a future HTTP ingestion route remain open. CD-5 (correlation-id ownership) still needs the correlation work in #48. | #46, #47, #48 |
| PostgreSQL, semantic canonicalization, TS11 catalogue API and OID4VCI version target | Not needed for the Phase 1 MVP; later decisions with their own issues. | Future issues |

## 12. Assumptions and non-claims

- A merged issue with completed dependencies is sufficient authorization to start the next
  issue; no separate architecture sign-off is required. This is the explicit approval path
  for commits and merges under the repository's `AGENTS.md` and issue workflow;
  specification §20 item 11's approval requirement is therefore satisfied at the issue
  level, while production deployment remains out of scope for every Phase 1 issue.
- TS11 v1.0.1 and ARF 3.0.0 are the verified baselines. ETSI EN 319 482-3 is not read and
  no delta is claimed.
- Bun 1.3.1 on Linux x64 is the tested runtime baseline. Other runtimes and architectures
  are not claimed.
- SQLite is a single-instance Phase 1 choice; high availability, replication and
  PostgreSQL are out of scope.
- The plan is a sequencing and decision record, not a certificate of correctness,
  security, performance or standards conformance. Each implementation issue must supply
  its own tests and evidence.

## 13. References

- [`docs/specification.md`](specification.md) — authoritative requirements, §2, §4–§18
- [`docs/architecture.md`](architecture.md) — modules, data model, security outline
- [`docs/standards.md`](standards.md) — OWF audit and TS11/ETSI/ARF baseline
- [`docs/requirements.md`](requirements.md) — requirement index and Phase 1 scope
- [`docs/traceability.md`](traceability.md) — requirements-to-clause and requirements-to-test
- [`docs/capture-integration.md`](capture-integration.md) — Phase 4 capture contracts
- [`docs/catalog-research.md`](catalog-research.md) — external catalog survey
- [`research/owf-audit/README.md`](../research/owf-audit/README.md) — reproducible OWF probe
- Issues [#25](https://github.com/ForkbombEu/credimi-attestbook/issues/25),
  [#26](https://github.com/ForkbombEu/credimi-attestbook/issues/26),
  [#27](https://github.com/ForkbombEu/credimi-attestbook/issues/27),
  [#28](https://github.com/ForkbombEu/credimi-attestbook/issues/28),
  [#29](https://github.com/ForkbombEu/credimi-attestbook/issues/29),
  [#30](https://github.com/ForkbombEu/credimi-attestbook/issues/30),
  [#31](https://github.com/ForkbombEu/credimi-attestbook/issues/31),
  [#32](https://github.com/ForkbombEu/credimi-attestbook/issues/32),
  [#33](https://github.com/ForkbombEu/credimi-attestbook/issues/33),
  [#34](https://github.com/ForkbombEu/credimi-attestbook/issues/34),
  [#35](https://github.com/ForkbombEu/credimi-attestbook/issues/35),
  [#36](https://github.com/ForkbombEu/credimi-attestbook/issues/36),
  [#37](https://github.com/ForkbombEu/credimi-attestbook/issues/37),
  [#38](https://github.com/ForkbombEu/credimi-attestbook/issues/38),
  [#39](https://github.com/ForkbombEu/credimi-attestbook/issues/39)
- Later-phase issues (migrated/split from the closed duplicates #15–#19):
  [#40](https://github.com/ForkbombEu/credimi-attestbook/issues/40),
  [#41](https://github.com/ForkbombEu/credimi-attestbook/issues/41),
  [#42](https://github.com/ForkbombEu/credimi-attestbook/issues/42),
  [#43](https://github.com/ForkbombEu/credimi-attestbook/issues/43),
  [#44](https://github.com/ForkbombEu/credimi-attestbook/issues/44),
  [#45](https://github.com/ForkbombEu/credimi-attestbook/issues/45),
  [#46](https://github.com/ForkbombEu/credimi-attestbook/issues/46),
  [#47](https://github.com/ForkbombEu/credimi-attestbook/issues/47),
  [#48](https://github.com/ForkbombEu/credimi-attestbook/issues/48),
  [#49](https://github.com/ForkbombEu/credimi-attestbook/issues/49),
  [#50](https://github.com/ForkbombEu/credimi-attestbook/issues/50),
  [#51](https://github.com/ForkbombEu/credimi-attestbook/issues/51),
  [#52](https://github.com/ForkbombEu/credimi-attestbook/issues/52),
  [#53](https://github.com/ForkbombEu/credimi-attestbook/issues/53),
  [#54](https://github.com/ForkbombEu/credimi-attestbook/issues/54)
