AttestBook — Standards Traceability Matrix (Phase 0)
=====================================================

**Status:** Phase 0 consolidated matrix. It links AttestBook requirements (from
[`docs/specification.md`](specification.md)) and the standards obligations identified in
[`docs/standards.md`](standards.md) to their normative clauses and to the test categories in
[`docs/specification.md`](specification.md) §16. The Phase 1 slice order that delivers these
checks is in [`docs/implementation-plan.md`](implementation-plan.md) §9.

**Phase 0 document set:** [`docs/architecture.md`](architecture.md) ·
[`docs/standards.md`](standards.md) ·
[`docs/requirements.md`](requirements.md) ·
[`docs/capture-integration.md`](capture-integration.md) ·
[`docs/implementation-plan.md`](implementation-plan.md).

Two matrices follow:

- **Matrix A** — requirements → normative clauses (TS11 / ARF / legal / ETSI), obligation level, and validation dimension.
- **Matrix B** — requirements → tests (spec §16 categories), so each normative obligation has a planned check.

Obligation legend: **SHALL/MUST** (normative), **SHOULD** (recommended), **MAY** (permitted), **REF** (delegated to a referenced external standard), **DESIGN** (AttestBook product decision, not normative).

Dimension legend (spec FR-010): **STR** structural/schema · **CRYPTO** cryptographic · **TRUST** trust-policy · **PROTO** protocol conformance · **INTEROP** end-to-end interoperability · **GOV** governance/access · **SEC** security.

* * *

Matrix A — Requirements to normative clauses
--------------------------------------------

### A.1 Standards obligations (SR)

| ID | Requirement | Normative source | Obligation | Dimension |
|----|-------------|------------------|------------|-----------|
| SR-01 | `Attribute` data model (name, identifier, description, distributions, contactInfo, authenticSources, …) | TS11 §2.1; CIR (EU) 2025/1569 Art. 7 | SHALL | STR |
| SR-02 | Attribute schema media type `application/json-schema` | TS11 §2.1.2; CIR Art. 2(3) | SHALL | STR |
| SR-03 | `DataService` authentic-source triple (country / nationalSubID / endpoint) | TS11 §2.1.1 | SHALL | STR |
| SR-04 | Discovery interface (I1) | TS11 §3.1 → ETSI TS 119 478 §5.1 | REF | PROTO |
| SR-05 | Authentic-source verify (I2) / retrieve (I3) | TS11 §3.2 → ETSI TS 119 478 §6 | REF | PROTO |
| SR-06 | Attestation information elements (name, status, version, contact, laws/standards, issuance rules, formats, attributes, trust model, type) | TS11 §4.1; CIR Art. 8 | SHALL | STR |
| SR-07 | Human-readable Attestation Rulebook | TS11 §4.2; ARF §5.5.1 | SHALL (QEAA/PuB-EAA) | GOV |
| SR-08 | `SchemaMeta` fields and enums (`id`, `version`, `rulebookURI`, `trustedAuthorities`, `attestationLoS`, `bindingType`, `supportedFormats`, `schemaURIs`) | TS11 §4.3.1 | SHALL | STR |
| SR-09 | `Schema` sub-class (`formatIdentifier`, `uri`) | TS11 §4.3.2 | SHALL | STR |
| SR-10 | `TrustAuthority` sub-class (`frameworkType`, `value`, `isLOTE`) | TS11 §4.3.3 | SHALL | TRUST (reference) |
| SR-11 | Format-specific schema types (VCT / DocType / W3C VC) | TS11 §4.3.4 | SHALL | STR |
| SR-12 | SemVer versioning; new rulebook starts at 1.0 | TS11 §4.5.1 | SHALL | STR |
| SR-13 | Maintenance via versioning system + API | TS11 §4.5.2 | SHALL | STR |
| SR-14 | Write/delete authorised only for registering entity | TS11 §4.5.3, §5.2.2 | SHALL | GOV |
| SR-15 | API methods `GET/PUT/DELETE /schemas` + filters/pagination | TS11 §5.1, §5.3 | SHALL | PROTO |
| SR-16 | JWS-signed API responses | TS11 §5.3.1, §5.3.2 | SHALL | CRYPTO (metadata) |
| SR-17 | Public read access | TS11 §5.2.1 | SHALL | GOV |
| SR-18 | DDoS / misuse protection | TS11 §5.4 (SHALL consider) / §5.5–§5.6 (SHOULD mitigations) | SHALL/SHOULD | SEC |
| SR-19 | `#integrity` (W3C SRI) verification for `rulebookURI` / `Schema.uri` | TS11 §4.3.1, §4.3.2 | SHALL (when present) | CRYPTO (integrity) |
| SR-20 | Rulebook (human) vs scheme (machine) vs catalogue split | ARF §5.5.1 | normative | STR |
| SR-21 | Rulebook provider roles | ARF §5.5.2 | normative | GOV |
| SR-22 | Machine-readable scheme per TS11 supplied on catalogue publication | ARF §5.5.3 | REF → TS11 | STR |
| SR-23 | Catalogue-of-attestation-schemes principles | ARF §5.6.3 | normative | GOV |
| SR-24 | Legal basis: Article 45e, CIR Arts 7 & 8 | Reg. (EU) 910/2014; CIR (EU) 2025/1569 | legal | GOV |

