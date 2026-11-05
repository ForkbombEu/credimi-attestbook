# AttestBook — Architecture, Data Model and Security Outline (Phase 0)

**Status:** Phase 0 consolidated architecture. The decisions in §12 are adopted in
[`docs/implementation-plan.md`](implementation-plan.md) and form the Phase 1 baseline. This
document is not an implementation or conformance claim; each implementation issue supplies
its own tests. [Issue #25](https://github.com/ForkbombEu/credimi-attestbook/issues/25)
consolidated the research from #1–#4, and there is **no separate human approval gate**.

**Ticket:** [#4 — Design standalone architecture, data model and capture contracts](https://github.com/ForkbombEu/credimi-attestbook/issues/4) · **Consolidated by:** [#25](https://github.com/ForkbombEu/credimi-attestbook/issues/25)

**Authoritative spec:** [`docs/specification.md`](specification.md). Where this document
and the specification conflict, the specification wins.

## 0. Coordination with the other Phase 0 documents

The research drafts that this architecture depends on are merged. Issue #25 consolidated
their findings without overwriting them:

| Document | Owned by | Relation to this architecture |
| --- | --- | --- |
| [`docs/standards.md`](standards.md) | [#1](https://github.com/ForkbombEu/credimi-attestbook/issues/1) (OWF audit) and [#2](https://github.com/ForkbombEu/credimi-attestbook/issues/2) (TS11/ETSI) — combined | Source for the standards-adapter boundary (§4), OWF compatibility and the versioning/digest model (§9) |
| [`docs/traceability.md`](traceability.md) | [#2](https://github.com/ForkbombEu/credimi-attestbook/issues/2) | Source for the validation-dimension model (§8) |
| [`docs/catalog-research.md`](catalog-research.md), [`docs/requirements.md`](requirements.md) (import domain and requirement index) | [#3](https://github.com/ForkbombEu/credimi-attestbook/issues/3) | Source for the import/discovery adapter family (§5) and the security outline (§11) |
| [`docs/capture-integration.md`](capture-integration.md) | this ticket (#4) | Companion document for capture contracts |
| [`docs/implementation-plan.md`](implementation-plan.md) | [#25](https://github.com/ForkbombEu/credimi-attestbook/issues/25) | Consolidated decisions, tested baselines, risks and the dependency-ordered Phase 1 plan |

All five Phase 0 documents cross-reference each other and the authoritative
[`docs/specification.md`](specification.md).

## 1. Architecture principles

Derived from [`docs/specification.md`](specification.md) §2 and §4:

1. **Standalone and reusable.** AttestBook is an independently deployable product, not a
   Credimi module. It MUST NOT depend on Credimi, Temporal, StepCI or PocketBase, or on any
   specific Wallet/Issuer/Verifier implementation.
2. **API-first.** All capabilities are exposed through stable, documented HTTP APIs
   (OpenAPI). The web UI is a client of the same API, not a bypass around it.
3. **Standards-driven with a version-aware adapter.** The OWF package is mandatory
   (spec §2.1), but the OWF `SchemaMeta` profile is not the TS11 v1.0.1 wire model
   ([#1](https://github.com/ForkbombEu/credimi-attestbook/issues/1)). AttestBook keeps its
   own canonical domain model and translates at a narrow, version-aware boundary.
4. **No premature microservices.** Modules are logical units within a single deployable
   application unless a concrete requirement forces a split. No event broker, no
   speculative infrastructure.
5. **Explicit, honest conformance.** Structural, cryptographic, trust, protocol and
   interoperability results are distinct dimensions; a dimension is never reported PASS
   unless it was actually executed (spec FR-010, FR-012, AC-16, AC-17).

## 2. System context and boundaries

AttestBook sits between authoritative **rulebook sources** and external **consumers**:

```
                    ┌──────────────────────────────────────────────────────────┐
  TS11 / catalog    │                        AttestBook                        │
  sources           │                                                          │
  (SIROS, FIDES,    │  Catalog Importer ──► Registry ──► Rulebook Editor        │
   EUDI rulebooks,  │        │                 │              │                │
   URL / JSON)  ────┼────────┴────────┐        │              ▼                │
                    │   Standards Adapter (version-aware, OWF-backed)          │
                    │                                                          │
  Issuer metadata   │  Issuer Adapter ──► Validation Engine ──► Evidence/Report │
  (OpenID4VCI)  ────┼────────┘                 ▲              ▲                │
                    │                         │              │                 │
  capture-issuer /  │  Capture Integration Layer ─────────────┘                │
  capture-verifier  │        (proposed contracts, mock-backed in Phase 4)      │
                    └──────────────────────────────────────────────────────────┘
                              │ HTTP API (OpenAPI) / Web UI
                              ▼
        Credimi (API client), Verifiers, Issuers, other wallets/administrations
```

What AttestBook **is**: a registry, editor and validation platform for executable
Attestation Rulebooks, with standards-aware import and (future) capture-based evidence
ingestion.

What AttestBook **is not** (explicit non-goals for Phase 0/1): a credential issuer, a
credential wallet, an OpenID4VCI/OpenID4VP protocol endpoint, a trust-list operator, or a
second test-orchestration platform. Credential signing, cryptographic validation of
credentials, and protocol/interoperability execution are delegated to dedicated libraries
or to external systems (Credimi), and their results are *reported*, not faked
(spec §8, §9, §10).

## 3. Logical modules

Mapping of spec §4.1 to concrete module responsibilities. These are logical boundaries,
not deployment units.

| Module | Responsibility | Primary inputs/outputs |
| --- | --- | --- |
| **Registry** | Persist providers, rulebooks, attestation types, schemas, versions, provenance and publication status (spec §5) | Domain model (§7) |
| **Standards Adapter** | Translate between wire profiles (TS11 v1.0.1, OWF 0.5.4 profile) and the canonical domain model; own JOSE/SRI policy | TS11 `SchemaMeta` ⇄ domain model |
| **Catalog Importer** | Adapter-based import and sync from external sources; conformance classification; conflict detection (spec §6) | `ImportReport` |
| **Issuer Discovery Adapter** | OpenID4VCI `/.well-known/openid-credential-issuer` discovery and rulebook association (FR-006) | Credential configurations |
| **Rulebook Editor** | Authoring, preview, validation diagnostics, version diff, draft/publish workflow (spec §7) | Rulebook mutations |
| **Validation Engine** | Evaluate credential structure and attestation constraints against a pinned rulebook version; dimension-aware results (spec §8) | `ValidationResult` |
| **Issuer / Verifier Integration Adapters** | Rulebook-driven test fixtures and validation policies for external implementations (spec §9–10) | Fixtures, policies |
| **Capture Integration Layer** | Normalize capture artifacts from `capture-issuer`/`capture-verifier` and feed validation (spec §11) | `CaptureArtifact` (see companion doc) |
| **Evidence & Reporting** | Structured, machine-readable validation evidence and correlation (FR-019) | `ValidationResult`, evidence |

## 4. Standards Adapter boundary (OWF vs TS11 vs AttestBook)

**Acceptance item: OWF adapter boundary and TS11-specific vs proprietary fields separated.**

The OWF audit ([#1](https://github.com/ForkbombEu/credimi-attestbook/issues/1)) established
that `@owf/eudi-attestation-schema` 0.5.4, pinned exactly (D-1), is a useful primitives
library but **not** a TS11 v1.0.1 codec. Its `SchemaMeta` model diverges from TS11 v1.0.1 in
`id`
(URL vs UUID), integrity placement (`rulebookIntegrity` member vs `#integrity` suffix),
trust frameworks (`etsi_tl` + `x509` vs `aki`/`etsi_tl`/`openid_federation`/`isLoTE`),
`supportedFormats` (removed vs required 1..*), `schemaURIs` item shape, the supported
format set (2 vs 5), and `iat` semantics. A TS11-shaped document is rejected by OWF, and
vice versa.

Consequence: **AttestBook must not expose OWF's `SchemaMeta` as the TS11 public contract.**
It needs a narrow, version-aware translation boundary with a canonical internal model.

### 4.1 Three layers, three field ownerships

| Layer | Owns | Examples | Rules |
| --- | --- | --- | --- |
| **TS11 v1.0.1 wire profile** | Normative `SchemaMeta` fields | `id` (UUID), `version`, `rulebookURI` (+`#integrity`), `trustedAuthorities` (`aki`/`etsi_tl`/`openid_federation`, `isLoTE`), `attestationLoS`, `bindingType`, `supportedFormats` (5 values), `schemaURIs[]` (`formatIdentifier`, `uri`+`#integrity`) | Must be preserved losslessly; never polluted with internal fields |
| **OWF 0.5.4 profile** | OWF-specific fields | `rulebookIntegrity`, `schemaURIs[].integrity`/`.meta`, `issuanceProfile`, `x509` trust anchor | Handled only through the OWF package; not assumed normative |
| **AttestBook internal metadata** | Product provenance/state | content digest, source URL, import timestamp, sync state, conformance classification, publication status | **Never injected into a standards document**; stored alongside, not inside, the normative object |

The adapter's responsibilities (from [#1](https://github.com/ForkbombEu/credimi-attestbook/issues/1) §9.1):

- **Codec:** detect the input profile (TS11 v1.0.1 vs OWF 0.5.4), translate to/from the
  canonical domain model, preserve unknown/normative members, and report unmappable fields
  instead of silently dropping them (OWF 0.5.4 already strips unknown top-level members).
- **JOSE:** reuse OWF's compact-JWS parsing and signature primitive, but own the
  `typ`/`alg`/`kid`/`x5c` policy, algorithm allowlist, key resolution, x5c chain/trust
  verification and `iat` semantics. OWF's `verifySchemaMeta` accepts `typ:"JWT"`,
  `alg:"none"`, and mismatched `alg`/key, and synthesizes `iat` — those behaviours must
  not leak into AttestBook.
- **Reference resolution:** reuse OWF's SRI verification and Type Metadata merge, but own
  SSRF-safe fetch, timeouts, size/JSON limits, caching, provenance and redirect policy.
- **Trust:** reuse `toDcqlTrustedAuthorities`/builders, but do not claim trust validation
  that OWF does not perform (it does not verify `trustedAuthorities` or `x5c`, and drops
  the `x509` variant and TS11 `aki`/`openid_federation`).

### 4.2 Version-awareness for the TS11 → ETSI migration

From [#2](https://github.com/ForkbombEu/credimi-attestbook/issues/2) §9:

1. Pin **TS11 v1.0.1** as the Phase 1 baseline and store the source specification version
   with every rulebook/schema so a later migration is mechanical.
2. Keep no TS11 types leaking into registry/validation internals — everything behind the
   adapter.
3. Treat enumerated values (`supportedFormats`, `attestationLoS`, `bindingType`,
   `frameworkType`) as **extensible data, not closed TypeScript unions**, so new ETSI
   values (e.g. `etsi_lote`) can be added without breaking callers.
4. Re-verify **ETSI EN 319 482-3 draft v0.0.6** when it becomes publicly accessible; until
   then it is UNVERIFIED and has no clause-level delta.

## 5. HTTP/API boundary

The API is the product's contract surface (spec §13). All modules are invoked through a
single HTTP layer; no module is reachable through the database directly.

- **Resource groups (proposed, not normative TS11):** `rulebooks`, `rulebook versions`,
  `attestations`, `providers`, `imports`, `issuers` (discovery), `credentials` (validate),
  `captures` (validate), `validations`.
- **TS11 catalogue interfaces** (`GET/PUT/DELETE /schemas` with filters/pagination, JWS
  responses) are implemented **separately and exactly** where applicable, not mixed with
  the product API (spec §13; [#2](https://github.com/ForkbombEu/credimi-attestbook/issues/2) §3.5).
- **Synchronous vs asynchronous:** import, sync, capture normalization and validation that
  may take long are asynchronous (job + result resource); simple reads and single-credential
  validation may be synchronous. Each endpoint documents its mode.
- **Idempotency** where appropriate (imports, publication, capture submission).
- **Typed requests/responses, consistent errors, API versioning** (URL or header prefix
  `v1`), OpenAPI generation as the source of truth (spec §13).
- **The web UI consumes the same API** (no private backdoor), satisfying the standalone
  UI requirement (spec §14).

## 6. Authorization and provider ownership

**Acceptance item: authorization/provider ownership.**

- **Public read, restricted write/delete.** TS11 mandates public read (§5.2.1) and
  authorizes write/delete only for the entity that registered the schema (§5.2.2, §4.5.3).
  AttestBook mirrors this: rulebook catalog and published artifacts are publicly readable;
  creation, edit, import mutation and publication require an authenticated actor.
- **Provider identity is a first-class entity.** A provider (Attestation Scheme Provider)
  owns rulebooks; publication authority is granted to a provider **account**, never
  inferred from a remote URL or a `rulebookURI` (FR-003, spec §5).
- **Ownership enforcement** is checked at the service layer, not only in the UI: a provider
  may mutate only its own rulebooks/versions; an external imported rulebook becomes owned by
  the importing provider only through an explicit, audited action.
- **Publication is an audited operation** (spec §15): who published, when, what digest,
  under which standard version.
- **Authorisation mechanism (D-10).** TS11 §5.2.2 does not yet define the concrete
  authorisation mechanism ("will be defined … in future version"). AttestBook therefore uses
  a provisional, self-contained bearer-token/actor model bound to provider accounts for write
  APIs, keeps public reads public, and does not claim a normative TS11 authorisation
  mechanism or expose a TS11 catalogue write API in Phase 1. Revisit when TS11 specifies it.

## 7. Initial data model

**Deliverable: initial data model.** This is a logical domain model for Phase 0, not the
final persistence schema (that belongs to Phase 1
[#28](https://github.com/ForkbombEu/credimi-attestbook/issues/28); the engine and storage
rules are D-7 in [`docs/implementation-plan.md`](implementation-plan.md) §5). Column "Field
class" marks **TS11** (normative wire field, held in the TS11 profile object), **OWF** (OWF
profile field) or **Internal** (AttestBook metadata, never serialized into a standards
document).

### 7.1 Core entities

| Entity | Key fields | Field class | Notes |
| --- | --- | --- | --- |
| **Provider** | `id`, `name`, `publicationAuthority` (account binding), `metadata` | Internal | Owns rulebooks; identity ≠ remote URL (FR-003) |
| **Rulebook** | `id` (stable), `name`, `description`, `providerId`, `sourceUrl`, `provenance`, `applicableSpec` (`ts11@1.0.1`), `supportedAttestationTypes[]`, `metadata`, `publicationStatus` | Internal | `id` here is AttestBook's stable identifier; the TS11 `SchemaMeta.id` (UUID) is a per-version wire value |
| **RulebookVersion** | `rulebookId`, `version` (SemVer), `status` (`draft`/`published`/`historical`), `contentDigest`, `publishedAt`, `provenance`, `specVersion`, `schemaRefs[]` | Internal | Published ⇒ immutable; new rulebook starts at `1.0` (TS11 §4.5.1) |
| **Attestation** (attestation type) | `id`, `rulebookId`, `name`, `attestationLoS`, `bindingType`, `supportedFormats[]`, `schemaRefs[]` | TS11 (values) + Internal (identity) | `attestationLoS`/`bindingType`/`supportedFormats` are TS11 enums but stored as extensible data |
| **SchemaReference** | `formatIdentifier`, `uri`, `integrity` (SRI), `resolvedContentRef` | TS11 (`formatIdentifier`, `uri`+`#integrity`) + Internal (resolved content, digest) | Resolved schema payloads are content-addressed (see §9) |
| **TrustAuthorityRef** | `frameworkType` (`aki`/`etsi_tl`/`openid_federation`), `value`, `isLoTE?` | TS11 | References only; AttestBook does not claim to *perform* trust resolution |
| **ImportRun / ImportReport** | `sourceId`, `adapterKind`, `fetchedAt`, `entries[]`, `conformance[]`, `conflicts[]` | Internal | Conformance classification per [#3](https://github.com/ForkbombEu/credimi-attestbook/issues/3) R4.4: `conformant_subset` / `partial` / `not_verified` / `prose_only` |
| **ValidationResult** | `id`, `rulebookId`, `rulebookVersion`, `rulebookDigest`, `attestationType`, `dimensions[]`, `findings[]`, `overallStatus` | Internal | See §8 |

### 7.2 Separation rules

- The **canonical domain model** holds the union of what AttestBook needs to operate; the
  **Standards Adapter** projects it into/out of TS11 and OWF wire shapes. Registry and
  validation code only ever see the domain model, never a raw wire object.
- **No internal field is serialized into a TS11/OWF document.** Provenance, digests, sync
  state and publication status live in the registry, not in the published artifact.
- **Unknown normative members are preserved** through import/export even if AttestBook does
  not interpret them, so a round-trip does not silently destroy data (OWF 0.5.4 strips
  unknown top-level members — the adapter must not).

## 8. Validation dimensions and status model

**Acceptance item: validation dimension status model (PASS/FAIL/NOT_TESTED/NOT_APPLICABLE/INCONCLUSIVE).**

Per spec FR-010, eight dimensions are kept separate; AttestBook's core engine owns
structural and attestation-constraint checks, while the rest are supplied by dedicated
libraries or external systems and only *reported*:

| # | Dimension | Phase 1 ownership | Not-ran default |
| --- | --- | --- | --- |
| 1 | Credential parsing | format parser (SD-JWT VC first) | NOT_TESTED |
| 2 | Credential format recognition | format parser | NOT_TESTED |
| 3 | Cryptographic verification | external crypto library | NOT_TESTED |
| 4 | Schema validation | AttestBook (JSON Schema / VCT / DocType) | NOT_TESTED |
| 5 | Attestation-specific constraints | AttestBook | NOT_TESTED |
| 6 | Issuer & trust-policy validation | external adapter | NOT_TESTED |
| 7 | Protocol conformance | external (OpenID4VCI/VP) | NOT_TESTED |
| 8 | End-to-end interoperability | external orchestration (Credimi) | NOT_TESTED |

**Status values** (FR-012): `PASS`, `FAIL`, `NOT_TESTED`, `NOT_APPLICABLE`, `INCONCLUSIVE`.

Rules:

- Each dimension reports its own status; the overall result is an **aggregation** adopted as
  D-8: **FAIL** if any dimension FAILs; else **INCONCLUSIVE** if any is INCONCLUSIVE; else
  **NOT_TESTED** if any applicable dimension was not executed; else **PASS** only when every
  applicable dimension PASSed; **NOT_APPLICABLE** only when no dimension is applicable.
  Per-dimension statuses are always returned. An overall PASS therefore never hides an
  untested dimension.
- **Never report a dimension PASS that was not executed.** A schema-valid credential with an
  invalid signature is not "fully valid"; a locally-passing credential is not "interoperable"
  (FR-012, AC-16, AC-17).
- Dimensions map 1:1 to the traceability matrix
  ([`docs/traceability.md`](traceability.md) from [#2](https://github.com/ForkbombEu/credimi-attestbook/issues/2)).

## 9. Reproducibility, content digest and immutable publication

**Acceptance item: reproducibility and content digest/version model defined.**

- **Versioning:** SemVer, new rulebook starts at `1.0` (TS11 §4.5.1). Draft → published →
  historical lifecycle; a published version is **immutable** and any change creates a new
  version (FR-002, FR-008, AC-05, AC-06).
- **Content digest:** AttestBook computes a SHA-256 digest over the **exact stored artifact
  bytes** and stores it with the version (D-6). Published bytes are immutable and
  content-addressed, so the digest is reproducible without a canonicalization library.
  OWF 0.5.4 has no canonicalization API (its only serialization is `JSON.stringify`), so
  semantic normalization is not assumed; if a canonical form is ever needed, RFC 8785 JCS
  is the recorded fallback rather than an implicit representation.
- **W3C SRI (`#integrity`):** when `rulebookURI` or `schemaURIs[].uri` carry a
  `#integrity` fragment, the consumer SHALL verify it (TS11 §4.3.1/§4.3.2, SR-19); AttestBook
  reuses OWF's SRI verification (sha256 only today) and records verification status honestly.
- **Reproducibility:** a validation run references the exact `rulebookVersion` **and** its
  `contentDigest` (FR-002, FR-022). The referenced schema payloads are content-addressed and
  cached so a past validation can be re-run against the same bytes.
- **Publication integrity:** where the standard defines signing (TS11 JWS catalogue
  responses), use the OWF signer behind the adapter's JOSE policy; do not invent proprietary
  signing semantics as a substitute for normative ones (FR-008).

## 10. Persistence tradeoffs

**Acceptance item: persistence tradeoffs.** The Phase 1 engine is decided in D-7: a single
SQLite database file behind a repository layer. PostgreSQL is not a Phase 1 dependency;
adopting it later needs its own decision and migration plan
([`docs/implementation-plan.md`](implementation-plan.md) §5).

Requirements that shape the choice (spec §17, FR-002, FR-003): immutable published
versions, content digests, provider ownership, reproducibility, portability, Docker,
"no mandatory external cloud services", simple local development, deterministic reads.

| Option | Strengths | Weaknesses vs requirements |
| --- | --- | --- |
| **Relational, single SQLite file (adopted for Phase 1)** | Strong integrity/ACID for immutable-version + ownership invariants; mature migrations; zero-config local dev and reproducible CI; no external service | Single-writer Phase 1 deployment; backup/replication are operator concerns; a later move to PostgreSQL is a separate decision |
| **Relational split: SQLite dev/test + PostgreSQL production (deferred)** | Production concurrency headroom while keeping local development simple | Two engines and dialects to keep compatible; adds a mandatory service for production; not needed to demonstrate the MVP |
| **Document store (MongoDB/CouchDB) (not adopted)** | Schema-less document mapping is natural for JSON artifacts | Adds a mandatory external service (conflicts with "no mandatory cloud services"); weaker cross-entity integrity (provider→rulebook→version) |

**Adopted direction (D-7):** relational persistence in a single SQLite database, with a
JSON column for the profile-specific document (TS11 or OWF wire object) alongside typed
columns for the fields AttestBook must query (provider id, version, status, digest, spec
version). Immutable published artifacts are additionally stored **content-addressed**
(digest → exact bytes) so publication and validation are byte-reproducible. SQLite gives
zero-config local development, a temporary-file test database and no mandatory external
service; the repository interface keeps a later PostgreSQL adoption possible without
changing the domain model. The single-writer limitation is documented as a Phase 1
deployment constraint, not hidden.

## 11. Security threat/risk outline

**Deliverable: security threat/risk outline for imported schemas and sensitive credentials.**
Synthesizes spec §15 with the observed import risks from
[#3](https://github.com/ForkbombEu/credimi-attestbook/issues/3) §6 and the JOSE findings from
[#1](https://github.com/ForkbombEu/credimi-attestbook/issues/1) §5.4. Controls are
**proposed**; none is implemented in Phase 0.

| # | Threat / risk | Evidence | Proposed control | Status |
| --- | --- | --- | --- | --- |
| T1 | **SSRF** via URL import, sync and issuer discovery (arbitrary remote URLs in `schemaURIs`, `schemaUrl`, discovery fetches) | SIROS/FIDES point at arbitrary remote URLs | `https`-only; resolve DNS; block private/link-local/loopback/metadata ranges; re-validate redirects; per-request timeouts | proposed |
| T2 | **Remote JSON Schema references** (`$ref` exfiltration / infinite recursion) | FIDES/Sphereon schemas use `$ref` | Restrict `$ref` to same-origin by default (or block remote refs); bound depth; no code execution | proposed |
| T3 | **Resource exhaustion** (oversized responses, large inline `data:` URIs, deep JSON) | FIDES `aggregated.json` ≈1.4 MB; SIROS VCTM embeds base64 `data:` logos | Max response size, max JSON depth/nodes, strip or reject oversized inline images, stream-parse | proposed |
| T4 | **JOSE header confusion / trust bypass** (permissive header, `alg`/key mismatch, missing `x5c`, synthesized `iat`) | OWF `verifySchemaMeta` accepts `alg:"none"`, `typ:"JWT"`, mismatched `alg`; returns unauthenticated header | Strict `typ`/`alg`/`kid`/`x5c` policy, algorithm allowlist, bind `alg` to key, verify chain/trust separately, never trust returned `iat` | proposed |
| T5 | **Sensitive credential data** in capture artifacts and validation inputs (personal data, tokens, keys) | spec §11/§15; capture artifacts carry credentials | Redaction by default; no logging of raw credentials/tokens/keys/attributes; separate sensitive raw artifacts from metadata; support external artifact references | proposed (contracts in `capture-integration.md`) |
| T6 | **Untrusted provider/schema trust** (auto-trusting remote catalogs or their claims) | sources differ in conformance; SIROS unsigned; FIDES self-reports partial | Never auto-trust; verify JWS where present; record `not_verified`/`unsigned` honestly; pin/refresh JWKS with rotation; provenance + digest | proposed |
| T7 | **Provider ownership / unauthorized publication** | spec §5, FR-003 | Provider-account binding; ownership enforced at service layer; audited publication; no URL-inferred authority | proposed |
| T8 | **Code execution from imported documents** | spec §15 | JSON Schema/Markdown treated as data only; never `eval`/`Function`/dynamic import | proposed |
| T9 | **Data preservation / round-trip loss** (adapter strips unknown fields) | OWF 0.5.4 strips unknown top-level members | Adapter preserves unknown normative members; lossless codec design | proposed |

## 12. Decisions adopted

**Acceptance item: architecture decisions recorded.** AD-1–AD-12 are no longer open. They
are adopted as D-1–D-12 in
[`docs/implementation-plan.md`](implementation-plan.md) §3, which is the authoritative
decision register with rationale, traceability, risks and the implementation issue that
verifies each decision. The table below preserves the original architecture context; if
the wording differs, the consolidated decision register wins.

| ID | Decision | Consolidated as |
| --- | --- | --- |
| AD-1 | Pin `@owf/eudi-attestation-schema` **0.5.4** exactly for the Phase 1 spike | D-1: adopted; 0.6.0-alpha is a prerelease on `@owf/*` 0.7.0-alpha |
| AD-2 | **Do not expose OWF `SchemaMeta` as the TS11 v1.0.1 public contract**; a version-aware codec with a canonical domain model is required | D-2: adopted |
| AD-3 | **Wrap JOSE verification** behind a strict header/trust policy | D-3: adopted, with ES256 first and no synthetic `iat` |
| AD-4 | **Pin TS11 v1.0.1** as the Phase 1 baseline and treat EN 319 482-3 as an evolving, UNVERIFIED target | D-4: adopted |
| AD-5 | Treat TS11/OWF **enumerated values as extensible data**, not closed unions | D-5: adopted |
| AD-6 | **Content-digest canonicalization** for reproducible digests | D-6: SHA-256 over exact stored bytes; RFC 8785 JCS only if semantic canonicalization is later required |
| AD-7 | **Persistence engine** (SQLite-only vs split vs embedded store) | D-7: SQLite single engine for Phase 1; PostgreSQL later needs a new decision |
| AD-8 | **Overall validation aggregation rule** across the eight dimensions | D-8: conservative aggregation, PASS only when every applicable dimension PASSed |
| AD-9 | Which `attestationLoS`/`bindingType` values the validator **enforces** vs merely surfaces | D-9: validate vocabulary/consistency only; no issuer-side enforcement (OQ-2) |
| AD-10 | Catalogue API **authorisation mechanism** (TS11 §5.2.2 unspecified) | D-10: provisional product bearer-token auth; no TS11 catalogue write API in Phase 1 (OQ-3) |
| AD-11 | How to **verify `#integrity` (SRI) safely** against untrusted remote content | D-11: SRI over SSRF-safe fetched bytes; sha256 only, other algorithms reported unsupported (OQ-4) |
| AD-12 | How to reflect the **ARF-vs-TS11 registration-obligation discrepancy** in import/registration UX | D-12: separate conformance/registration metadata, no inferred hard rule (OQ-1) |

## 13. Assumptions, unknowns and non-claims

- Phase 0 is consolidated; Phase 1 proceeds through issues #26–#39 under
  [`docs/implementation-plan.md`](implementation-plan.md). This document is not a
  conformance claim and does not authorize a production deployment.
- The OWF package version and its divergences are taken from the #1 audit; the TS11 field
  semantics from the #2 research; the import risks from the #3 survey. Those findings are
  the adopted baseline and are traceable from the implementation plan.
- **ETSI EN 319 482-3 draft v0.0.6 is UNVERIFIED** (not publicly accessible). No migration
  delta is claimed; only a version-aware adapter is adopted to absorb it later.
- **Credential validation is not executed in Phase 0**: the dimensions in §8 define the
  reporting model, not any tested capability.
- **Capture integration is not implemented**; see the companion
  [`docs/capture-integration.md`](capture-integration.md), which is explicitly *proposed*.
- The single-instance SQLite decision and the Bun 1.3.1 baseline are Phase 1 choices with
  documented limitations, not claims of production readiness.

## 14. References

- [`docs/specification.md`](specification.md) — authoritative requirements (spec §2, §4–§15, §17)
- [`docs/implementation-plan.md`](implementation-plan.md) — consolidated decisions and Phase 1 plan (#25)
- [`docs/standards.md`](standards.md) — OWF audit (#1) and TS11/ETSI research (#2)
- [`docs/requirements.md`](requirements.md) — requirement index and Phase 1 scope
- [`docs/traceability.md`](traceability.md) — requirements-to-clause/test matrix (#2)
- [`docs/catalog-research.md`](catalog-research.md) — external catalog survey (#3)
- [`docs/capture-integration.md`](capture-integration.md) — capture contracts (this ticket)
- Issues: [#1](https://github.com/ForkbombEu/credimi-attestbook/issues/1), [#2](https://github.com/ForkbombEu/credimi-attestbook/issues/2), [#3](https://github.com/ForkbombEu/credimi-attestbook/issues/3), [#4](https://github.com/ForkbombEu/credimi-attestbook/issues/4), [#25](https://github.com/ForkbombEu/credimi-attestbook/issues/25)
