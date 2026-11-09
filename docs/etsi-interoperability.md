# ETSI EN 319 482-3 migration and external interoperability assessment

**Status:** Phase 6 assessment for
[issue #54](https://github.com/ForkbombEu/credimi-attestbook/issues/54). It compares the
implemented EC TS11 v1.0.1 behaviour and the pinned OWF 0.5.4 adapter against the public
ETSI EN 319 482-3 draft **v0.0.7 (2026-11)** and against selected external catalogues. It
records what is supported, partially supported, unsupported and untested. It is not a TS11,
ETSI, cryptographic, trust, protocol or end-to-end interoperability conformance claim.

**Authoritative spec:** [`docs/specification.md`](specification.md) §3 (standards), Phase 6
(hardening and standards evolution).
**Baseline:** [`docs/standards.md`](standards.md) Part II.
**Adapter:** [`docs/standards-adapter.md`](standards-adapter.md).
**External catalog survey:** [`docs/catalog-research.md`](catalog-research.md).
**Traceability:** [`docs/traceability.md`](traceability.md) Matrix D.
**Executable evidence:** [`src/standards/interoperability.test.ts`](../src/standards/interoperability.test.ts).
**Fixture provenance:** [`src/standards/test/interop-fixtures/README.md`](../src/standards/test/interop-fixtures/README.md).

## 1. Scope, sources and exact versions

The issue asks for a comparison against ETSI EN 319 482-3 **draft v0.0.6 (27 October
2026)**. That revision was never retrievable from the public ETSI draft directory during
Phase 0 or during this assessment. The public draft now available is **v0.0.7 (2026-11)**;
this assessment reads v0.0.7 and does **not** claim a v0.0.6 → v0.0.7 delta. Every version
below is named exactly because "TS11" and "ETSI" alone are not stable identifiers.

| Source | Exact version / date | State at assessment | Evidence |
| --- | --- | --- | --- |
| EC TS11 | **v1.0.1**, 2026-01-30 | verified, implemented baseline | [`docs/standards.md`](standards.md) Part II §2–§3 |
| ETSI EN 319 482-3 | draft **v0.0.7**, 2026-11, ref. DEN/ESI-0019482-3 | read 2026-11-09 from the ETSI open draft directory; **work in progress**, call for comments closes 2026-12-06 | PDF SHA-256 `496ee139330b5fe47a2e1a3ba5d8be5f066416166d7cbd58affe5e0969629604`; Annex E schema fixture |
| EUDI ARF | **3.0.0**, tag 2026-07-21 | verified baseline (Phase 0) | [`docs/standards.md`](standards.md) Part II §4 |
| OWF package | `@owf/eudi-attestation-schema` **0.5.4**, published 2026-10-30 | implemented, pinned exactly | `package.json`; [`docs/standards-adapter.md`](standards-adapter.md) |
| SIROS Credential Type Registry | response captured **2026-11-09T12:08:53Z** (`ETag "6af1b7d5-3df8"`), 32 entries | captured, TS11-shaped subset, unsigned | `src/standards/test/interop-fixtures/siros-schemas-2026-11-09.json` |
| FIDES Community Credential Catalog | signed response captured **2026-11-09** (`kid fides-cat-2026-v1`), 121 entries | captured, ES256 signature verified offline | `src/standards/test/interop-fixtures/fides-schemas-2026-11-09.jwt` |
| EUDI Wallet Attestation Rulebooks Catalog | Markdown repository, inspected 2026-11-09 | **not machine-readable**; no SchemaMeta document | [`docs/catalog-research.md`](catalog-research.md) §3.1 |
| EUDIPLO, Sphereon, Credimi | reference implementations / adapters | **NOT_TESTED live** in this ticket | [`docs/catalog-research.md`](catalog-research.md) §3.4–§3.5 |

The ETSI draft is explicitly draft material: ETSI labels the PDF a working document that
must not be cited other than as work in progress. This document follows that restriction.
A claim about ETSI requirements means "the public v0.0.7 draft says", never "the published
standard requires".

## 2. What draft v0.0.7 requires for `SchemaMeta`

Draft v0.0.7 identifies the common machine-readable metadata object in **SCH-AD-6.4-01**
and normatively fixes its model and JSON Schema in **Annex E (E.1 data model, E.2 JSON
Schema)**. The relevant requirements are:

- **SCH-AD-5.3-04:** a scheme request "shall include a common machine-readable metadata
  object connecting the human-readable Attestation Rulebook with the relevant
  format-specific schemas as defined in chapter 6.4".
- **SCH-AD-6.4-01(a–k):** the object shall be represented as a **JWT**; carry an `id`;
  optionally carry `iat`; identify the schema `version`; reference the rulebook with
  `rulebookURI`; include `rulebookIntegrity`; optionally include `trustedAuthorities`;
  specify `attestationLoS` and `bindingType`; include one or more format-specific
  `schemaURIs`; and conform to the Annex E JSON Schema.
- **SCH-AD-6.4-02:** the catalogue provider's policy names the entity that signs the
  `SchemaMeta` JWT.
- **SCH-AD-6.4-03:** every `schemaURIs` entry includes a `formatIdentifier`, a schema URI,
  and `integrity`.
- **SCH-AD-6.4-04 / -05:** `dc+sd-jwt` entries carry `meta.vct`; `mso_mdoc` entries carry
  `meta.doctype_value`.
- **Annex E.2:** `additionalProperties: false` throughout; only `dc+sd-jwt` and `mso_mdoc`
  formats; only the `etsi_tl` trust framework; `trustedAuthorities` is 0..1; `id`,
  `rulebookURI`, `rulebookIntegrity`, `attestationLoS`, `bindingType` and `schemaURIs` are
  required; `version` is an unconstrained string.
- **SCH-CM-5.1-05 to -12:** the catalogue maintainer publishes the catalogue through a
  secure, public, machine-readable and human-readable channel and publishes the technical
  specifications it uses. The draft does **not** define a scheme-catalogue API (paths,
  methods, response envelope or signing profile) — see §4.

One draft-internal difference is worth naming: E.1 lists `trustedAuthorities` as **0..1**,
but the E.2 JSON Schema does not encode `maxItems: 1`. This assessment applies the stricter
data model (at most one authority) and records the schema annotation as a draft defect, not
as permission for an unbounded array.

## 3. Compatibility matrix

Status legend: **SUPPORTED** means the executed check passes for the stated subset;
**PARTIAL** means it works only with a documented difference or in one direction;
**UNSUPPORTED** means the current adapter rejects a document that satisfies the draft;
**NOT_TESTED** means no executable check exists; **UNSPECIFIED** means the draft states no
requirement. "OWF form" means the AttestBook adapter's `owf@0.5.4` profile, which delegates
structural validation to the real pinned package.

The matrix compares three revisions: **ETSI EN 319 482-3 draft v0.0.7 (2026-11)**,
**EC TS11 v1.0.1 (2026-01-30)**, and **AttestBook 0.1.0 + OWF 0.5.4**.

| # | ETSI draft v0.0.7 requirement | EC TS11 v1.0.1 baseline | AttestBook + OWF 0.5.4 behaviour | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| 1 | `SchemaMeta` represented as a JWT (SCH-AD-6.4-01(a)) | TS11 §5.3 signs catalogue API responses; the `SchemaMeta` response body is JSON | OWF-profile compact JWS sign/verify over a canonical `SchemaMeta`; an Annex E-shaped payload round-trips with `typ: attestation-schema+jwt` | PARTIAL — compatible subset only; no ETSI-specific envelope/profile | `signs and verifies an Annex E-shaped SchemaMeta as a JWT` |
| 2 | Required `id`, JSON Schema `format: uri` (SCH-AD-6.4-01(b), Annex E) | `id` optional, UUID, server-assigned | OWF form requires an `id`; the adapter rejects a non-URL id | SUPPORTED for the OWF form | `accepts an Annex E-valid SchemaMeta...`; `rejects a non-URI id...`; URI-format enforcement is annotation-only in the test Ajv configuration |
| 3 | Optional numeric `iat` | No `SchemaMeta` `iat` member | OWF accepts and preserves `iat`; signing stamps a fresh value | PARTIAL — a caller's `iat` is replaced on signing, which the draft permits | `signs and verifies an Annex E-shaped SchemaMeta as a JWT` |
| 4 | `version` is any string | SemVer required (TS11 §4.5.1) | Both adapter profiles enforce SemVer; `version: "1.5"` is rejected | PARTIAL — stricter than the draft; an ETSI-valid document can be rejected | `requires a SemVer version label that draft Annex E does not require` |
| 5 | Required `rulebookURI` | Required | Supported in both profiles | SUPPORTED | `accepts an Annex E-valid SchemaMeta...` |
| 6 | Required separate `rulebookIntegrity` | Optional `#integrity` fragment on `rulebookURI` | OWF form requires and preserves `rulebookIntegrity`; TS11 form is preserved separately | SUPPORTED in the OWF form; TS11 documents are not ETSI-conformant | `rejects TS11 v1.0.1-shaped metadata under the draft ETSI schema` |
| 7 | `trustedAuthorities` 0..1; only `etsi_tl`; `frameworkType` + `value` only | 0..*, `aki` / `etsi_tl` / `openid_federation`, optional `isLOTE` | OWF form requires an `X509Certificate` `verificationMethod` on `etsi_tl` and allows `x509`; a minimal Annex E `etsi_tl` entry is rejected | **UNSUPPORTED — blocking migration gap** | `rejects the Annex E etsi_tl trust authority...` |
| 8 | `attestationLoS` enum | Same four values | Same four values | SUPPORTED | `accepts an Annex E-valid SchemaMeta...` |
| 9 | `bindingType` enum | Same four values | Same four values | SUPPORTED | `accepts an Annex E-valid SchemaMeta...` |
| 10 | `schemaURIs` 1..*, each with `formatIdentifier`, `uri`, `integrity`, `meta` | `formatIdentifier` + `uri`; optional `#integrity`; no `meta` | OWF form matches the Annex E per-entry shape | SUPPORTED in the OWF form | `accepts an Annex E-valid SchemaMeta...` |
| 11 | Only `dc+sd-jwt` and `mso_mdoc` | Five formats (`dc+sd-jwt`, `mso_mdoc`, `jwt_vc_json`, `jwt_vc_json-ld`, `ldp_vc`) | OWF form allows exactly the two draft formats | SUPPORTED for the ETSI subset; TS11-only formats are ETSI-invalid | `rejects TS11 v1.0.1-shaped metadata under the draft ETSI schema` |
| 12 | Strict `meta` (`vct` or `doctype_value`, no extras) | No `meta` member | OWF `meta` is a strict superset with optional `credential_metadata` and `sd_jwt_vc_metadata`; those documents are accepted by the adapter but rejected by Annex E | PARTIAL — OWF-valid is not always ETSI-valid | `rejects OWF-only members that the draft ETSI schema forbids` |
| 13 | `additionalProperties: false` everywhere | Preserves unknown members | OWF parse preserves unknown members; the strict validation variant rejects them; the default path does not enforce Annex E strictness | PARTIAL — strictness is available, not the default | `rejects OWF-only members that the draft ETSI schema forbids` |
| 14 | No top-level `supportedFormats` | Required top-level `supportedFormats` | OWF form derives formats from `schemaURIs`; TS11 form keeps `supportedFormats` | PARTIAL — TS11 documents are ETSI-invalid | `rejects TS11 v1.0.1-shaped metadata under the draft ETSI schema` |
| 15 | No `issuanceProfile` | No `issuanceProfile` | OWF form has an optional `issuanceProfile`; the adapter accepts it, Annex E rejects it | PARTIAL — OWF-only extension | `rejects OWF-only members that the draft ETSI schema forbids` |
| 16 | No scheme-catalogue API specified; only publication/technical-specification duties (SCH-CM-5.1-05..12) | TS11 §5: `GET/PUT/DELETE /schemas`, filters, pagination, JWS-signed responses | AttestBook exposes its own product REST API, not a TS11 catalogue API and not an ETSI catalogue API | NOT_TESTED / UNSPECIFIED — no API migration can be claimed | [`docs/api.md`](api.md); `src/api/openapi.test.ts` |
| 17 | Catalogue policy names the `SchemaMeta` JWT signer (SCH-AD-6.4-02) | Not specified by TS11 | Signing is caller-provided; AttestBook validates the JOSE policy but does not decide the signer or validate trust | NOT_TESTED | [`docs/standards-adapter.md`](standards-adapter.md) §6–§7 |
| 18 | Version/governance requirements (SCH-AD-5.3, CIR (EU) 2025/1569 Art. 8) | TS11 §4.5 SemVer and lifecycle | Registry pins a per-version `specVersion`, digest and immutable snapshot; no ETSI `specVersion` value or migration exists | PARTIAL / NOT_TESTED — persistence exists, ETSI metadata does not | `src/registry/versions.test.ts`; `src/conformance/result.test.ts` |

### 3.1 Reading the matrix

The important result is structural: **draft v0.0.7 `SchemaMeta` is much closer to OWF 0.5.4
than to TS11 v1.0.1.** Both put integrity in a separate `rulebookIntegrity` member, both
require per-schema `integrity` and `meta`, both restrict the format set to `dc+sd-jwt` and
`mso_mdoc`, and both use `etsi_tl` as the trust framework. The adapter's OWF profile already
accepts an Annex E-valid document when it has no trust authorities. That does not make the
adapter ETSI-conformant: it is a basis for a future versioned profile, not proof of one.

The two blocking gaps for an Annex E-valid document are the trust-authority shape and the
stricter SemVer rule. The reverse direction has gaps too: an Annex E document cannot carry
`issuanceProfile`, `credential_metadata`, `x509`, unknown members, or the TS11
`supportedFormats` member.

## 4. Migration gaps and API changes

### 4.1 Data-model delta, TS11 v1.0.1 → draft v0.0.7

| TS11 v1.0.1 | Draft v0.0.7 | Migration consequence |
| --- | --- | --- |
| `id` optional, UUID | `id` required, URI | Every rulebook needs a stable URI identifier before an ETSI document can be produced; a TS11 UUID alone does not satisfy the Annex E `uri` format. |
| `rulebookURI#integrity=` optional SRI fragment | Separate required `rulebookIntegrity` | Split the fragment into a distinct member and require it. Silent omission is not allowed. |
| `Schema.uri#integrity=` optional | Required `integrity` member per entry | Move every SRI value into the member; entries without one cannot be converted. |
| No per-schema type metadata | Required `meta.vct` / `meta.doctype_value` | The TS11 `SchemaMeta` does not carry the typed identifier; it must come from the referenced type metadata or be supplied by the converter. |
| `supportedFormats` required | Removed; formats are the `schemaURIs` entries | Drop the top-level member; derive or validate from entries. |
| Five formats | Two formats | `jwt_vc_json`, `jwt_vc_json-ld` and `ldp_vc` have no Annex E representation; conversion is impossible without a lossy product decision. |
| `trustedAuthorities` 0..*, `aki` / `etsi_tl` / `openid_federation`, optional `isLOTE` | 0..1, `etsi_tl` only | `aki`, `openid_federation` and `isLOTE` cannot be represented; one authority maximum. |
| `SchemaMeta` JSON body inside a JWS-signed API response | `SchemaMeta` itself is a JWT | Signing identity and key management move from the catalogue response to the metadata object; SCH-AD-6.4-02 requires a policy decision on the signer. |
| `version` SemVer | `version` arbitrary string | An ETSI document may use a label AttestBook's adapter currently rejects; stored SemVer history cannot be assumed. |

### 4.2 Blocking gaps found in the current adapter

1. **Trust authority.** A minimal Annex E `trustedAuthorities` entry is schema-valid but the
   OWF codec rejects it because OWF 0.5.4 requires an `X509Certificate`
   `verificationMethod` for `etsi_tl`. This is the single largest model gap; it is recorded
   as a failed test, not papered over.
2. **Version label.** Annex E constrains `version` only to a string, while both adapter
   profiles require SemVer (from TS11 §4.5.1). The assessment keeps the stricter behaviour
   and records that an ETSI-valid document can be rejected.

### 4.3 Reverse gaps (accepted now, invalid under draft v0.0.7)

`issuanceProfile`, `schemaURIs[*].meta.credential_metadata`, `x509` trust authorities and
preserved unknown members are accepted by the OWF profile but forbidden by Annex E's
`additionalProperties: false` and narrowed enums. They must not be emitted in an ETSI
document.

### 4.4 API changes

Draft v0.0.7 does **not** replace TS11 §5 with a scheme-catalogue API. It requires the
catalogue maintainer to publish a secure, public, machine-readable and human-readable
catalogue (SCH-CM-5.1-05..12) and leaves the protocol unspecified at this revision. Two
consequences:

- AttestBook's product API is not a TS11 catalogue API and is not an ETSI catalogue API;
  no endpoint change is made or claimed here.
- TS11 §5 remains the only concrete catalogue interface available to this project. If a
  later ETSI revision specifies an API, the version-aware adapter and the stored
  `specVersion` are the intended migration points.

### 4.5 What was not migrated

No ETSI `SchemaMeta` profile was added, no stored rulebook was rewritten, no database
migration was applied, and no ETSI catalogue endpoint was exposed. The canonical model can
carry the ETSI members (`rulebookIntegrity`, per-reference `integrity`, `meta`,
`iat`), but no `etsi@0.0.7` wire profile exists. This is an assessment, not an
implementation of migration support. A follow-up implementation would need its own issue,
tests and a compatibility decision for the lossy cases above.

## 5. External interoperability checks

All checks below execute against frozen fixtures; the tests make no network request. The
capture URLs, response headers and SHA-256 digests are in
[`src/standards/test/interop-fixtures/README.md`](../src/standards/test/interop-fixtures/README.md).

### 5.1 SIROS Credential Type Registry

| Check | Result |
| --- | --- |
| Captured entries | 32 |
| Parsed with the TS11 v1.0.1 profile | 27 |
| Rejected | 5 — all `invalid_member_value` at `version`, "expected a SemVer version" |
| Rejected ids | `2e5a14fb-…@1.5`, `b0880349-…@1.0`, `96c78c4f-…@1.5`, `10928af8-…@1.8`, `1f281d3b-…@1.0` |
| Valid under draft Annex E | 0 of 32 (all are TS11-shaped: no `rulebookIntegrity`, no per-schema `integrity`/`meta`, top-level `supportedFormats`) |
| Signature | The captured response is plain JSON; no JWS was observed. Authenticity is **NOT_TESTED**. |

Interpretation: SIROS is a useful TS11-subset interoperability fixture, but its
self-described "TS11-compliant" entries include two-part version labels that TS11 v1.0.1's
SemVer rule rejects. The adapter's rejection is correct; the source is not fully TS11
v1.0.1-valid. No entry is ready for an ETSI v0.0.7 document without conversion.

### 5.2 FIDES Community Credential Catalog

| Check | Result |
| --- | --- |
| Captured response | compact JWS, 121 entries |
| Signature | ES256, `kid fides-cat-2026-v1`, verified with the captured JWKS (RFC 7515 compact serialization) |
| Self-reported `compatible` | 10 entries; **0 parsed** as TS11 v1.0.1 |
| Self-reported `partial` | 111 entries; 20 parsed as TS11 v1.0.1 |
| Total parsed | 20 of 121 |
| Total rejected | 101 — required members or values missing |
| Valid under draft Annex E | 0 of 121 |

The FIDES source is honest that most entries are partial, but its `compatible` label is
**not** a TS11 v1.0.1 structural verdict: every entry carrying that label is missing
required members such as `attestationLoS` and non-empty `schemaURIs`, and the adapter
rejects all ten. An importer must validate structure itself and must not promote a source's
self-reported level into a conformance result.

### 5.3 OWF 0.5.4 implementation

OWF 0.5.4 remains the implemented library boundary and is already exercised by
`src/standards/owf-codec.test.ts`, `src/standards/jose.test.ts`,
`src/standards/references.test.ts` and `src/standards/ts11-codec.test.ts`. This assessment
adds the Annex E-shaped JWS round trip in
`src/standards/interoperability.test.ts`. No OWF upgrade, no OWF issue fix and no live
EUDIPLO/Sphereon integration was attempted.

### 5.4 Sources deliberately not checked live

- **EUDI Wallet Attestation Rulebooks Catalog:** Markdown only, no machine-readable
  `SchemaMeta`; nothing to parse. `NOT_TESTED`.
- **EUDIPLO and Sphereon:** implementations reached through OID4VCI issuer-metadata
  discovery, not bulk catalog documents. No live instance was exercised. `NOT_TESTED`.
- **Credimi:** the integration adapter is exercised by its own tests; Credimi runtime
  orchestration is out of scope. `NOT_TESTED` for interoperability.

## 6. Supported, unverified and unsupported summary

**Supported with executed evidence:** an Annex E-valid `SchemaMeta` without trust
authorities parses through the OWF profile; the same shape signs and verifies as a JWT;
SIROS 27/32 entries parse as TS11 v1.0.1; FIDES 20/121 entries parse as TS11 v1.0.1; the
FIDES signature verifies against its captured JWKS.

**Partial:** JWT envelope (compatible subset, no ETSI profile); `id`, `iat`, `meta`
strictness, `additionalProperties`, version rules, and the reverse OWF extensions.

**Unsupported:** an Annex E `etsi_tl` trust authority without an OWF `verificationMethod`;
non-SemVer `version` labels; any conversion that would silently drop `aki`,
`openid_federation`, `isLOTE`, the three TS11-only formats, `issuanceProfile` or the
extended `meta`.

**Unverified / NOT_TESTED:** ETSI conformance, the final published EN, the v0.0.6 → v0.0.7
delta, trust-anchor resolution, catalogue signer policy, live SIROS/FIDES authenticity
(SIROS is unsigned; FIDES is signed by the captured key only), EUDIPLO/Sphereon/Credimi
interoperability, and the ETSI catalogue API (which the draft does not specify).

## 7. Executed verification

The evidence for this document is the repository test suite, not prose:

- `bun test src/standards/interoperability.test.ts` — 10 tests: Annex E schema
  validation, the non-URI id rejection, the ETSI-shaped JWT round trip, the trust-authority
  and SemVer gaps, reverse OWF gaps, SIROS outcomes and the FIDES signature/outcome
  classification.
- `bun run typecheck` and `bun run lint` — the new test and fixtures compile and lint under
  the repository's strict TypeScript and ESLint configuration.
- `bun run docs:check` — this document and its local links, test citations and traceability
  references resolve.
- Existing suites cited above for the OWF adapter and registry evidence.

The draft Annex E schema is reproduced in
`src/standards/test/interop-fixtures/etsi-482-3-v0.0.7-annex-e.schema.json` and compiled by
Ajv 8.20.0 in the test. `format: uri` is annotation-only in that test configuration; URI
shape is therefore not claimed as executed, except where the adapter itself rejects a
non-URL `id`.

## 8. Limitations and non-claims

- **No conformance claim.** Passing Annex E schema validation is not ETSI conformance, and
  parsing SIROS or FIDES entries is not interoperability conformance.
- **Draft status.** v0.0.7 is a working draft, not a published EN. v0.0.6 was never read;
  the two revisions may differ. Re-verify when v0.0.7 is published or superseded.
- **Fixture snapshots age.** The catalogs rebuild, keys rotate and entries change. The
  captures are evidence for 2026-11-09 only. No live monitoring is implemented.
- **Signature scope.** The FIDES check proves that the captured bytes verify under the
  captured JWKS key. It does not establish that FIDES is an authoritative or trusted
  catalogue, nor that its key remains valid.
- **Source self-reports are not verdicts.** SIROS' "TS11-compliant" and FIDES'
  `conformance.level` are source claims; the executed parser results are the AttestBook
  evidence and they disagree with both in places.
- **No ETSI implementation.** No ETSI profile, catalogue API or trust validation was built.
  The assessment does not authorize a future implementation; that needs its own issue and
  compatibility decision.
- **Delegated dimensions stay delegated.** Cryptographic validation, issuer trust,
  protocol conformance and end-to-end interoperability remain `NOT_TESTED` or
  `INCONCLUSIVE` in the validation engine, as specified by FR-010/FR-012 and AC-16.

## 9. Follow-up work (not delivered here)

The assessment found work that belongs in separate tickets, not this one:

1. Decide whether to add an `etsi@0.0.7` wire profile and how to represent a minimal
   `etsi_tl` authority without OWF's `verificationMethod` (for example a distinct adapter
   boundary rather than changing OWF).
2. Decide the `version` policy: retain SemVer as an AttestBook constraint, or accept the
   draft's arbitrary string for an ETSI profile.
3. Decide the lossy-conversion policy for `aki`, `openid_federation`, `isLOTE`, the three
   TS11-only formats, `issuanceProfile` and extended `meta`.
4. Re-run the comparison against the published EN and against any later ETSI catalogue API.
5. Add live catalog adapters (SIROS/FIDES) only with their own security and provenance
   review; this assessment deliberately stops at frozen fixtures.
