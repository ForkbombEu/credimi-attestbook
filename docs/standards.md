# Standards baseline and OWF dependency audit

**Status:** Phase 0 research baseline. The findings below are consolidated into adopted
decisions and a dependency-ordered Phase 1 plan in
[`docs/implementation-plan.md`](implementation-plan.md). This document does not authorize a
conformance claim, production deployment or a standards claim beyond the evidence cited.

**Phase 0 document set:** [`docs/architecture.md`](architecture.md) ·
[`docs/requirements.md`](requirements.md) ·
[`docs/capture-integration.md`](capture-integration.md) ·
[`docs/implementation-plan.md`](implementation-plan.md) ·
[`docs/traceability.md`](traceability.md) ·
[`docs/specification.md`](specification.md) (authoritative).

**Audit date:** 2026-11-02

**Scope:** This revision records the audit of the mandatory
`@owf/eudi-attestation-schema` dependency required by
[the product specification](specification.md) section 2.1. The EC TS11 v1.0.1
field comparison and the OWF package behaviour probes are original work for
[issue #1](https://github.com/ForkbombEu/credimi-attestbook/issues/1). The
clause-level TS11/ETSI/ARF baseline and the ETSI EN 319 482-3 comparison are
authored by [issue #2](https://github.com/ForkbombEu/credimi-attestbook/issues/2)
and are integrated below as Part II; the requirements-to-clause and
requirements-to-test traceability matrix is in
[`docs/traceability.md`](traceability.md). Part II extends this baseline rather
than replacing it.

**Key finding:** OWF 0.5.4 is a useful primitives library, but it is not a
TS11 v1.0.1 codec. Pin it exactly; put a version-aware translation boundary and
a strict JOSE wrapper around it; do not claim TS11 conformance from its schema
validation alone. The Phase 1 adapter built on these findings is documented in
[`standards-adapter.md`](standards-adapter.md).

### Coordination with the other Phase 0 standards work

Issue #2 authors the TS11/ETSI/ARF source register, baseline and the
requirements-to-clause / requirements-to-test traceability matrix. The source
register and baseline are integrated below as Part II; the traceability matrix
lives in [`docs/traceability.md`](traceability.md). Section 7 remains the single
OWF capability matrix, and Part II links to section 3's API/export inventory
rather than repeating it. This audit was written against `main` before the #2
section landed; the two parts are now combined in this file.

## 1. Scope, method and non-claims

The audit answers four questions:

1. What is actually published in `@owf/eudi-attestation-schema` 0.5.4, as
   opposed to what its README implies?
2. Which operations can AttestBook reuse without duplicating them?
3. Where does the package's `SchemaMeta` model diverge from the TS11 v1.0.1
   data model that the specification uses as its baseline?
4. Which runtimes and package managers execute the package, and which
   behaviours must AttestBook wrap rather than trust?

Method:

- inspected the published npm tarball, its TypeScript declarations and its
  source at the matching upstream commit;
- executed creation, validation, JWS signing/verification, SRI resolution,
  DCQL and issuer-metadata probes against the exact installed version;
- compared every `SchemaMeta` member and constraint with the TS11 v1.0.1 text
  and its normative JSON Schema;
- ran the probes on Node.js 20, 22 and 24 and on Bun 1.3.1 (Linux x64),
  plus Node.js 18 with its WebCrypto flag;
- ran a strict TypeScript compile of the public surface.

Explicit non-claims:

- **No conformance claim.** Passing OWF's schema validation does not establish
  TS11 conformance, cryptographic validity, trust or interoperability.
- **ETSI EN 319 482-3 draft v0.0.6 is NOT_TESTED here.** The ETSI portal
  returned HTTP 403 on the audit date and the public ETSI draft directory did
  not expose the 482-3 draft. That comparison is assigned to [issue #2](https://github.com/ForkbombEu/credimi-attestbook/issues/2).
- **No credential validation was tested** because the package exposes no
  credential parser or credential validator.
- **No browser, Deno, ARM or non-Linux runtime test was performed.**

## 2. Sources, versions and provenance

| Item | Version / date | Evidence |
| --- | --- | --- |
| EC TS11 | v1.0.1, 2026-01-30 | Version table and normative data model below |
| TS11 specification | `main` as retrieved 2026-11-02 | [specification](https://github.com/eu-digital-identity-wallet/eudi-doc-standards-and-technical-specifications/blob/main/docs/technical-specifications/ts11-interfaces-and-formats-for-catalogue-of-attributes-and-catalogue-of-schemes.md) |
| TS11 normative JSON Schema | `ts11-json-cat-attestations-data-model.json` | [schema](https://github.com/eu-digital-identity-wallet/eudi-doc-standards-and-technical-specifications/blob/main/docs/technical-specifications/api/ts11-json-cat-attestations-data-model.json) |
| TS11 OpenAPI | `ts11-cat-of-attestations-jwt-openapi31.yml` | [OpenAPI](https://github.com/eu-digital-identity-wallet/eudi-doc-standards-and-technical-specifications/blob/main/docs/technical-specifications/api/ts11-cat-of-attestations-jwt-openapi31.yml) |
| OWF package | `@owf/eudi-attestation-schema` **0.5.4**, published 2026-10-30T16:41:48Z | npm dist-tags: `latest` = 0.5.4; tarball integrity `sha512-WHF/aZKvCoiINIEGZbjJ49UI27LuTMDr/qdSrqET01hNS3W7JqYSZ/8Dv441onrMaCDFHCo5tT+k+JOYOL470w==` |
| OWF source | commit `039145c`, release PR #393, 2026-10-30 | `packages/eudi-attestation-schema/package.json` reports 0.5.4 |
| OWF repository | `main` at `23f227b`, 2026-11-02 | package source unchanged from `039145c` to `23f227b` for this package |
| OWF prerelease | `0.6.0-alpha-20261102161059`, 2026-11-02 | Not evaluated; depends on `@owf/*` `0.7.0-alpha` |
| OWF dependencies | `@owf/crypto` 0.6.2, `@owf/identity-common` 0.6.2, `@sd-jwt/sd-jwt-vc` 0.24.1, `zod` 4.6.7 | `npm ls` against the installed 0.5.4 |

Provenance notes:

- The npm tarball does **not** publish a `gitHead` field. The source association
  with `039145c` is established by the package version in that commit, not by a
  cryptographic source-to-tarball link.
- The registry reports an npm provenance attestation and registry signatures
  for the tarball. `npm audit signatures` verified registry signatures for 19 packages and
  provenance attestations for 12 of them on the audit date.
- The tarball contains only `LICENSE`, `README.md`, `dist/index.d.mts`,
  `dist/index.mjs`, `dist/index.mjs.map` and `package.json` (42.4 kB package,
  175.7 kB unpacked, 6 files).
- The package is marked `"experimental": true`. Its README warns that breaking
  changes are possible until the underlying specification is stable.

## 3. Verified public API inventory

`Object.keys()` on the installed 0.5.4 module returns **46 runtime exports**.
`index.d.mts` additionally exports compile-time types.

### 3.1 Runtime exports

| Category | Exports |
| --- | --- |
| Builders / factories (6) | `SchemaMetaBuilder`, `SchemaURIBuilder`, `TrustAuthorityBuilder`, `schemaMeta`, `schemaURI`, `trustAuthority` |
| Structural validation (3) | `validateSchemaMeta`, `assertValidSchemaMeta`, `SchemaMetaException` |
| JWS signing / verification (2) | `signSchemaMeta`, `verifySchemaMeta` |
| Resolution and DCQL (5) | `resolveSchemaReferences`, `buildDcqlFromSchemaMeta`, `toDcqlCredentialInput`, `toDcqlTrustedAuthorities`, `verifyResolveAndBuildDcql` |
| Issuer metadata (2) | `buildCredentialConfigurationTemplate`, `validateIssuerMetadataAgainstProfile` |
| SD-JWT VC Type Metadata (1) | `mergeTypeMetadata` |
| Zod schemas and enum values (27) | `AttestationFormatSchema`, `AttestationFormatValues`, `AttestationLoSSchema`, `AttestationLoSValues`, `BindingTypeSchema`, `BindingTypeValues`, `ClaimSelectiveDisclosureSchema`, `ClaimSelectiveDisclosureValues`, `ClaimsPathSchema`, `FrameworkTypeSchema`, `FrameworkTypeValues`, `IssuanceProfileSchema`, `MsoMdocMetaSchema`, `Oid4vciClaimDisplaySchema`, `Oid4vciClaimSchema`, `Oid4vciCredentialMetadataSchema`, `Oid4vciDisplaySchema`, `ProofTypeSchema`, `SchemaMetaSchema`, `SchemaURISchema`, `SdJwtMetaSchema`, `SdJwtVcTypeMetadataSchema`, `Sha256SriSchema`, `StatusMechanismSchema`, `TrustAuthoritySchema`, `TypeMetadataClaimSchema`, `TypeMetadataSchema` |

### 3.2 Type exports

The declarations export: `AttestationFormat`, `AttestationLoS`, `BindingType`,
`BuildCredentialConfigurationTemplateOptions`,
`BuildDcqlFromSchemaMetaOptions`, `BuildDcqlFromSchemaMetaResult`,
`ClaimSelectiveDisclosure`, `CredentialConfigurationTemplate`, `DcqlClaim`,
`DcqlClaimsPath`, `DcqlClaimsPathComponent`, `DcqlTrustedAuthority`,
`FrameworkType`, `IssuanceProfile`, `MsoMdocMeta`, `Oid4vciClaim`,
`Oid4vciClaimDisplay`, `Oid4vciCredentialMetadata`, `Oid4vciDisplay`,
`ProofType`, `ResolveSchemaReferencesOptions`, `ResolvedSchemaReference`,
`ResolverContent`, `SchemaMeta`, `SchemaURI`, `SchemaURIMeta`, `SdJwtMeta`,
`SdJwtVcTypeMetadata`, `SignOptions`, `SignedSchemaMeta`, `StatusMechanism`,
`TrustAuthority`, `TypeMetadata`, `TypeMetadataClaim`,
`ValidateIssuerMetadataOptions`, `ValidationError`, `ValidationResult`,
`VerifiedSchemaMeta`, `VerifyOptions`.

There is **no** exported `validateCredential`, credential parser, trust-chain
verifier or catalogue API client.

## 4. Data model implemented by 0.5.4

The package implements a `SchemaMeta` profile with its own Zod schemas. The
members below are verified from `src/schemas.ts` at commit `039145c` and from
the published declarations.

### 4.1 `SchemaMeta`

| Member | Required | OWF 0.5.4 constraint |
| --- | --- | --- |
| `id` | yes | URL (`z.string().url()`) |
| `iat` | no | integer, non-negative (JWT NumericDate semantics) |
| `version` | yes | SemVer-shaped string |
| `rulebookURI` | yes | URL |
| `rulebookIntegrity` | yes | `sha256-<base64>` SRI only |
| `trustedAuthorities` | no | array of `TrustAuthority` |
| `attestationLoS` | yes | `iso_18045_high`, `iso_18045_moderate`, `iso_18045_enhanced-basic`, `iso_18045_basic` |
| `bindingType` | yes | `claim`, `key`, `biometric`, `none` |
| `schemaURIs` | yes | at least one; `formatIdentifier` must be unique |
| `issuanceProfile` | no | OWF-specific policy object; not in TS11 v1.0.1 |

Cross-field rules:

- `schemaURIs[*].formatIdentifier` values must be unique.
- When `bindingType` is `none`, `issuanceProfile.cryptographicBindingMethodsSupported`
  and `issuanceProfile.proofTypesSupported` must be absent.

### 4.2 `SchemaURI`

| Member | Required | OWF 0.5.4 constraint |
| --- | --- | --- |
| `formatIdentifier` | yes | `dc+sd-jwt` or `mso_mdoc` only |
| `uri` | yes | URL |
| `integrity` | yes | `sha256-<base64>` SRI only |
| `meta` | yes | strict format-specific object |
| `meta` for `dc+sd-jwt` | yes | `{ vct, credential_metadata?, sd_jwt_vc_metadata? }`; `sd_jwt_vc_metadata.vct` must match `vct` |
| `meta` for `mso_mdoc` | yes | `{ doctype_value, credential_metadata? }` |

### 4.3 `TrustAuthority`

- `etsi_tl`: `{ frameworkType: 'etsi_tl', value: <trust-list URI>, verificationMethod: { type: 'X509Certificate', x509Certificate: <base64 DER> } }`
- `x509`: `{ frameworkType: 'x509', value: <base64 DER root CA certificate> }`

Both variants are strict. The `x509` variant is an OWF extension relative to
TS11 v1.0.1.

### 4.4 `IssuanceProfile`

Optional OWF-specific object with allowed sets and bounds:
`credentialSigningAlgValuesSupported`, `cryptographicBindingMethodsSupported`,
`proofTypesSupported`, `keyAttestationRequired`, `statusMechanism`,
`maxValidityPeriod`, `batchIssuanceAllowed`. Its members are strict.

### 4.5 Strictness

- `SchemaURI`, `TrustAuthority`, `IssuanceProfile` and nested metadata objects
  are strict: unknown keys are rejected.
- **`SchemaMeta` itself is not strict**: unknown top-level members are accepted
  by `validateSchemaMeta` and then stripped by `SchemaMetaSchema.parse`.
  `assertValidSchemaMeta` leaves them in the original object. This asymmetry is
  observable and is a data-preservation hazard for a codec.

## 5. Verified behaviour

The probe is committed at [`research/owf-audit/probe.mjs`](../research/owf-audit/probe.mjs).
All 35 assertions passed for 0.5.4 on the tested runtimes.

### 5.1 Creation and structural validation

- The fluent builders construct a document that `validateSchemaMeta` accepts.
- Missing `rulebookIntegrity`, missing `schemaURIs[*].integrity` or
  `schemaURIs[*].meta`, non-SemVer versions, duplicate format identifiers,
  invalid `id` URLs, invalid `iat`, and non-sha256 SRI values are rejected.
- Errors have the shape `{ path, message }`; there are no stable issue codes,
  severity, or requirement references in 0.5.4.
- Unknown top-level members are accepted (see 4.5). This is not a forward
  compatibility guarantee: `SchemaMetaSchema.parse` drops them.
- A TS11 v1.0.1-shaped document is rejected; see section 6.

### 5.2 Serialization

- `SchemaMeta` values are ordinary JavaScript objects; `JSON.stringify` and
  `JSON.parse` are the serialization mechanism. There is no custom codec,
  canonicalization, content digest or round-trip preservation API.
- The only signed serialization is compact JWS.

### 5.3 JWS signing

`signSchemaMeta`:

- writes header `{ alg, typ: 'attestation-schema+jwt', kid, x5c }`;
- injects `iat = Math.floor(Date.now() / 1000)` into the JWS payload;
- returns `SignedSchemaMeta` whose `payload` is the **input** object, without
  the injected `iat`;
- does not validate the `SchemaMeta` argument before signing;
- accepts any `algorithm` string independently of the supplied `Signer`
  (an ES256 signer can emit a header claiming `RS256`);
- accepts an empty `certificates` array (emits `x5c: []`);
- has no clock or `iat` injection option.

### 5.4 JWS verification

`verifySchemaMeta` decodes the compact JWS, calls the caller-supplied
`Verifier` on the signing input, then validates the payload with
`SchemaMetaSchema`. It does **not**:

- validate the JOSE header (`typ`, `alg`, `kid`, `x5c` presence or form);
- bind the header `alg` to the verifier or to the key type;
- parse or verify the `x5c` chain, its trust anchor, or its relation to the
  signing key;
- verify `trustedAuthorities`;
- require `iat`.

Observed with the same valid ES256 signature:

| JOSE header / payload | Result |
| --- | --- |
| `typ: "JWT"` instead of `attestation-schema+jwt` | accepted |
| no `x5c` member | accepted |
| `alg: "none"` | accepted; returned header still says `none` |
| `alg: "RS256"` over an ES256 signature | accepted; returned header still says `RS256` |
| payload with no `iat` | accepted; returned `iat` is the verifier's current time |
| payload with `iat: 0` | accepted; returned `iat` is the verifier's current time |
| `x5c` certificate unrelated to the signing key | accepted |

This is **not** a signature bypass: the caller-supplied verifier still verifies
the signature. It does mean the returned JOSE header is not authenticated
metadata, and the returned `iat` is not proof of issuance time. AttestBook must
apply its own JOSE-header policy and must not use these values for key, algorithm
or trust decisions.

`signSchemaMeta` followed by `verifySchemaMeta` on an unvalidated input succeeds
in signing but is rejected by verification with
`Invalid SchemaMeta payload`. Signing and validation are independent calls.

### 5.5 Reference resolution and integrity

`resolveSchemaReferences`:

- accepts a caller-supplied `resolve(uri)` callback; the package performs no
  network access itself;
- verifies SRI over the transferred bytes by default (`verifyIntegrity: true`);
- supports `sha256` only;
- rejects already-parsed content when integrity verification is on;
- accepts parsed content when `verifyIntegrity: false`;
- for `dc+sd-jwt`, treats the referenced document as SD-JWT VC Type Metadata if
  it has a string `vct`, validates it against the `@sd-jwt/sd-jwt-vc` Type
  Metadata schema, follows the `extends` chain with integrity checks, cycle
  detection and a depth bound, and cross-checks `vct` against
  `schemaURIs[*].meta.vct`;
- otherwise parses the document as a plain JSON Schema and records it as
  `parsedSchema`; it does **not** validate any credential instance against that
  schema.

`verifyResolveAndBuildDcql` composes verification, resolution and DCQL
generation in one call and works as documented.

### 5.6 DCQL and trusted authorities

`buildDcqlFromSchemaMeta` emits DCQL credentials with `id`, `format`, `meta`
(`vct_values` or `doctype_value`) and claims. Claims come from Type Metadata
paths when present, otherwise from a syntactic walk of the JSON Schema.

`toDcqlTrustedAuthorities` maps only `etsi_tl` authorities. The OWF `x509`
direct-anchor variant is dropped, and TS11's `aki` and `openid_federation`
framework types are not representable in the model at all. The DCQL result
therefore cannot be assumed to carry the complete trust information of a
`SchemaMeta` document.

### 5.7 OID4VCI issuer metadata helpers

`buildCredentialConfigurationTemplate` emits a type- and policy-determined
`credential_configurations_supported` entry plus a list of deployment fields the
issuer must supply. `validateIssuerMetadataAgainstProfile` checks format,
`vct`/`doctype`, binding-related proof requirements, allowed signing algorithms
and proof types, key-attestation presence and batch issuance.

Documented limitations that remain in the code:

- `statusMechanism` and `maxValidityPeriod` have no issuer-metadata expression
  and are not validated;
- deployment fields (`credential_issuer`, endpoints, scope, display) are not
  emitted or checked;
- the helper is a mapping/validation primitive, not issuer discovery and not a
  substitute for an Attestation Rulebook.

### 5.8 Operations the package does not provide

- Credential parsing, format recognition or credential validation.
- Credential cryptography, status/revocation checks, issuer trust or x5c chain
  validation.
- OpenID4VCI/OpenID4VP protocol client or server.
- A JWS envelope for the TS11 catalogue list response (`{ iss, iat, data }`) or
  any catalogue API client/server.
- Rulebook registry, provider management, publication lifecycle, immutable
  versions, content digests or provenance.
- Catalog discovery, import, synchronization or conflict detection.
- Capture artifact model or capture adapters.
- Stable machine-readable validation codes, severity or dimension reporting.
- Form-dependent mdoc/mDL parsing or CBOR/COSE credential handling.
- Support for the TS11 formats `jwt_vc_json`, `jwt_vc_json-ld` and `ldp_vc`.

## 6. Compatibility with EC TS11 v1.0.1

`docs/specification.md` selects EC TS11 v1.0.1 as the initial baseline. The
package README and source comments call the package a TS11 implementation, but
the package's `SchemaMeta` field set is **not** the TS11 v1.0.1 field set.

### 6.1 Field-by-field comparison

| Concern | TS11 v1.0.1 | OWF 0.5.4 | Consequence |
| --- | --- | --- | --- |
| `id` | UUID in the normative schema; OpenAPI marks it `readOnly` and it is not in `required` | required URL | A TS11 document with a UUID id fails validation; OWF documents may fail a TS11 validator |
| Rulebook integrity | `rulebookURI` MAY carry `#integrity=<SRI>` | separate required `rulebookIntegrity` member | Different wire shape; TS11 document fails OWF validation |
| Trust framework | `aki`, `etsi_tl`, `openid_federation`; optional `isLOTE` | `etsi_tl` (with `verificationMethod`) or `x509` direct anchor | TS11 `aki`/`openid_federation`/`isLOTE` documents are rejected; OWF `verificationMethod` is an extra member |
| `supportedFormats` | required, 1..* of `dc+sd-jwt`, `mso_mdoc`, `jwt_vc_json`, `jwt_vc_json-ld`, `ldp_vc` | removed from the model (OWF PR #86) | No equivalent; format is inferred from `schemaURIs` |
| `schemaURIs` item | `{ formatIdentifier, uri }` only; optional `#integrity` suffix | `{ formatIdentifier, uri, integrity, meta }` | TS11 document fails OWF validation; OWF document has extra members |
| Format set | five formats | two formats | Three TS11 formats unsupported |
| Additional members | `additionalProperties: false` at all three levels | strict nested objects, permissive top level | Unknown members are accepted then stripped; not lossless |
| `iat` | not a `SchemaMeta` member; catalogue envelope carries `iat` | optional `SchemaMeta` member; signer injects it | Wire model and time semantics differ |
| JWS API | catalogue responses are JWS-signed; list payload has `{ iss, iat, data }` | compact JWS over one bare `SchemaMeta` | No list envelope / `iss`; cannot implement the API response format directly |

A document shaped like TS11 v1.0.1 was validated with 0.5.4. It was rejected
with errors including:

```text
id: expected a URL
rulebookIntegrity: expected string, received undefined
trustedAuthorities.0.frameworkType: Invalid input
trustedAuthorities.1.verificationMethod: expected object, received undefined
trustedAuthorities.1: unrecognized key(s) "isLOTE" in object
schemaURIs.0.integrity: expected string, received undefined
schemaURIs.0.meta: expected object, received undefined
```

### 6.2 Why the divergence exists

The divergence is deliberate in OWF history, not an accidental schema typo:

- PR #86 removed `supportedFormats` as "redundant" (May 2026);
- PR #152 "Align eudi-attestation-schema with catalog policy requirements"
  made `id` URL-formatted, added `rulebookIntegrity` and per-schema
  `integrity`, required the `meta` object, restricted formats to
  `dc+sd-jwt`/`mso_mdoc`, and restricted trust to `etsi_tl` (July 2026);
- PR #268 later added the `x509` direct trust anchor (September 2026).

Those changes may track a later EC/ETSI SchemaMeta policy revision. **This audit
cannot confirm that**: the package does not name the revision, and the ETSI EN
319 482-3 draft was not publicly reachable. The TS11 v1.0.1 finding is
independent of that question: the published package cannot be used as a
drop-in TS11 v1.0.1 codec.

**Conclusion:** OWF 0.5.4 is usable as an implementation of its own
`SchemaMeta` profile and as a set of primitives (builders, Zod validation, JWS,
SRI, DCQL, issuer metadata). It is **not** a drop-in parser, validator or
verifier for the TS11 v1.0.1 `SchemaMeta` wire model, and its signer targets the
OWF profile. AttestBook needs a version-aware translation boundary.

## 7. Capability matrix

`Direct` means AttestBook can reuse a public OWF API for that requirement
without adding standards semantics. `Partial` means a reusable primitive exists
but the requirement itself remains AttestBook work. `None` means the package
provides no relevant capability.

| Requirement | OWF 0.5.4 surface | Status | Remaining AttestBook gap |
| --- | --- | --- | --- |
| FR-001 Rulebook management | `SchemaMeta` model, builder, validator | Partial | Multiple rulebooks/providers, status, provenance, source URL, content digest, attestation-type catalogue |
| FR-002 Versioning | SemVer-shaped `version` check | None | Draft/published/history, comparison, immutability, version-specific validation, digest verification |
| FR-003 Provider management | none | None | Provider identity, ownership, authorization, publication authority |
| FR-004 External rulebook import | `resolveSchemaReferences` (caller supplies fetch), SRI verification | Partial | URL/file import, preview, compatibility report, conflict detection, provenance, catalog adapters |
| FR-005 Catalog synchronization | none | None | Conditional fetch, idempotent sync, change detection, conflict reporting |
| FR-006 Issuer metadata discovery | `buildCredentialConfigurationTemplate`, `validateIssuerMetadataAgainstProfile` | Partial | Discovery, fetch, configuration extraction, association, ambiguity reporting, manual mapping |
| FR-007 Rulebook editor | Builders, validator, JSON-preview primitives | Partial | Editor, diagnostics UX, version diff, draft management |
| FR-008 Publication | `signSchemaMeta`, `verifySchemaMeta` | Partial | Publication workflow, immutable artifacts, key management, audit log, catalogue API envelope |
| FR-009 Validation API | `validateSchemaMeta` validates metadata only | None | Credential validation request/response API and dimension-aware results |
| FR-010 Validation dimensions | metadata structure + JWS signature | None | Credential parsing, format recognition, credential cryptography, trust, protocol, interoperability dimensions |
| FR-011 Credential format support | none | None | SD-JWT VC and mdoc parsers/validators |
| FR-012 Validation results | `{ valid, errors: [{ path, message }] }` | None | PASS/FAIL/NOT_TESTED/NOT_APPLICABLE/INCONCLUSIVE, severity, stable codes, attribute paths, evidence |
| FR-013 Issuer test fixtures | Credential configuration template, claims extraction | Partial | Attribute definitions, payload generation, overrides, negative cases, credential validation |
| FR-014 Verifier test fixtures | DCQL builder, trusted-authority mapping | Partial | Constraint inspection, validation policies, negative cases, OpenID4VP request generation |
| FR-015 Capture artifact model | none | None | Envelope, redaction, integrity, external artifact references |
| FR-016 capture-issuer integration | none | None | Adapter, normalization, correlation |
| FR-017 capture-verifier integration | none | None | Adapter, selective-disclosure handling, correlation |
| FR-018 Capture integration contracts | none | None | Pull/push contracts, mock adapter |
| FR-019 Correlation and traceability | none | None | Stable identifiers across rulebook/capture/validation/test execution |
| FR-020 Credimi test orchestration | none | None | API-driven list/select/pin/validate/report integration |
| FR-021 Headless Wallet testing | none | None | External wallet workflow and evidence correlation |
| FR-022 Continuous conformance | deterministic metadata validation; signing uses wall clock | Partial | Machine-readable evidence, stable classification, version references, reproducible signing |
| UI-001..UI-006 | none | None | All web UI |
| Public REST/OpenAPI | none | None | API contracts, authn/authz, idempotency, OpenAPI |
| Security controls (spec §15) | SRI verification, strict nested schemas | Partial | SSRF-safe fetch, timeouts, size/JSON limits, reference controls, secret redaction, audit logging |

## 8. Runtime, package-manager and tooling compatibility

Tested on Linux x64 with the exact dependency versions in section 2.

| Runtime | ESM import | CommonJS `require()` | Probe result |
| --- | --- | --- | --- |
| Node.js 20.20.2 | yes | yes (`require(esm)`) | all checks passed |
| Node.js 22.23.4 | yes | yes | all checks passed |
| Node.js 24.22.2 | yes | yes | all checks passed |
| Node.js 18.20.8 | yes | no (`ERR_REQUIRE_ESM`) | all checks passed with `--experimental-global-webcrypto`; default Node 18 has no global WebCrypto and ES256 key generation fails |
| Bun 1.3.1 | yes | not separately tested | all checks passed, including install with `bun add` |

Findings:

- The package is **ESM-only**. Since 0.5.0 OWF removed the CommonJS build. The
  package declares no `engines` field.
- Node.js 20+ is the practical floor: it provides global WebCrypto and
  `require(esm)`. Node 18 needs `--experimental-global-webcrypto` for
  `@owf/crypto` key generation and cannot `require()` the ESM package. AttestBook
  should be ESM and should not depend on CommonJS interop or on a Node 18
  runtime.
- Bun 1.3.1 installed the package and ran the full probe successfully,
  including ES256 key generation, signing, verification, SRI and DCQL. Bun is
  viable for the Phase 1 spike subject to the rest of the stack.
- The dependency tree includes an optional native `cbor-extract` binding
  transitively through `@sd-jwt/sd-jwt-vc`/`@owf/token-status-list`. The
  optional Linux x64 prebuilt package was installed and the probe imported and
  ran successfully; other architectures were not tested. This does not affect
  the package's `SchemaMeta` code path observed here, but it is a portability
  item for Docker/CI.
- Strict application TypeScript compiles against the public declarations. With
  `exactOptionalPropertyTypes: true`, the declarations of
  `@sd-jwt/sd-jwt-vc` 0.24.1 produce an error, so the audit probe uses
  `skipLibCheck: true` while still checking the application code strictly.
  AttestBook should either use `skipLibCheck` or pin a compatible declaration
  set; it should not silently relax application strictness.
- Browser, Deno, ARM and non-Linux execution are NOT_TESTED.

**Tested version recommendation:** pin `@owf/eudi-attestation-schema` exactly to
**0.5.4** for the Phase 1 spike, with a lockfile and an integration test that
executes the package. Do not adopt `0.6.0-alpha-*` without a new audit: it is a
prerelease built on `@owf/*` 0.7.0-alpha, and its shape may change. OWF PR #404
shows that the shared validation-issue model is still rolling out; its own notes
state that `@owf/eudi-attestation-schema` continues to return `{ valid, errors }`
and can follow later.

## 9. Adapter boundary and provisional decisions

### 9.1 Boundary

The OWF package must remain mandatory, but it cannot be the only model at the
AttestBook boundary. The architecture should define a narrow, version-aware
standards adapter with these responsibilities:

| Boundary | Reuse from OWF | AttestBook owns |
| --- | --- | --- |
| SchemaMeta codec | OWF Zod schemas and builders for the OWF profile | Detect the document profile, translate TS11 v1.0.1 ↔ canonical internal model, preserve unknown/normative members, report unmappable fields |
| JOSE | compact-JWS parsing, signature primitive, certificate parsing | `typ`/`alg`/`kid`/`x5c` policy, algorithm allowlist, key resolution, x5c chain and trust verification, `iat` semantics, no synthetic timestamps |
| Reference resolution | SRI verification, Type Metadata merge, `extends` bounds | SSRF-safe fetch, timeouts, size/JSON limits, caching, provenance, redirect policy |
| DCQL / issuer metadata | claim extraction, DCQL credential mapping, template and profile checks | OID4VCI version pin, policy decisions, ambiguity handling, trust completeness |
| Credential validation | none | SD-JWT VC/mdoc parsing, credential cryptography, status, trust, protocol and interoperability dimensions |
| Registry / lifecycle | none | Persistence, versions, immutability, publication, authorization, audit |
| API / UI / capture | none | OpenAPI contracts, UI, capture contracts and adapters |

The adapter must not be a second implementation of OWF-supported `SchemaMeta`
validation. It translates between the two wire profiles and calls OWF for the
OWF profile; TS11-specific translation is the documented narrow extension
allowed by `docs/specification.md` section 2.1.

### 9.2 Decisions adopted in the consolidated plan

These Phase 0 findings are consolidated in
[`docs/implementation-plan.md`](implementation-plan.md) §3: pinning is D-1, the codec
boundary is D-2, the JOSE policy is D-3, the runtime and tooling baseline is D-13, and
credential-validation separation is D-17. The no-conformance statement is repeated in the
plan's §12 non-claims. Where wording differs, the consolidated decision register wins:

1. **Pin 0.5.4 exactly** for the first integration spike; treat newer versions
   as a dependency upgrade requiring a repeat of this audit.
2. **Do not expose OWF's `SchemaMeta` as the TS11 v1.0.1 public contract.** A
   version-aware codec is required; `supportedFormats`, trust-framework values,
   integrity placement and `id` semantics cannot be represented losslessly.
3. **Wrap JOSE verification.** Do not trust the header returned by
   `verifySchemaMeta`; apply a strict header policy and verify `x5c`/trust
   separately. Do not treat the returned `iat` as proof when the payload omitted
   it.
4. **Reuse OWF primitives where they match** (builders, Zod validation for the
   OWF profile, compact JWS, SRI, Type Metadata merge, DCQL, issuer template)
   instead of reimplementing them.
5. **Keep credential validation separate.** The package does not validate
   credentials; AttestBook's validation engine must use credential-format
   libraries and report dimensions independently.
6. **Do not claim TS11 or ETSI conformance** from OWF validation alone. The
   standards traceability matrix and ETSI comparison remain in
   [`docs/traceability.md`](traceability.md) and this document Part II; no conformance
   claim is made.

## 10. Upstream issue candidates

These are candidates to raise with
`openwallet-foundation-labs/identity-common-ts`; they are not filed by this
audit.

| # | Issue | Evidence | Priority |
| --- | --- | --- | --- |
| 1 | `verifySchemaMeta` should validate the JOSE header and `iat`, and must not synthesize `iat` | Accepts `typ: "JWT"`, `alg: "none"`, `alg: "RS256"` over an ES256 signature, missing `x5c`, empty `kid`, and payloads without `iat` or with `iat: 0`; both are replaced with current time | High |
| 2 | `signSchemaMeta` should validate input, bind `alg` to the `Signer`, and allow clock/`iat` injection | Signs `schemaURIs: undefined`; ES256 signer emits an `RS256` header; `iat` is always `Date.now()`; no deterministic option | Medium |
| 3 | Clarify the targeted standard revision and support TS11 v1.0.1 (or publish a versioned codec) | Model diverges from TS11 v1.0.1 in `id`, integrity placement, trust framework, `supportedFormats`, `schemaURIs`, formats and `iat` | High |
| 4 | Make unknown-member handling consistent and lossless | Top-level unknown members accepted by `validateSchemaMeta`, stripped by `SchemaMetaSchema.parse`, retained by `assertValidSchemaMeta` | Medium |
| 5 | Add stable validation issue codes/severity to this package | 0.5.4 returns only `{ path, message }`; PR #404 explicitly defers this package | Medium |
| 6 | Support SRI algorithms beyond `sha256` or document the restriction | `Sha256SriSchema` and `resolveSchemaReferences` reject `sha384`/`sha512`; TS11 references W3C SRI without restricting the algorithm | Medium |
| 7 | Keep `SignedSchemaMeta.payload` consistent with the JWS payload | Returned `payload` omits the injected `iat` that is inside the JWS | Low |
| 8 | Document or implement trust handling | `x5c`, `trustedAuthorities` and certificate chains are not verified by `verifySchemaMeta`; `toDcqlTrustedAuthorities` drops `x509` | High (documentation) / Medium |
| 9 | Support the TS11 catalogue JWS envelope | Only a bare `SchemaMeta` is signed; TS11 list responses use `{ iss, iat, data }` | Medium |

## 11. Assumptions, unknowns and unresolved questions

Assumptions:

- The TS11 document at the cited `main` URL was v1.0.1 on the audit date; its
  version table is the authoritative version record.
- The npm package version identifies the source commit; no `gitHead` is
  available in the tarball.
- The audit environment (Linux x64, the tested Node/Bun versions) is
  representative of CI but not of every deployment target.
- The OWF package's "experimental" label and the specification's Phase 0 gate
  both prohibit treating these results as production conformance evidence.

Unresolved:

- **Which revision is OWF targeting?** The package does not say. Is its model a
  later EC TS11 draft, ETSI EN 319 482-3 v0.0.6, or an OWF-specific profile?
  This should be clarified upstream.
- **What does ETSI EN 319 482-3 draft v0.0.6 require?** NOT_TESTED here; [issue #2](https://github.com/ForkbombEu/credimi-attestbook/issues/2)
  owns the standards comparison. The public ETSI draft directory did not
  expose 482-3 on the audit date.
- **Is `issuanceProfile` normative?** It is absent from the TS11 v1.0.1
  normative schema; no clause is cited in the package README.
- **Which model should AttestBook expose?** Resolved by D-2 and D-4: TS11 v1.0.1 is the
  Phase 1 baseline and the canonical model sits behind the version-aware adapter. OWF's
  `SchemaMeta` is not the public TS11 contract, and ETSI EN 319 482-3 is not a public model
  until the draft is readable and re-audited. This item is no longer open.
- **Which trust frameworks must AttestBook accept?** TS11 names `aki`,
  `etsi_tl` and `openid_federation`; OWF exposes `etsi_tl` and `x509`.
- **Which OID4VCI version** should the issuer template target? The helper emits
  a configuration-shaped object but its compatibility with the chosen OID4VCI
  version was not tested.
- **Upstream timeline:** when will 0.6.0 be stable, and will the validation
  issue model be adopted by this package?
- **Security review:** AttestBook's JOSE wrapper and trust handling need a
  dedicated review; the package's permissive header behaviour must not leak
  into AttestBook.
- **Browser/Deno/ARM** compatibility remains untested.

## 12. Reproduction

```bash
cd research/owf-audit
npm ci
npm run probe
npm run typecheck
```

Bun:

```bash
cd research/owf-audit
bun install
bun run probe:bun
```

The probe prints the 46 runtime exports, validates the OWF-profile document,
demonstrates the TS11 v1.0.1 rejection, records the accepted JOSE-header cases,
exercises SRI/Type Metadata/DCQL/issuer-metadata flows and exits non-zero on a
failed assertion. The audit run passed 35 checks on the tested runtimes.

## 13. References

- [EC TS11 v1.0.1 specification](https://github.com/eu-digital-identity-wallet/eudi-doc-standards-and-technical-specifications/blob/main/docs/technical-specifications/ts11-interfaces-and-formats-for-catalogue-of-attributes-and-catalogue-of-schemes.md)
- [TS11 normative attestations data-model JSON Schema](https://github.com/eu-digital-identity-wallet/eudi-doc-standards-and-technical-specifications/blob/main/docs/technical-specifications/api/ts11-json-cat-attestations-data-model.json)
- [TS11 catalogue OpenAPI](https://github.com/eu-digital-identity-wallet/eudi-doc-standards-and-technical-specifications/blob/main/docs/technical-specifications/api/ts11-cat-of-attestations-jwt-openapi31.yml)
- [OWF identity-common-ts](https://github.com/openwallet-foundation-labs/identity-common-ts)
- [OWF eudi-attestation-schema README](https://github.com/openwallet-foundation-labs/identity-common-ts/tree/main/packages/eudi-attestation-schema)
- [OWF package on npm (0.5.4)](https://www.npmjs.com/package/@owf/eudi-attestation-schema/v/0.5.4)
- [OWF PR #86 — remove `supportedFormats`](https://github.com/openwallet-foundation-labs/identity-common-ts/pull/86)
- [OWF PR #152 — align with catalog policy requirements](https://github.com/openwallet-foundation-labs/identity-common-ts/pull/152)
- [OWF PR #268 — add `x509` trust anchor](https://github.com/openwallet-foundation-labs/identity-common-ts/pull/268)
- [OWF PR #404 — shared validation issue model](https://github.com/openwallet-foundation-labs/identity-common-ts/pull/404)
- [ETSI EN 319 482-3 work item](https://portal.etsi.org/webapp/WorkProgram/Report_WorkItem.asp?WKI_ID=74940)

---

# Part II — TS11 / ETSI / ARF standards baseline (issue #2)

This part records the standards source register, the TS11/ETSI data models and
API, the ARF 3.0 §5.5/§5.6 conceptual model, and the TS11-vs-ETSI EN 319 482-3
comparison. It is the issue #2 deliverable, integrated into this shared file per
the coordination note above instead of replacing Part I. The
requirements-to-clause and requirements-to-test traceability matrix lives in
[`docs/traceability.md`](traceability.md). The OWF package API/export inventory
and its divergence from the TS11 v1.0.1 wire model are covered in Part I
sections 3 and 6 respectively and are not repeated here.

**Status:** Phase 0 research baseline, consolidated into the implementation plan — not an implementation or compliance claim.
**Scope:** EC TS11, EUDI ARF 3.0 §5.5/§5.6, and ETSI EN 319 482-3 (draft), plus the legal instruments and referenced ETSI specifications they depend on.
**Companion documents:** `docs/specification.md` (requirements), `docs/traceability.md` (requirements-to-clause and requirements-to-test matrix).

This document records *verified* sources separately from *draft/restricted/unverified* ones. Nothing here is a claim of ETSI or EC compliance: conformance can only be claimed after implementation and testing against a specific, retrievable source.

* * *

1. Executive summary
--------------------

- The authoritative EC technical specification for the EUDI attestation catalogue is **EC TS11 v1.0.1** ("Specification of interfaces and formats for the catalogue of attributes and the catalogue of attestations"), dated **2026-01-30**. It is freely readable on GitHub (CC BY 4.0). v1.0.1 is an editorial release; the substantive **v1.0** (2025-11-10) was aligned with the then-stable draft of ETSI TS 119 478.
- TS11 is grounded in **Regulation (EU) 910/2014** (eIDAS, Article 45e) and **CIR (EU) 2025/1569** (Articles 7 and 8). These define *what* the catalogues must contain; TS11 defines *how* (data models and an API).
- **ARF 3.0** (§5.5 and §5.6, tag `v3.0.0`, 2026-07-21) defines the conceptual split between a human-readable **Attestation Rulebook**, a machine-readable **attestation scheme**, and the **catalogue** that indexes them. It points to TS11 for the machine-readable scheme format.
- **ETSI EN 319 482-3** is part of the ETSI **"Additional wallet interfaces"** series (verified via the public drafts of Parts 4 and 6). The Part 3 draft the issue references (**v0.0.6**, 27 October 2026) is **not publicly accessible** — it is not in ETSI's public draft directory and requires an ETSI-portal login. Its exact title and normative delta versus TS11 therefore remain **UNVERIFIED**. This is consistent with the OWF package's own "experimental / ETSI specification not yet finalised" notice.
- TS11's core machine-readable artefact is the **`SchemaMeta`** data model (with `Schema` and `TrustAuthority` sub-classes). It is a *metadata/schema and trust-reference* model. It is **not** a credential cryptographic-validation, issuance-protocol or interoperability specification — those are delegated to OpenID4VCI/OpenID4VP, ISO/IEC 18013-5, ISO/IEC 23220-2, SD-JWT and the ETSI trust/policy standards. AttestBook must keep these dimensions separate (see §7 and `docs/traceability.md`).

* * *

2. Source register
------------------

Legend: **verified** = text read from the authoritative location listed here; **restricted** = document exists but requires credentials; **unverified** = referenced but not readable from the listed source.

| # | Document | Version / date | Status | Location |
|---|----------|----------------|--------|----------|
| S1 | EC TS11 — Specification of interfaces and formats for the catalogue of attributes and the catalogue of attestations | **1.0.1** (2026-01-30); substantive 1.0 (2025-11-10) | **verified** | <https://github.com/eu-digital-identity-wallet/eudi-doc-standards-and-technical-specifications/blob/main/docs/technical-specifications/ts11-interfaces-and-formats-for-catalogue-of-attributes-and-catalogue-of-schemes.md> |
| S2 | EUDI Architecture and Reference Framework (ARF) | **3.0.0** (tag dated 2026-07-21) | **verified** | <https://github.com/eu-digital-identity-wallet/eudi-doc-architecture-and-reference-framework> — `docs/main/05-data-model-and-data-exchange-protocols.md` (§5.5, §5.6) |
| S3 | Regulation (EU) 910/2014 (eIDAS), as amended — Article 45e | consolidated | **verified (reference)** | <https://eur-lex.europa.eu/eli/reg/2014/910/oj/eng> |
| S4 | CIR (EU) 2025/1569 — rules for qualified EAAs and PuB-EAAs | 2025-07-29 | **verified (reference)** | <http://data.europa.eu/eli/reg_impl/2025/1569/oj> |
| S5 | ETSI EN 319 482-3 — "Additional wallet interfaces", Part 3 (title/scope unconfirmed) | **draft v0.0.6** (2026-10-27 per issue #2) | **restricted / unverified** | Not in the public ETSI draft directory (requires ETSI-portal login). See §6. |
| S6 | ETSI EN 319 482 series title ("Additional wallet interfaces") | Parts 4 and 6 public drafts | **verified (series title)** | <https://docbox.etsi.org/esi/open/Latest_Drafts/> |
| S7 | ETSI TS 119 478 — Specification of interfaces related to Authentic Sources | **V1.1.1 (2026-01)**, published | **verified (status via EC tracker)** | EC tracker issue #26; ETSI portal WI 74951 |
| S8 | ETSI TS 119 612 — Trusted Lists | V2.3.1 | **verified (reference)** | <https://www.etsi.org/deliver/etsi_ts/119600_119699/119612/> |
| S9 | ETSI TS 119 602 — List of trusted entities; Data model | draft V0.0.1 | **draft** | referenced by TS11 §6 |
| S10 | ETSI EN 319 471 — Policy and security requirements for providers of EAA services | draft V1.1.6 (2026-10) | **verified (title; draft)** | public draft in ETSI docbox |
| S11 | ETSI TS 119 479-2 — EAA Extended Validation Services Framework | draft V1.1.2 (2026-07) | **verified (title; draft)** | public draft in ETSI docbox |
| S12 | `@owf/eudi-attestation-schema` (OWF SDK implementing TS11 SchemaMeta) | **0.5.4** (2026-10-30) | **verified (metadata/README)** | <https://www.npmjs.com/package/@owf/eudi-attestation-schema> |

> The OWF package audit is Part I of this document (issue #1), including its capability matrix (section 7) and API/export inventory (section 3). This Part II records the package version only for coordination and does not repeat Part I's audit.

* * *

3. EC TS11 v1.0.1 — what it specifies
--------------------------------------

TS11 specifies two Commission-run catalogues required by eIDAS Article 45e and CIR (EU) 2025/1569:

1. **Catalogue of attributes** — the index of attributes (drawn from authentic public-sector sources) that QTSPs must be able to verify, with a data model (`Attribute` + `DataService` + `SchemaDistribution`) and discovery/verification interfaces.
2. **Catalogue of attestations** — the index of attestation schemes ("schemas"), with the `SchemaMeta` data model and a management API.

### 3.1 Catalogue of attributes data model (§2)

Main class **`Attribute`** (§2.1), with sub-classes `DataService` (§2.1.1) and `SchemaDistribution` (§2.1.2). Key mandatory properties (multiplicity `[1..*]` or `[1..1]`):

- `name` [1..*] — language-tagged names; at least English SHALL be provided.
- `identifier` [1..1] — RFC 3986 URI carrying namespace, local identifier and version (CIR Article 7(5)(d)).
- `description` [1..*] — SHOULD include English.
- `semanticDataSpecification` [0..1] — optional URI to the OOTS Semantic Repository data model.
- `distributions` [1..*] — array of `SchemaDistribution` (accessURL + mediaType). CIR Article 2(3) requires at least a JSON Schema (`application/json-schema`).
- `nameSpace` [0..1] — optional conforms-to URI.
- `contactInfo` [1..*] — contact URI(s); single contact SHALL be `smtp://` or `https://`.
- `legalBasis` [0..*] — ELI URI of the applicable EU/national law.
- `authenticSources` [1..*] — array of `DataService` (per Member State).

`DataService` (§2.1.1): `country` [1..1], `nationalSubID` [0..1], `endpointDescription` [1..1], `endpointURL` [1..1] (eDelivery party identifier or REST endpoint).

### 3.2 Catalogue of attestations — `SchemaMeta` (§4.3)

The machine-readable attestation scheme model (§4.3.1):

| Field | Multiplicity | Type | Normative meaning |
|-------|--------------|------|-------------------|
| `id` | [0..1] | string (UUID) | server-assigned schema id; absent from the normative JSON Schema `required` list (the prose table lists it as [1..1], which reflects readOnly server-assignment, not client input) |
| `version` | [1..1] | string | SemVer schema version |
| `rulebookURI` | [1..1] | string | URI to the human-readable Attestation Rulebook; may carry `#integrity` (W3C SRI) that the consumer SHALL verify |
| `trustedAuthorities` | [0..*] | `TrustAuthority[]` | trust model/anchors (X.509 AKI, ETSI Trusted List, OpenID Federation) |
| `attestationLoS` | [1..1] | string | `iso_18045_high` / `iso_18045_moderate` / `iso_18045_enhanced-basic` / `iso_18045_basic` |
| `bindingType` | [1..1] | string | `claim` / `key` / `biometric` / `none` |
| `supportedFormats` | [1..*] | string[] | `dc+sd-jwt`, `mso_mdoc`, `jwt_vc_json`, `jwt_vc_json-ld`, `ldp_vc` |
| `schemaURIs` | [1..*] | `Schema[]` | format-specific schema URIs |

Sub-class **`Schema`** (§4.3.2): `formatIdentifier` [1..1] (enumeration above) + `uri` [1..1] (persistent, may carry `#integrity`).

Sub-class **`TrustAuthority`** (§4.3.3): `frameworkType` [1..1] (`aki` | `etsi_tl` | `openid_federation`), `value` [1..1] (base64url AKI, Trusted List URI, or Entity Identifier), `isLOTE` [0..1] (TRUE only for `etsi_tl` pointing at an ETSI TS 119 602 List of Trusted Entities). Note: the normative JSON Schema key is `isLOTE`; the TS11 prose spells it `isLoTE`.

### 3.3 Format-specific schemas (§4.3.4)

- `dc+sd-jwt` (SD-JWT VC) → the **Verifiable Credential Type (VCT)** per OpenID4VCI.
- `mso_mdoc` (ISO mDoc) → the **DocumentType (DocType)** per ISO 23220-2.
- `jwt_vc_json` / `jwt_vc_json-ld` / `ldp_vc` (W3C VCDM) → per OpenID4VCI Appendix A.1.

If several formats are supported, the registering entity SHALL provide all schemas at registration.

### 3.4 Signing and integrity requirements

- `rulebookURI` and `Schema.uri` MAY be suffixed with `#integrity` (W3C SRI); when present, the consumer SHALL verify the referenced document (§3 of W3C SRI). (§4.3.1, §4.3.2)
- API responses (GET and PUT) SHALL be **JWS-signed** (§5.3.1, §5.3.2).
- This JWS signing protects the *catalogue metadata*, not issued credentials. Credential-level signature/validation is out of TS11 scope.

### 3.5 Catalogue of attestations API (§5)

- `GET /schemas` — public query with filter parameters (`id`, `supportedformat`, `attestationlos`, `bindingtype`, `trustedAuthoritiesFrameworkType`, `trustedAuthoritiesValue`, `schemauri`, `rulebookuri`) and pagination. (§5.3.1)
- `GET /schemas/{schemaId}` — single `SchemaMeta`. (§5.3.1)
- `PUT /schemas/{schemaId}` — update full `SchemaMeta`. (§5.3.2)
- `DELETE /schemas/{schemaId}` — delete; `204`/`404`. (§5.3.3)
- OpenAPI 3.1 definition in Annex A.3 (normative). JSON Schemas in Annex A.1 (attributes) and A.2 (attestations) (normative); XML schemas in Annex A.4 (informative).
- Read access is public (§5.2.1); write/delete is restricted to the authenticated registering entity (§5.2.2, §4.5.3).
- DDoS/abuse protection: §5.4 is a **SHALL** ("SHALL take into consideration the vulnerabilities"); the concrete mitigations in §5.5–§5.6 are **SHOULD**.

### 3.6 Versioning and governance (§4.5)

- A newly published rulebook SHALL start at version 1.0; lifecycle uses SemVer (§4.5.1).
- Maintenance via the versioning system (human-readable) and the API (machine-readable) (§4.5.2).
- Operations SHALL be authorised only for the entity that registered the schema (§4.5.3).

* * *

4. ARF 3.0 §5.5 / §5.6 — the conceptual model
----------------------------------------------

ARF 3.0 `docs/main/05-data-model-and-data-exchange-protocols.md`:

- **§5.5.1** — the Rulebook is "documentation for people", the scheme is "the specification for software", and the catalogue is where both are discovered. A rulebook specifies the attestation scheme and proof mechanisms, trust mechanisms (where required), attribute identifiers/syntax/semantics, and required presentation protocol(s).
- **§5.5.2** — Rulebooks are defined by Attestation Scheme Providers: the EC (PID, mDL rulebooks), public/sectoral/cross-border organisations, individual providers (add-on rulebooks), and single organisations (internal-use rulebooks).
- **§5.5.3** — publishing in the catalogue requires supplying the **machine-readable attestation scheme in accordance with TS11**.
- **§5.6.2** — the catalogue of attributes is for QTSPs to locate the authentic-source access point (verification).
- **§5.6.3** — principles for the catalogue of attestation schemes: machine-readable schemes referring to the human rulebook; registration of QEAA/PuB-EAA schemes *may* happen but is "not mandatory"; non-qualified EAA registration is also "not mandatory"; public access; registration implies no acceptance obligation.

### 4.1 ARF vs TS11 — an obligation discrepancy to flag

ARF §5.6.3 states registration of QEAA/PuB-EAA attestation schemes is **"not mandatory"**, whereas TS11 §4.2 states that all QEAA and Pub_EAA Attestation Rulebooks **"SHALL be published"** in the Commission catalog (and TS11 §4.1 says providers **SHOULD** register). These three statements are in tension. For AttestBook this means: catalogue registration status must not be inferred from a single source, and the product must not treat "registered in catalogue" as a hard rule for every rulebook it imports. This is recorded as an open question (see §8).

* * *

5. Normative obligations vs design choices
------------------------------------------

**Normative (SHALL / MUST), i.e. conformance-relevant for a TS11 catalogue implementation:**

- `SchemaMeta` mandatory fields and enumerations (§4.3.1–§4.3.3).
- Format identifiers and their per-format schema types (§4.3.4).
- JSON Schema media type `application/json-schema` for attribute schemas (§2.1.2).
- JWS-signed API responses (§5.3).
- Public read / authorised write-delete split (§5.2.1, §5.2.2, §4.5.3).
- SemVer versioning starting at 1.0 (§4.5.1).
- SRI integrity verification when `#integrity` is present (§4.3.1, §4.3.2).

**Recommended (SHOULD) / permitted (MAY):**

- Registration of non-qualified EAAs (SHOULD/RECOMMENDED; §4.1, §4.2).
- DDoS/misuse consideration (SHALL to take vulnerabilities into account; §5.4) and concrete mitigations (SHOULD; §5.5–§5.6).
- OpenID Federation only for non-qualified EAAs (MAY; §4.3.1).
- Additional language localisations, `#integrity` suffix (MAY).

**AttestBook design choices (not normative — must not pollute standards documents):**

- Internal persistence/registry model, rulebook version storage, content digests, and provenance metadata (spec FR-001–FR-003).
- The adapter layer around the OWF SDK.
- Any UI, REST API grouping, and capture-integration contracts.

* * *

6. TS11 vs ETSI EN 319 482-3 — comparison status
-------------------------------------------------

The ETSI **EN 319 482** series is titled **"Electronic Signatures and Trust Infrastructures (ESI); Additional wallet interfaces"** (verified from the public drafts of Parts 4 and 6). The issue references **EN 319 482-3 draft v0.0.6 (27 October 2026)** as the future standard to compare against TS11.

**What could be verified:**

- The series exists and is in draft. Parts 4 ("Specification of Wallet-to-Wallet interactions", v0.0.3, 2026-08) and 6 ("Data Portability and Download (export)", v0.0.3, 2026-09) are publicly downloadable from ETSI's open draft directory and are in "call for comments".
- Part 3 is **not** in the public draft directory; the requested `-public` URL resolves to the ETSI-portal login page. Its exact title and clause-by-clause content could not be read.

**What could not be verified (no claim is made):**

- The exact title and scope of Part 3.
- Which TS11 elements Part 3 keeps, changes, adds, or drops.
- Whether Part 3 replaces TS11's `SchemaMeta` model or profiles it.
- Any new metadata fields, validation rules, or API changes.
- A migration path beyond "design a version-aware adapter".

**Consequence for AttestBook:** the standards adapter must be **version-aware** from the start, pin **TS11 1.0.1** as the Phase 1 baseline, and treat EN 319 482-3 as an evolving target whose requirements are re-verified when the draft becomes publicly accessible. The OWF package's own warning ("the underlying ETSI specification is not yet finalised … breaking changes are possible") corroborates this.

Related ETSI attestation standards (drafts, publicly visible titles only) that influence but do not define the schema model: EN 319 471 (EAA service provider policy/security requirements), TS 119 479-2 (EAA extended validation services), TS 119 605 (LoTE procedures), TS 119 602 (LoTE data model), TS 119 612 (Trusted Lists).

* * *

7. Dimension separation (credential structure vs crypto/trust/protocol/interoperability)
----------------------------------------------------------------------------------------

TS11 governs **schema/metadata structure** and **trust-model references** plus **signing of the metadata itself**. It does **not** define:

| Dimension | TS11 role | Covered by (referenced, not in TS11) |
|-----------|-----------|--------------------------------------|
| Credential parsing / format recognition | `supportedFormats` + `Schema.formatIdentifier` identify the *expected* formats | format-specific parsers (SD-JWT, mdoc, W3C VC) |
| Schema / structural validation | normative JSON Schemas (Annex A) and per-format schema types | JSON Schema + VCT/DocType/W3C VC schemas |
| Cryptographic verification (of the credential) | none | SD-JWT VC, ISO/IEC 18013-5, OpenID4VP proof mechanisms |
| Trust validation | `TrustAuthority` references (AKI / Trusted List / Federation) only | ETSI TS 119 612 / TS 119 602, X.509 path validation, OpenID Federation |
| Protocol conformance | none (API only manages schemas) | OpenID4VCI, OpenID4VP, ISO/IEC 18013-5 |
| End-to-end interoperability | none | external test orchestration (Credimi) |

AttestBook's validation engine must therefore report schema/attestation-constraint results separately from cryptographic, trust, protocol and interoperability results, and never mark a dimension PASS that it did not execute (spec FR-010, FR-012, AC-16, AC-17). The full mapping is in `docs/traceability.md`.

* * *

8. Unsupported / ambiguous / draft / unverified requirements
------------------------------------------------------------

1. **ETSI EN 319 482-3 draft v0.0.6** — restricted, content unverified (see §6). Cannot yet be cited clause-by-clause.
2. **ARF vs TS11 registration obligation** — ARF §5.6.3 ("not mandatory") vs TS11 §4.2 ("SHALL be published") vs §4.1 ("SHOULD register"). Ambiguous; do not encode a single hard rule.
3. **`attestationLoS` → issuer/verifier enforcement** — TS11 gives the enum and points to OpenID4VCI Annex D.2 for the issuance process, but AttestBook's role in *enforcing* LoS at validation time is not defined by TS11; treat as product-level/out-of-scope.
4. **`TrustAuthority` value semantics** — TS11 defines the field but delegates actual trust resolution to ETSI Trusted Lists / LoTE / OpenID Federation; AttestBook must not claim to perform trust validation solely from this field.
5. **`isLOTE` / `isLoTE` spelling** — the normative JSON Schema key is `isLOTE`; the TS11 prose spells it `isLoTE`. TS11 also notes the field "will become unnecessary and shall be deprecated" once OpenID4VCI adds an `etsi_lote` enumeration (§4.3.3 note). Forward-compatibility risk.
6. **W3C VCDM profiles** — ARF §5.4 notes ETSI profiles for W3C VCDM are pending; W3C VCDM attestations cannot be used in proximity (ISO/IEC 18013-5). Not yet fully profiled.
7. **API authorisation mechanics** — TS11 §5.2.2 defers the concrete authorisation mechanism to a future version ("will be defined … into section 5.2.2 in future version"). The PUT/DELETE auth method is unspecified today.
8. **TS 119 602 (LoTE) and TS 119 605** — both still drafts; LoTE-based trust handling is unstable.
9. **ETSI TS 119 478** — TS11 1.0 was aligned with its then-stable draft; the published V1.1.1 (2026-01) is the current interface spec, and the EC tracker notes it is planned to become an EN with minor gaps to resolve. Any authentic-source discovery/verification built on it must pin the exact version.

* * *

9. Migration implications (TS11 → ETSI)
---------------------------------------

1. **Pin TS11 1.0.1 as the Phase 1 baseline** and encode the version in stored artefacts so future migration can be mechanical.
2. **Isolate the model behind a Standards Adapter** (spec §4.1): no TS11 types may leak into registry/validation internals. This is the single most important structural decision for absorbing EN 319 482-3 changes.
3. **Store the source specification version and the schema digest** with each rulebook/schema, so validation is reproducible and re-verifiable against a later standard.
4. **Treat enumerated values (`supportedFormats`, `attestationLoS`, `bindingType`, `frameworkType`) as extensible data, not closed TypeScript unions**, so new ETSI values (e.g. `etsi_lote`) can be added without breaking callers.
5. **Do not duplicate OWF models**; keep AttestBook-specific metadata out of the TS11 documents to preserve interoperability (spec §2.1, FR-001).
6. **Re-verify EN 319 482-3** when its draft becomes public or is published, and only then record the clause-by-clause delta and update the traceability matrix.

* * *

10. Assumptions and open questions
----------------------------------

Assumptions recorded for this phase:

- "EC TS11 v1.0.1 (January 2026)" in issue #2 maps to the document's own version table: v1.0.1 dated 2026-01-30 (editorial: licensing/reuse clarification).
- "ARF 3.0" maps to the `v3.0.0` tag of `eudi-doc-architecture-and-reference-framework`.
- "ETSI EN 319 482-3 draft v0.0.6 (27 October 2026)" is taken from issue #2 as the target draft identifier; its content was not retrievable.

Open questions resolved by decisions D-9 to D-12 in
[`docs/implementation-plan.md`](implementation-plan.md) §3:

- OQ-1: The ARF-vs-TS11 registration-obligation discrepancy is handled by D-12, which keeps
  source conformance, registration claims and AttestBook compatibility as separate metadata
  and does not encode a single hard rule.
- OQ-2: D-9 validates `attestationLoS`/`bindingType` vocabulary and rulebook consistency
  only; it does not enforce issuer-side issuance or LoS processes.
- OQ-3: D-10 uses a provisional, self-contained bearer-token/actor model for product write
  APIs and does not claim the unspecified TS11 catalogue authorisation mechanism or expose a
  TS11 catalogue write API in Phase 1.
- OQ-4: D-11 verifies `#integrity` only over bytes fetched through the SSRF-safe, bounded
  fetcher; `sha256` is supported and other algorithms are reported unsupported, not PASS.

* * *

11. References
--------------

See the source register (§2). Key URLs:

- TS11 v1.0.1: <https://github.com/eu-digital-identity-wallet/eudi-doc-standards-and-technical-specifications/blob/main/docs/technical-specifications/ts11-interfaces-and-formats-for-catalogue-of-attributes-and-catalogue-of-schemes.md>
- ARF 3.0 §5.5/§5.6: <https://github.com/eu-digital-identity-wallet/eudi-doc-architecture-and-reference-framework/blob/v3.0.0/docs/main/05-data-model-and-data-exchange-protocols.md>
- CIR (EU) 2025/1569: <http://data.europa.eu/eli/reg_impl/2025/1569/oj>
- ETSI public draft directory: <https://docbox.etsi.org/esi/open/Latest_Drafts/>
- EC tracker, ETSI TS 119 478: <https://github.com/eu-digital-identity-wallet/eudi-doc-standards-and-technical-specifications/issues/26>
- OWF package: <https://www.npmjs.com/package/@owf/eudi-attestation-schema>
