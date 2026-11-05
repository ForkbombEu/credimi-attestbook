AttestBook — Standards Traceability Matrix (Phase 0)
=====================================================

**Status:** research draft. This matrix links AttestBook requirements (from `docs/specification.md`) and the standards obligations identified in `docs/standards.md` to their normative clauses and to the test categories in `docs/specification.md` §16.

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

Test categories (spec §16): **standards**, **registry**, **validation**, **capture**, **integration**. Mapping of each SR/FR to the concrete planned check.

| ID | Requirement | Test category | Planned check | Dimension verified |
|----|-------------|---------------|---------------|--------------------|
| SR-01/08 | Attribute + SchemaMeta models | standards | valid/invalid metadata; missing required fields; unsupported versions | STR |
| SR-02 | `application/json-schema` media type | standards | media type present/absent | STR |
| SR-09/11 | `Schema` + format-specific types (VCT/DocType/W3C) | standards | schema reference handling; format identifier ↔ schema type | STR |
| SR-10 | `TrustAuthority` | standards | framework type/value/isLOTE validity | TRUST (reference) |
| SR-12/13 | Versioning & maintenance | registry | version comparison; immutable published artefacts | STR |
| SR-14 | Registration ownership | registry | provider ownership enforcement | GOV |
| SR-16 | JWS-signed responses | standards / integration | JWS verify for GET/PUT (OWF SDK) | CRYPTO (metadata) |
| SR-19 | `#integrity` SRI | standards / validation | integrity digest present → verify; absent → skip | CRYPTO (integrity) |
| SR-15/17 | API methods + public read | integration | OpenAPI contract; GET filters/pagination | PROTO |
| SR-18 | DDoS/misuse limits | integration | §5.4 SHALL consideration; §5.5–§5.6 rate/query limits (SHOULD) | SEC |
| FR-002 | Versioning/digest reproducibility | registry | version mismatch detection; digest verification | STR |
| FR-004 | Import | registry | URL/JSON import; conflict detection; malformed input | STR |
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