### A.2 AttestBook functional requirements (FR) → clauses

| FR | Requirement (short) | Primary clause | Obligation | Dimension |
|----|---------------------|----------------|------------|-----------|
| FR-001 | Rulebook management & metadata (normative vs internal fields) | TS11 §4.1, §4.3.1; ARF §5.5 | SHALL (normative fields) / DESIGN (internal) | STR |
| FR-002 | Versioning, immutability, digests | TS11 §4.5.1 (SemVer); TS11 §4.3.1 (`#integrity`) | SHALL | STR |
| FR-003 | Provider management, ownership | TS11 §4.5.3; ARF §5.5.2 | SHALL | GOV |
| FR-004 | External rulebook/schema import | TS11 §4.3 (machine-readable), §4.2 (rulebook) | SHALL (structural import) | STR |
| FR-006 | Issuer metadata discovery | OpenID4VCI (not TS11) | REF | PROTO |
| FR-007/008 | Editor & publication | TS11 §4.5 (governance), §5 (API) | SHALL (governance/publication) / DESIGN (editor UI) | STR |
| FR-009/010 | Validation API & dimension separation | TS11 §4.3 (structural only); spec FR-010 | SHALL (STR) / REF (others) | STR/CRYPTO/TRUST/PROTO/INTEROP |
| FR-011 | Credential format support | TS11 §4.3.4 (`dc+sd-jwt`, `mso_mdoc`, W3C VC) | SHALL (format recognition) | STR |
| FR-012 | Result taxonomy incl. NOT_TESTED / INCONCLUSIVE | spec FR-012 (no TS11 clause) | DESIGN | — |
| FR-013/014 | Issuer/verifier fixtures | OpenID4VCI/OpenID4VP (not TS11) | REF | PROTO |
| FR-019 | Correlation & traceability | TS11 §4.5.1 (version), `#integrity` (digest) | SHALL | STR |

> FR-005 (catalog synchronization), FR-015–FR-018 (capture integration) and
> FR-020–FR-022 (Credimi orchestration) are deliberately omitted from this
> matrix: they are product/synchronization/capture/Credimi features with no
> direct TS11 / ARF / legal normative clause; their test mapping is defined in
> `docs/specification.md` §16 instead.

* * *

Matrix B — Requirements to tests (spec §16)
--------------------------------------------

Test categories (spec §16): **standards**, **registry**, **validation**, **capture**, **integration**. Mapping of each SR/FR to the concrete planned check. Rows marked "Implemented in #27/#28/#29" name the adapter tests in `src/standards/` or the registry tests in `src/db/`/`src/registry/`; anything still listed as planned or unimplemented has no passing check yet.

