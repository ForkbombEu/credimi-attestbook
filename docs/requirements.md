# AttestBook — Requirements Index and Catalog Discovery & Import Requirements

**Status:** Phase 0 consolidated. §1 is the requirement index for the whole specification
and maps each requirement to its phase and implementation issue. §2 retains the detailed,
research-derived requirements for the external catalog / discovery / import domain from
[issue #3](https://github.com/ForkbombEu/credimi-attestbook/issues/3). The authoritative
requirement text remains [`docs/specification.md`](specification.md); this file adds the
phase/issue mapping and the explicit non-goals. It is not an implementation or conformance
claim.

**Authoritative spec:** [`docs/specification.md`](specification.md)
**Consolidated plan:** [`docs/implementation-plan.md`](implementation-plan.md) (decisions,
tested baselines, Phase 1 order)
**Architecture:** [`docs/architecture.md`](architecture.md)
**Standards and normative clauses:** [`docs/standards.md`](standards.md)
**Capture contracts:** [`docs/capture-integration.md`](capture-integration.md)
**Traceability matrix:** [`docs/traceability.md`](traceability.md)
**Catalog evidence:** [`docs/catalog-research.md`](catalog-research.md)

## 1. Requirement index and phase mapping

The phase and issue columns are the plan of record; a requirement may be partially
delivered in Phase 1 and completed later, and the table says so explicitly. Issues are the
migrated Phase 1 set #26–#39 and the open later-phase set #40–#54, which was migrated and
split from the closed duplicates #15–#19.

### 1.1 Functional requirements

| ID | Requirement (specification §5–§12) | Phase / issue | Notes |
| --- | --- | --- | --- |
| FR-001 | Rulebook management: multiple providers, stable identity, metadata, provenance, digests | Phase 1: #28, #29, #37 | Internal metadata kept out of standards documents |
| FR-002 | Versioning: draft/published/historical, immutable published artifacts, version-specific validation, digest verification | Phase 1: #29 | Content digest over exact stored bytes (D-6) |
| FR-003 | Provider management, ownership and publication authority | Phase 1: #28, #35 | Provisional product auth only; TS11 catalogue auth is unspecified (D-10) |
| FR-004 | External rulebook import: URL/JSON, preview, structural validation, compatibility, provenance, safe re-import | Phase 1: #30, #31, #36 | Adapter-based; no assumed full TS11 conformance (R4.4) |
| FR-005 | Catalog synchronization: conditional fetch, idempotency, change detection, conflict reporting, availability | Phase 1 partial: #31; full sync later | Scheduled sync and source diagnostics are not an MVP dependency |
| FR-006 | Issuer metadata discovery (OpenID4VCI) | Phase 3: #43 | Not authoritative for rulebooks |
| FR-007 | Rulebook editor and authoring workflow | Phase 2: #40 (working-copy editor and live validation), #41 (lifecycle/diff) | UI-003; not Phase 1; publication remains #42 |
| FR-008 | Publication of validated, versioned, reproducible artifacts with provenance/integrity | Phase 1 subset: #29; full workflow Phase 2: #42 | Where signing applies, use OWF behind the JOSE policy |
| FR-009 | Reusable validation API with structured results and evidence | Phase 1: #32, #33 | SD-JWT VC structural scope; per-dimension evidence and limitations added in #33 |
| FR-010 | Eight independent validation dimensions | Phase 1: #33 | No dimension PASS without execution; applicability table in `docs/validation.md` §2 |
| FR-011 | Credential format support, SD-JWT VC first, extensible interfaces | Phase 1: #32 (SD-JWT VC); later formats | mdoc explicitly `NOT_TESTED`, not mocked |
| FR-012 | PASS / FAIL / NOT_TESTED / NOT_APPLICABLE / INCONCLUSIVE results | Phase 1: #33 | Conservative overall aggregation (D-8), enforced per dimension |
| FR-013 | Issuer test fixtures | Phase 3: #44 | Not Phase 1 |
| FR-014 | Verifier test fixtures and policies | Phase 3: #45 | Not Phase 1 |
| FR-015 | Capture artifact model | Phase 0 contracts: [`docs/capture-integration.md`](capture-integration.md); Phase 4: #46 | Not implemented |
| FR-016 | `capture-issuer` integration | Phase 4: #47 | Not claimed operational |
| FR-017 | `capture-verifier` integration | Phase 4: #47 | Not claimed operational |
| FR-018 | Capture integration contracts (push/pull, mock adapter) | Phase 0 contracts; Phase 4: #46, #47 | Transport-agnostic, no broker |
| FR-019 | Correlation and traceability across rulebook, capture and validation | Phase 0 contracts; Phase 4: #48 | Stable ids, pinned version + digest |
| FR-020 | Credimi test orchestration via API | Phase 5: #49 | No Temporal/StepCI/PocketBase dependency |
| FR-021 | Headless Wallet testing workflow | Phase 5: #50 | AttestBook validates, does not orchestrate |
| FR-022 | Continuous conformance: deterministic, reproducible, machine-readable | Phase 1 supports the evidence subset (#33, #34); Phase 5: #51 | No conformance claim |

### 1.2 User-interface requirements

| ID | Requirement | Phase / issue |
| --- | --- | --- |
| UI-001 | Rulebook catalog with search/filter, provider, version, status, source, compatibility | Phase 1: #36 |
| UI-002 | Rulebook details, attestation types, schema references, compatibility, version history, provenance | Phase 1: #37 |
| UI-003 | Rulebook editor, live validation, diff, draft management, publication | Phase 2: #40 (editor and live validation), #41 (diff/lifecycle), #42 (publication) |
| UI-004 | Import interface: URL/file, preview, diagnostics, conflict resolution, sync settings | Phase 2+ follow-up (not in #40–#42); API import lands in #30/#31 |
| UI-005 | Credential playground: input/upload, rulebook/type selection, validation, violations, export | Phase 1: #38 |
| UI-006 | Capture explorer (mock-backed until real contracts exist) | Phase 4: #48 |

### 1.3 Acceptance criteria

| ID | Criterion | Phase / issue |
| --- | --- | --- |
| AC-01 | Runs independently from Credimi | Phase 1: #26 (`src/dependencies.test.ts`), #39 |
| AC-02 | Actual OWF package installed, used and integration-tested | Phase 1: #26 (`src/owf.test.ts`), #27 (`src/standards/owf-codec.test.ts`, `src/standards/jose.test.ts`, `src/standards/references.test.ts`), #39 |
| AC-03 | Supported TS11 rulebooks imported and inspected | Phase 1: #30, #31, #36, #39 |
| AC-04 | Metadata managed/exported without losing normative information | Phase 1: #27 (`src/standards/ts11-codec.test.ts`, `src/standards/owf-codec.test.ts`; lossless unknown-member round-trip), #29, #37 |
| AC-05 | Reproducible versioning | Phase 1: #29 |
| AC-06 | Published versions immutable | Phase 1: #29, #37 |
| AC-07 | Credential validated against a selected rulebook version | Phase 1: #32, #38 |
| AC-08 | Errors identify constraints and failing attributes | Phase 1: #32, #33, #38 |
| AC-09 | Create, edit and publish a supported rulebook | Phase 2: #40, #41, #42 |
| AC-10 | Issuer consumes definitions through a documented API | Phase 3: #43, #44 |
| AC-11 | Verifier consumes constraints through a documented API | Phase 3: #45 |
| AC-12 | Architecture supports capture without redesigning the validation engine | Phase 0 contracts; Phase 4: #46, #47, #48 |
| AC-13 | Mock capture artifacts validate through the public API | Phase 4: #47 |
| AC-14 | Capture evidence correlates with validation results | Phase 4: #48 |
| AC-15 | Credimi consumes results without database access | Phase 5: #49 |
| AC-16 | Rulebook, cryptographic, protocol and interoperability results remain distinguishable | Phase 1: #33 |
| AC-17 | Unsupported functionality explicitly reported | Phase 1: #32, #33 |
| AC-18 | Automated tests, Docker and developer documentation | Phase 1: #26 (`bun run check`, Docker smoke job, README), #39 |

### 1.4 Explicit non-goals

AttestBook is not, and Phase 1 does not claim to be:

- a credential issuer, credential wallet, OpenID4VCI/OpenID4VP protocol endpoint or trust-list
  operator;
- a second test-orchestration platform or a replacement for Credimi's runtime;
- an implementation of TS11 conformance, ETSI EN 319 482-3 conformance or interoperability
  without executed tests;
- a home for proprietary fields inside standards-defined documents;
- a production deployment or a high-availability/multi-region service in Phase 1.

## 2. Detailed requirements — catalog discovery and import

Requirements are marked with their verification status against the research: **VERIFIED**
(observed during the survey — live source or inspected repository source), **DOCUMENTED**
(claimed by the source but not observed), or **DESIGN** (AttestBook-internal decision, not
yet implemented).

### FR-004 — External rulebook import

The system MUST implement an adapter-based import system (specification FR-004).

**R4.1 — Adapter-based import (DESIGN).** Import goes through per-source adapters over one
normalized, TS11-aligned internal model. Adapter families identified by the survey:
`UrlCatalogAdapter` (direct JSON URL), `SirosCatalogAdapter`, `FidesCatalogAdapter`,
`MarkdownRulebookAdapter` (EUDI rulebooks), and `IssuerDiscoveryAdapter` (OID4VCI, see
FR-006).

**R4.2 — URL import (DESIGN).** Support importing from an `https` URL with SSRF protection,
timeouts and size limits (see SR-1..SR-5).

**R4.3 — JSON file import (DESIGN).** Support local JSON file upload with the same
validation and limits as URL import.

**R4.4 — No assumed TS11 compliance (VERIFIED need; DESIGN mechanism).** The survey
confirms sources differ in TS11 conformance (SIROS: self-declared read-only TS11 §5 subset;
FIDES: self-reported `conformance.level: "partial"` with missing fields enumerated; EUDI
rulebooks: prose-only). The importer MUST classify each imported entry's conformance
(`conformant_subset` / `partial` / `not_verified` / `prose_only`) and surface it, never
silently treating partial or non-TS11 content as full TS11.

**R4.5 — Structural validation & compatibility reporting (DESIGN).** Validate imported
structure against the normalized model and produce a compatibility report (per source and
per entry) that includes the source's own conformance signal where available.

**R4.6 — Import preview (DESIGN).** Provide a preview of what will be imported before
committing it to the registry.

**R4.7 — Provenance preservation (DESIGN).** Record source URL, fetch timestamp, adapter
kind and (where exposed) the source's version/last-built/`updatedAt` signals. Because no
surveyed source publishes a per-entry content digest, AttestBook MUST compute and store its
own content digest.

**R4.8 — Version conflict detection & safe re-import (DESIGN; implemented in #31).** Detect
version/identity conflicts on re-import and never silently overwrite locally edited or
published rulebooks (also FR-005). #31 implements this through a deterministic import
identity, idempotent unchanged re-import and explicit conflict reporting; changed content is
reported for resolution through the version lifecycle, never applied automatically.

### FR-005 — Catalog synchronization

**R5.1 — Conditional fetching (VERIFIED capability for SIROS).** SIROS serves `ETag`/
`Last-Modified` with `cache-control: max-age=600`; the SIROS adapter SHOULD use conditional
requests. Sources without conditional support are re-fetched and diffed by digest.

**R5.2 — Idempotent imports & change detection (DESIGN; implemented in #31 for re-import).**
Imports are idempotent; change detection uses AttestBook-side content digests (no source
exposes a reliable digest). Because the digest is byte-exact, re-serialized source JSON (key
order/whitespace) is reported as a change; the importer compares normalized content when
deciding whether the semantic content changed and never silently treats serialization-only
differences as identical. #31 implements this per-entry identity and content fingerprint and
reports a `serialization_only_change` finding instead of writing.

**R5.3 — Conflict reporting & version preservation (DESIGN; implemented in #31 for
re-import).** Report conflicts explicitly; preserve historical versions; published artifacts
remain immutable. #31 returns a typed per-entry conflict and never writes over an existing
rulebook, so published and historical versions are untouched; scheduled synchronization and
source availability reporting remain later slices.

**R5.4 — Source availability diagnostics (DESIGN).** Report per-source availability
(reachability, schema changes, signature status) distinctly from import failures.

**R5.5 — Signature verification (VERIFIED for FIDES; DOCUMENTED for SIROS).** FIDES signs
its `schemas` endpoint (ES256, `kid: fides-cat-2026-v1`) and publishes a JWKS; verify it and
refresh keys on rotation. SIROS documents JWS but does not currently enable it (JWKS 404
observed); treat unsigned SIROS JSON as the current reality and record `unsigned`.

### FR-006 — Issuer metadata discovery

**R6.1 — OID4VCI discovery (VERIFIED mechanism; DESIGN integration).** Given a Credential
Issuer URL, fetch `/.well-known/openid-credential-issuer`. EUDIPLO and Sphereon both
implement/serve this (source-verified).

**R6.2 — Version-aware metadata (VERIFIED need).** Sphereon ships metadata builders/clients
for two OID4VCI draft generations (v1.0 and 1.15); the discovery adapter MUST be
version-aware and not assume one metadata shape.

**R6.3 — Extract configurations, formats, type identifiers, schema refs (DESIGN).** Extract
`credential_configurations_supported`, credential format, type identifier (`vct`/`doctype`)
and any exposed schema references.

**R6.4 — Rulebook association & manual mapping (DESIGN).** Attempt to associate
configurations with known rulebooks; report unmatched/ambiguous configurations; allow
explicit manual mapping.

**R6.5 — Not authoritative (DESIGN, per spec FR-006).** Issuer metadata MUST NOT be treated
as an authoritative Attestation Rulebook.

### Security controls (import/discovery-relevant subset of specification section 15)

**SR-1 — SSRF protection (DESIGN).** URL import, sync and issuer discovery fetch remote
resources; restrict to `https`, validate and resolve DNS, and block
private/link-local/loopback/cloud-metadata ranges. Redirects MUST be re-validated.

**SR-2 — Safe URL validation (DESIGN).** Reject non-`https` schemes and malformed URLs
before any network I/O.

**SR-3 — Network timeouts & response size limits (DESIGN).** Enforce per-request timeouts
and maximum response sizes. FIDES `aggregated.json` is ~1.4 MB; SIROS VCTM payloads embed
large `data:` URI logos — impose parse limits and strip/reject oversized inline images.

**SR-4 — JSON parsing limits & JSON Schema reference controls (DESIGN).** Bound JSON depth/
node counts; restrict remote `$ref` resolution (same-origin only by default) and bound
recursive-reference depth. Never execute imported documents.

**SR-5 — Resource consumption & secret redaction (DESIGN).** Bound concurrent fetches and
total import cost; do not log raw metadata responses, tokens, or embedded URIs.

## 3. Requirements-to-evidence traceability (summary)

| Requirement | Source | Evidence | Status |
|---|---|---|---|
| R4.4 no assumed TS11 | SIROS, FIDES, EUDI | observed conformance signals | VERIFIED need |
| R5.1 conditional fetch | SIROS | `ETag`/`Last-Modified`, `max-age=600` | VERIFIED |
| R5.5 signature verification | FIDES (live JWS + JWKS), SIROS (documented only) | decoded JWS; JWKS 404 | VERIFIED / DOCUMENTED |
| R6.1 OID4VCI discovery | EUDIPLO, Sphereon | source tree | VERIFIED mechanism |
| R6.2 version-aware | Sphereon | v1.0 + 1.15 builders/clients | VERIFIED need |

The normative-clause and requirements-to-test mappings are in
[`docs/traceability.md`](traceability.md); the implementation decisions and Phase 1 order
are in [`docs/implementation-plan.md`](implementation-plan.md).
