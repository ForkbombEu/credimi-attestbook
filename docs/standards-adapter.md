# Standards adapter: OWF-backed TS11 handling

**Status:** Phase 1 implementation for
[issue #27](https://github.com/ForkbombEu/credimi-attestbook/issues/27). This document
describes what the adapter actually does and does not claim TS11, ETSI or cryptographic
conformance beyond the checks listed here.

**Authoritative context:** [`docs/specification.md`](specification.md) §2–§3 and §18;
[`docs/standards.md`](standards.md) (OWF audit and TS11 field comparison);
[`docs/architecture.md`](architecture.md) §7 (canonical model); decisions D-1–D-5 in
[`docs/implementation-plan.md`](implementation-plan.md) §3.

## 1. Scope and code layout

`src/standards/` is the narrow, version-aware boundary between wire documents and the
canonical AttestBook model. It is not the registry, the HTTP API or the credential
validation engine (those arrive in later slices).

| File | Responsibility |
| --- | --- |
| `src/standards/model.ts` | Canonical model, profile identifiers and separate product metadata |
| `src/standards/profiles.ts` | Profile detection and pinned baseline enumerated values |
| `src/standards/owf.ts` | OWF 0.5.4 codec; validation and serialization delegated to the real package |
| `src/standards/ts11.ts` | TS11 v1.0.1 translation extension (OWF cannot parse this shape) |
| `src/standards/codec.ts` | Profile detection, parse/validate/serialize orchestration |
| `src/standards/jose.ts` | Strict JOSE policy around OWF `signSchemaMeta`/`verifySchemaMeta` |
| `src/standards/references.ts` | SRI reference-resolution boundary around OWF `resolveSchemaReferences` |
| `src/standards/diagnostics.ts` | Structured diagnostics and their `invalid_input` / `unsupported_operation` split |

Production code imports from `src/standards/index.ts`. That barrel also re-exports
the low-level codecs for tests and later slices, but consumers should normally use
`parseSchemaMetaDocument`, `serializeSchemaMeta`, `signSchemaMetaJws`,
`verifySchemaMetaJws`, `resolveSchemaMetaReferences` and the diagnostics types; the
wire modules remain an implementation detail.

## 2. Operations

| Operation | TS11 v1.0.1 | OWF 0.5.4 | Evidence |
| --- | --- | --- | --- |
| Profile detection | adapter-owned | adapter-owned | `src/standards/profiles.test.ts` |
| Structural parsing and validation | adapter-owned translation extension | real package `validateSchemaMeta` | `ts11-codec.test.ts`, `owf-codec.test.ts` |
| Serialization | adapter-owned translation extension | real package validation after building | `serializeTs11SchemaMeta`, `serializeOwfSchemaMeta` |
| Strict baseline validation | `validateSchemaMetaDocument` rejects additions | OWF validates, then the adapter baseline-strict check rejects unknown top-level members | `ts11-codec.test.ts`, `owf-codec.test.ts` |
| JWS signing | **unsupported** (see §7) | real `signSchemaMeta` behind the JOSE policy | `jose.test.ts` |
| JWS verification | **unsupported** for the TS11 list envelope | real `verifySchemaMeta` behind the JOSE policy | `jose.test.ts` |
| SRI reference resolution | only for OWF-representable documents, sha256 only; disabling verification is reported `not_tested` | real `resolveSchemaReferences` | `references.test.ts` |

The tests execute the real pinned package under Bun. Browser-style mocks are not used for
`validateSchemaMeta`, `signSchemaMeta`, `verifySchemaMeta` or `resolveSchemaReferences`.

### 2.1 OWF public API used by production code

| OWF export | Used for |
| --- | --- |
| `validateSchemaMeta` | OWF structural validation, both on parse and after serialization |
| `signSchemaMeta` | OWF-profile compact JWS creation |
| `verifySchemaMeta` | OWF-profile signature and payload verification |
| `resolveSchemaReferences` | SRI verification, Type Metadata `extends` handling and JSON Schema parsing |
| `SchemaMeta`, `SchemaURI`, `TrustAuthority`, `SignOptions`, `VerifyOptions`, `ResolvedSchemaReference`, `AttestationFormat` types | typed adapter boundary |

`@owf/crypto` is a **dev dependency only**: tests generate a real ES256 key pair, while
production callers inject OWF `Signer`/`Verifier` functions. The production adapter never
creates keys or certificates.

## 3. Canonical model and product metadata

The canonical model (see `model.ts`) holds the union AttestBook needs:
`id`, `iat`, `version`, `rulebookURI`/`rulebookIntegrity`, `trustedAuthorities`,
`attestationLoS`, `bindingType`, `supportedFormats`, `schemaURIs`, `issuanceProfile`,
and preserved unknown members.

Rules:

- Enumerated values are stored as **strings**, not closed TypeScript unions, so a future
  value is preserved and reported rather than rejected or coerced (decision D-5).
- `parseSchemaMetaDocument` preserves unknown top-level and nested members and reports a
  `preserved` diagnostic. For the OWF profile, nested objects are strict in the real
  package, so nested preservation applies to TS11 v1.0.1 only.
  `validateSchemaMetaDocument` is the strict baseline variant and rejects them.
- OWF `supportedFormats` does not exist; the canonical value is derived from the unique
  `schemaURIs[*].formatIdentifier` values.

Product metadata is a **separate type** (`ProductMetadata`) and a separate wrapper
(`AttestBookSchemaMeta`). Serializers take only `CanonicalSchemaMeta`; the
`serializeAttestBookSchemaMeta` helper deliberately passes only `.schemaMeta`, so
`rulebookId`, `providerId`, `publicationStatus` and `sourceUrl` can never appear in a
standards document. `productMetadataLeaks` guards a canonical object against accidental
field merging. A test asserts that internal values do not appear in serialized output.

## 4. Diagnostics

Every finding has `kind`, a stable `code`, a message and, where known, a `path`.
`formatDiagnostics` renders the kind explicitly.

| Kind | Meaning | Consumer reaction |
| --- | --- | --- |
| `invalid_input` | The provided document, value or canonical model is malformed or invalid for the requested operation | reject the request with a validation error |
| `unsupported_operation` | The adapter, the pinned OWF package or a profile cannot perform the requested operation | report the capability gap; do not retry as if the input were malformed |
| `not_tested` | The operation ran but a dimension was not checked (currently x5c chain, trust anchor and `trustedAuthorities`) | report `NOT_TESTED`, never PASS |
| `preserved` | Forward-compatible data was kept instead of dropped | keep and surface, do not coerce |

Representative codes:

- invalid input: `invalid_schema_meta`, `missing_required_member`, `invalid_member_value`,
  `invalid_ts11_id`, `unknown_profile`, `ambiguous_profile`, `invalid_jose_header`,
  `invalid_signature`, `synthetic_iat`, `invalid_signing_certificate`, `signing_failed`,
  `invalid_reference`, `integrity_mismatch`.
- unsupported operation: `unsupported_profile`, `unsupported_format`,
  `unsupported_trust_authority`, `unsupported_sri_algorithm`,
  `unsupported_schema_meta_member`, `unsupported_jose_algorithm`.
- not tested: `trust_not_tested`, `integrity_not_verified`.
- preserved: `preserved_unknown_member`, `preserved_unknown_value`,
  `signing_time_stamped`.

A serialization that fails because the target profile requires a member the source profile
does not carry is `unsupported_operation`, not `invalid_input`; a canonical document missing
a member that both profiles require is `invalid_input`.

## 5. Directional translation limits

The two profiles are not drop-in equivalent (see [`docs/standards.md`](standards.md) §6).
The adapter never silently drops data; it reports the reason.

| Conversion | Result |
| --- | --- |
| TS11 → canonical → TS11 | supported, including unknown-member preservation |
| OWF → canonical → OWF | supported; OWF validates the rebuilt document |
| TS11 → OWF | supported only when the TS11 document can satisfy OWF requirements |
| OWF → TS11 | supported only when the OWF document uses TS11-representable values |

Concrete unsupported cases:

| Cause | Diagnostic | Path example |
| --- | --- | --- |
| OWF `SchemaURI.meta` has no TS11 member | `unsupported_schema_meta_member` | `schemaURIs.0.meta` |
| OWF `issuanceProfile` has no TS11 member | `unsupported_schema_meta_member` | `issuanceProfile` |
| OWF `iat` has no TS11 `SchemaMeta` member | `unsupported_schema_meta_member` | `iat` |
| OWF `x509` direct anchor is not a TS11 framework | `unsupported_trust_authority` | `trustedAuthorities.0.frameworkType` |
| `x509` framework inside a TS11 document | `invalid_member_value` | `trustedAuthorities.0.frameworkType` |
| OWF `verificationMethod` has no TS11 member | `unsupported_trust_authority` | `trustedAuthorities.0.verificationMethod` |
| OWF requires per-schema `integrity`/`meta`, TS11 does not carry them | `unsupported_schema_meta_member` | `schemaURIs.0.integrity`, `schemaURIs.0.meta` |
| OWF requires `rulebookIntegrity`, TS11 allows a fragment-free URI | `unsupported_schema_meta_member` | `rulebookIntegrity` |
| OWF requires an `X509Certificate` verification method for `etsi_tl` | `unsupported_trust_authority` | `trustedAuthorities.0.verificationMethod` |
| OWF `isLOTE` has no OWF member | `unsupported_trust_authority` | `trustedAuthorities.0.isLOTE` |
| TS11 format not supported by OWF (`jwt_vc_json`, `jwt_vc_json-ld`, `ldp_vc`) | `unsupported_format` | `schemaURIs.0.formatIdentifier` |
| TS11 `aki`/`openid_federation` trust framework | `unsupported_trust_authority` | `trustedAuthorities.0.frameworkType` |
| `sha384`/`sha512` SRI | `unsupported_sri_algorithm` | `schemaURIs.0.integrity` |
| OWF URL `id` exported as TS11 | `unsupported_schema_meta_member` | `id` |
| Malformed canonical `id` (neither UUID nor URL) | `invalid_ts11_id` | `id` |
| OWF requires a URL `id`; TS11 marks `id` optional or carries a UUID | `unsupported_schema_meta_member` | `id` |

## 6. Strict JOSE policy

OWF `verifySchemaMeta` does not authenticate `typ`, `alg`, `kid` or `x5c`, and it synthesises
`iat` from the verifier clock when the payload lacks one or has `iat: 0`
([`docs/standards.md`](standards.md) §5.4). AttestBook therefore applies this policy on top
of the real package:

| Check | Behaviour |
| --- | --- |
| Algorithm allowlist | `ES256`, `ES384`, `ES512`, `RS256`, `RS384`, `RS512`; ES256 is the default. Other values are `unsupported_operation`. |
| Key binding | The header `alg` must equal the algorithm the caller expects and the header `kid` must equal the expected key id; signing uses a single caller-declared algorithm for both key and header. |
| `typ` | Must be `attestation-schema+jwt`. |
| `x5c` | Signing requires one PEM certificate per entry; verification requires a non-empty chain of non-empty entries. |
| Header extensions | `crit`, `b64`, `jwk`, `jku` and `x5u` are rejected. |
| `iat` | Must be a positive integer present in the signed payload and equal to the value OWF returns. A synthesised value is rejected (`synthetic_iat`). |
| Signature | Delegated to OWF `verifySchemaMeta`; a failure is `invalid_signature` or `invalid_schema_meta`. |
| `iat` on signing | OWF `signSchemaMeta` always stamps the current time and replaces a canonical `iat`; the replacement is reported with `signing_time_stamped` (`preserved`), not hidden. |
| Trust | x5c chain, trust anchor and `trustedAuthorities` are **not** validated; every successful verification carries `trust_not_tested`. |

TS11 catalogue response signing uses a `{ iss, iat, data }` list envelope that OWF does not
implement. It is an unsupported operation in this adapter; only bare OWF-profile
`SchemaMeta` JWS is supported.

## 7. Unsupported functions

The following are explicitly out of scope or unsupported, and are reported rather than
silently approximated:

- TS11 catalogue response envelope signing (`{ iss, iat, data }`) and any catalogue API
  server/client.
- Certificate-chain, trust-anchor, trusted-list and `trustedAuthorities` verification
  (reported `trust_not_tested`).
- `sha384`/`sha512` SRI verification or resolution through OWF (sha256 only).
- Fetching or verifying the **rulebook** document itself. The adapter parses and
  round-trips `rulebookURI#integrity=`, but bytes are fetched and checked by the bounded
  import slice ([#30](https://github.com/ForkbombEu/credimi-attestbook/issues/30)), not here.
- Credential parsing, credential schema validation, credential cryptography, protocol
  conformance and interoperability (later slices; OWF has no credential validator).
- Registry persistence, publication lifecycle and provider ownership.
- DCQL generation and OID4VCI issuer-metadata helpers, although OWF exposes them; they are
  not part of this adapter yet.
- The OWF `0.6.0-alpha` prerelease. The adapter is pinned to 0.5.4 and validated against
  only that version.

## 8. Verification evidence

`bun test src/standards` covers:

- TS11 positive, negative and round-trip cases, including malformed URIs, SRI values, UUIDs,
  duplicate formats, cross-member format consistency, unknown members and unknown enum
  values;
- OWF parsing/serialization through the real package, agreement with `validateSchemaMeta`
  on valid and invalid documents, real-package validation errors, baseline-strict unknown
  members, `__proto__` rejection and preserved-member collisions;
- JOSE positive and negative flows with a real ES256 key: tampered signature, wrong key,
  wrong `kid`, wrong algorithm, missing `x5c`, wrong `typ`, `crit` and other extensions,
  multi-certificate entries, `alg: none`, and a synthesised `iat` that OWF accepts but
  the adapter rejects;
- SRI resolution through OWF: matching content, mismatching content, `verifyIntegrity:
  false` reported `not_tested`, the `maxExtendsDepth` ceiling, sha384 unsupported,
  unsupported formats and resolver failures;
- diagnostics that separate `invalid_input` from `unsupported_operation`, and product
  metadata that never reaches a serialized document.

The suite runs under the CI Bun version pinned in
`.github/workflows/ci.yml`. No TS11, ETSI EN 319 482-3,
trust, protocol or interoperability conformance is claimed from these tests.