| ID | Requirement | Test category | Planned check | Dimension verified |
|----|-------------|---------------|---------------|--------------------|
| SR-01/08 | Attribute + SchemaMeta models | standards | Implemented in #27: valid/invalid metadata, missing required fields, unknown-member/unknown-value handling (`src/standards/ts11-codec.test.ts`, `src/standards/owf-codec.test.ts`); registry-level version checks remain planned | STR |
| SR-02 | `application/json-schema` media type | standards | media type present/absent | STR |
| SR-09/11 | `Schema` + format-specific types (VCT/DocType/W3C) | standards | Implemented in #27: TS11 `Schema` references and `formatIdentifier` ↔ schema consistency (`src/standards/ts11-codec.test.ts`); credential-level W3C/format parsing remains planned (#32) | STR |
| SR-10 | `TrustAuthority` | standards | Implemented in #27: framework type/value/isLOTE validity and TS11↔OWF trust-authority mapping (`src/standards/ts11-codec.test.ts`, `src/standards/owf-codec.test.ts`); trust resolution remains NOT_TESTED | TRUST (reference) |
| SR-12/13 | Versioning & maintenance | registry | Implemented in #29: per-rulebook SemVer labels, version-specific retrieval and immutable published/historical versions (`src/registry/versions.test.ts`, `src/db/migrations.test.ts`); version comparison/diff and the version-history UI remain #37 | STR |
| SR-14 | Registration ownership | registry | Implemented in #28: server-side provider ownership on every mutation, cross-provider denial and public-read checks (`src/registry/authorization.test.ts`); HTTP write endpoints remain #35 | GOV |
| SR-16 | JWS-signed responses | standards / integration | Implemented in #27 for the OWF-profile compact JWS (`src/standards/jose.test.ts`); the TS11 catalogue list envelope `{iss, iat, data}` remains unimplemented and is reported as an unsupported operation | CRYPTO (metadata) |
| SR-19 | `#integrity` SRI | standards / validation | Implemented in #27 for sha256 schema-reference SRI through OWF; disabling verification is reported `not_tested` (`src/standards/references.test.ts`); rulebook `#integrity` byte verification and non-sha256 SRI remain unimplemented (#30) | CRYPTO (integrity) |
| SR-15/17 | API methods + public read | integration | Implemented in #28 for public read services (providers, rulebooks, attestations, schema references); HTTP methods, filters/pagination and the OpenAPI contract remain #34 | PROTO |
| SR-18 | DDoS/misuse limits | integration | §5.4 SHALL consideration; §5.5–§5.6 rate/query limits (SHOULD) | SEC |
| FR-001 | Rulebook management & metadata boundary | registry | Implemented in #28: rulebook/attestation/schema-reference CRUD with internal metadata kept in separate columns and JSON, duplicate and invalid-write rejection (`src/registry/registry.test.ts`, `src/db/migrations.test.ts`); versions/digests added in #29 (`src/registry/versions.test.ts`) | STR |
| FR-002 | Versioning/digest reproducibility | registry | Implemented in #29: draft/published/historical versions, deterministic snapshot bytes and SHA-256 digest, version-specific and by-digest retrieval, digest verification, stale-snapshot conflict, and immutable published/historical rows at service and SQL level (`src/registry/versions.test.ts`, `src/db/migrations.test.ts`); a validation run recording the exact version and digest is #32, version comparison is #37 | STR |
| FR-003 | Provider management, ownership | registry | Implemented in #28: provider provisioning, hashed bearer tokens, token revocation and cross-provider denial (`src/registry/authorization.test.ts`); secure write HTTP APIs are #35 | GOV |
| FR-004 | Import | registry | Implemented in #30: bounded https URL/JSON import, catalog preview, structural validation, conformance/compatibility report and provenance (`src/import/*.test.ts`, `src/registry/create-rulebook-refs.test.ts`); re-import/conflicts remain #31 and the HTTP import API #34 | STR |
| FR-009/010 | Validation API + dimensions | validation | valid/invalid credential; missing attributes; wrong types; unsupported formats | STR |
| FR-010 (negative) | "schema valid ≠ crypto valid", "crypto ≠ trust", "rulebook ≠ protocol", "protocol ≠ interoperability" | validation | explicit negative tests proving each implication does **not** hold | CRYPTO/TRUST/PROTO/INTEROP |
| FR-011 | Format support | validation | SD-JWT VC recognition; mdoc/other marked NOT_TESTED until real parser | STR |
| FR-006/013/014 | Issuer/verifier discovery & fixtures | integration | OpenID4VCI metadata discovery; negative fixture generation | PROTO |
| FR-019 | Correlation/traceability | capture / integration | rulebook version + digest + result correlation | STR |

* * *

Notes and status
----------------

- Every dimension other than **STR** (and the metadata-level **CRYPTO** of JWS/SRI) is **delegated to an external specification** (OpenID4VCI, OpenID4VP, ISO/IEC 18013-5, SD-JWT, ETSI Trusted Lists/LoTE). AttestBook's engine must not report PASS for those dimensions unless the corresponding external check actually ran (AC-16, AC-17).
- **ETSI EN 319 482-3** has no entries here because its draft text is not publicly accessible (see `docs/standards.md` §6, §8). It will be added as a column once the draft is readable or published; until then the matrix's normative anchor is **TS11 v1.0.1**.
- "Unsupported" / "ambiguous" / "draft" / "unverified" items are enumerated in `docs/standards.md` §8 and should be cross-referenced by any test marked NOT_TESTED or INCONCLUSIVE.
