# AttestBook — Requirements (Catalog Discovery & Import domain)

**Status:** Phase 0 draft — research-derived requirements for the external catalog / discovery / import domain only.  
**Authoritative spec:** [`docs/specification.md`](../docs/specification.md)  
**Evidence:** [`docs/catalog-research.md`](../docs/catalog-research.md) (survey of SIROS, EUDIPLO, FIDES, EUDI reference and Sphereon)  
**Scope note:** This file currently records the requirements tied to specification FR-004, FR-005 and FR-006 plus the import-relevant security controls. Other functional domains (registry, editor, validation engine, capture, Credimi integration) are covered by their own Phase 0 tickets and will be consolidated with [`docs/architecture.md`](../docs/architecture.md) and [`docs/implementation-plan.md`](../docs/implementation-plan.md).

Requirements are marked with their verification status against the current research: **VERIFIED** (observed in a live source during the survey), **DOCUMENTED** (claimed by the source but not observed), or **DESIGN** (AttestBook-internal decision, not yet implemented).

* * *

## FR-004 — External rulebook import

The system MUST implement an adapter-based import system (specification FR-004).

**R4.1 — Adapter-based import (DESIGN).** Import goes through per-source adapters over one normalized, TS11-aligned internal model. Adapter families identified by the survey: `UrlCatalogAdapter` (direct JSON URL), `SirosCatalogAdapter`, `FidesCatalogAdapter`, `MarkdownRulebookAdapter` (EUDI rulebooks), and `IssuerDiscoveryAdapter` (OID4VCI, see FR-006).

**R4.2 — URL import (DESIGN).** Support importing from an `https` URL with SSRF protection, timeouts and size limits (see SR-1..SR-5).

**R4.3 — JSON file import (DESIGN).** Support local JSON file upload with the same validation and limits as URL import.

**R4.4 — No assumed TS11 compliance (VERIFIED need; DESIGN mechanism).** The survey confirms sources differ in TS11 conformance (SIROS: self-declared read-only TS11 §5 subset; FIDES: self-reported `conformance.level: "partial"` with missing fields enumerated; EUDI rulebooks: prose-only). The importer MUST classify each imported entry's conformance (`conformant_subset` / `partial` / `not_verified` / `prose_only`) and surface it, never silently treating partial or non-TS11 content as full TS11.

**R4.5 — Structural validation & compatibility reporting (DESIGN).** Validate imported structure against the normalized model and produce a compatibility report (per source and per entry) that includes the source's own conformance signal where available.

**R4.6 — Import preview (DESIGN).** Provide a preview of what will be imported before committing it to the registry.

**R4.7 — Provenance preservation (DESIGN).** Record source URL, fetch timestamp, adapter kind and (where exposed) the source's version/last-built/`updatedAt` signals. Because no surveyed source publishes a per-entry content digest, AttestBook MUST compute and store its own content digest.

**R4.8 — Version conflict detection & safe re-import (DESIGN).** Detect version/identity conflicts on re-import and never silently overwrite locally edited or published rulebooks (also FR-005).

## FR-005 — Catalog synchronization

**R5.1 — Conditional fetching (VERIFIED capability for SIROS).** SIROS serves `ETag`/`Last-Modified` with `cache-control: max-age=600`; the SIROS adapter SHOULD use conditional requests. Sources without conditional support are re-fetched and diffed by digest.

**R5.2 — Idempotent imports & change detection (DESIGN).** Imports are idempotent; change detection uses AttestBook-side content digests (no source exposes a reliable digest).

**R5.3 — Conflict reporting & version preservation (DESIGN).** Report conflicts explicitly; preserve historical versions; published artifacts remain immutable.

**R5.4 — Source availability diagnostics (DESIGN).** Report per-source availability (reachability, schema changes, signature status) distinctly from import failures.

**R5.5 — Signature verification (VERIFIED for FIDES; DOCUMENTED for SIROS).** FIDES signs its `schemas` endpoint (ES256, `kid: fides-cat-2026-v1`) and publishes a JWKS; verify it and refresh keys on rotation. SIROS documents JWS but does not currently enable it (JWKS 404 observed); treat unsigned SIROS JSON as the current reality and record `unsigned`.

## FR-006 — Issuer metadata discovery

**R6.1 — OID4VCI discovery (VERIFIED mechanism; DESIGN integration).** Given a Credential Issuer URL, fetch `/.well-known/openid-credential-issuer`. EUDIPLO and Sphereon both implement/serve this (source-verified).

**R6.2 — Version-aware metadata (VERIFIED need).** Sphereon ships metadata builders/clients for two OID4VCI draft generations (v1.0 and 1.15); the discovery adapter MUST be version-aware and not assume one metadata shape.

**R6.3 — Extract configurations, formats, type identifiers, schema refs (DESIGN).** Extract `credential_configurations_supported`, credential format, type identifier (`vct`/`doctype`) and any exposed schema references.

**R6.4 — Rulebook association & manual mapping (DESIGN).** Attempt to associate configurations with known rulebooks; report unmatched/ambiguous configurations; allow explicit manual mapping.

**R6.5 — Not authoritative (DESIGN, per spec FR-006).** Issuer metadata MUST NOT be treated as an authoritative Attestation Rulebook.

## Security controls (import/discovery-relevant subset of specification section 15)

**SR-1 — SSRF protection (DESIGN).** URL import, sync and issuer discovery fetch remote resources; restrict to `https`, validate and resolve DNS, and block private/link-local/loopback/cloud-metadata ranges. Redirects MUST be re-validated.

**SR-2 — Safe URL validation (DESIGN).** Reject non-`https` schemes and malformed URLs before any network I/O.

**SR-3 — Network timeouts & response size limits (DESIGN).** Enforce per-request timeouts and maximum response sizes. FIDES `aggregated.json` is ~1.4 MB; SIROS VCTM payloads embed large `data:` URI logos — impose parse limits and strip/reject oversized inline images.

**SR-4 — JSON parsing limits & JSON Schema reference controls (DESIGN).** Bound JSON depth/node counts; restrict remote `$ref` resolution (same-origin only by default) and bound recursive-reference depth. Never execute imported documents.

**SR-5 — Resource consumption & secret redaction (DESIGN).** Bound concurrent fetches and total import cost; do not log raw metadata responses, tokens, or embedded URIs.

## Requirements-to-evidence traceability (summary)

| Requirement | Source | Evidence | Status |
|---|---|---|---|
| R4.4 no assumed TS11 | SIROS, FIDES, EUDI | observed conformance signals | VERIFIED need |
| R5.1 conditional fetch | SIROS | `ETag`/`Last-Modified`, `max-age=600` | VERIFIED |
| R5.5 signature verification | FIDES (live JWS + JWKS), SIROS (documented only) | decoded JWS; JWKS 404 | VERIFIED / DOCUMENTED |
| R6.1 OID4VCI discovery | EUDIPLO, Sphereon | source tree | VERIFIED mechanism |
| R6.2 version-aware | Sphereon | v1.0 + 1.15 builders/clients | VERIFIED need |
