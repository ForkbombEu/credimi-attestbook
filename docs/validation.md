# Credential validation: SD-JWT VC structural evidence

**Status:** Phase 1 implementation for
[issue #32](https://github.com/ForkbombEu/credimi-attestbook/issues/32) and
[issue #33](https://github.com/ForkbombEu/credimi-attestbook/issues/33). This document
describes the checks that actually run, the typed API, the per-dimension applicability
model and the evidence it returns. It makes no cryptographic, trust, protocol,
interoperability or standards-conformance claim.

**Authoritative spec:** [`docs/specification.md`](specification.md) FR-009–FR-012 and §13.
**Architecture:** [`docs/architecture.md`](architecture.md) §8 (dimension status model) and
§11 (security outline). **Decisions:** [`docs/implementation-plan.md`](implementation-plan.md)
D-6 (exact-byte digest), D-8 (conservative aggregation), D-9 (vocabulary, not issuer
enforcement), D-14 (SD-JWT VC + Ajv) and D-17 (structural scope only).
**Evidence model:** [`docs/traceability.md`](traceability.md). **Pinned version reads:**
[`docs/registry.md`](registry.md). **Real libraries:** [`docs/standards-adapter.md`](standards-adapter.md).

## 1. What the engine executes

`POST /api/v1/credentials/validate` validates one credential artifact against one **immutable,
published or draft rulebook version**. The engine:

1. reads the rulebook and version from the registry and recomputes the SHA-256 of the stored
   snapshot bytes; a mismatch aborts the run as an internal integrity failure;
2. resolves the selected attestation type from that snapshot, not from the current draft;
3. recognises the credential format from the artifact (or an explicit caller hint);
4. parses a real SD-JWT VC with the pinned `@sd-jwt/core` 0.24.1 parser, including disclosure
   digest verification, unreferenced/duplicate disclosure detection and protected-claim rules;
5. applies the schema documents the caller supplies for the pinned rulebook references:
   SD-JWT VC Type Metadata through `@sd-jwt/sd-jwt-vc` 0.24.1
   `verifyClaimsAgainstTypeMetadata`, or JSON Schema 2020-12 through Ajv 8.20.0;
6. checks attestation constraints that are observable in a credential (format support,
   `attestationLoS`/`bindingType` vocabulary, key binding via an issuer-signed `cnf`);
7. returns per-dimension statuses, an explicit applicability/execution flag and machine-readable
   evidence for each dimension, structured findings with JSON Pointer paths, the explicit
   limitation list, and the pinned rulebook version and digest.

The following are **not** executed and never reported PASS: signature verification,
key-binding proof verification, status-list checks, issuer trust, protocol conformance and
end-to-end interoperability (FR-010, FR-012, D-17).

## 2. Dimension applicability and evidence

Every result carries the eight FR-010 dimensions in normative order. Each dimension reports
`status`, `applicable`, `executed`, `findings` and an `evidence` object with a `scope` (what
a real execution evaluates), a `reason` (why the dimension did or did not run) and
non-sensitive `details` facts. The engine builds every dimension through `createDimension`
(`src/validation/dimensions.ts`), which rejects a status that contradicts applicability or
execution. An unexecuted dimension therefore **cannot** be returned as `PASS`: `PASS` and
`FAIL` require an applicable, executed check; `NOT_TESTED` requires an applicable,
unexecuted dimension; `INCONCLUSIVE` requires an executed check with a warning and no error;
`NOT_APPLICABLE` requires an unexecuted, non-applicable dimension.

| # | Dimension | Owner | Executed here | Applicability to one credential artifact | Evidence detail |
| --- | --- | --- | --- | --- | --- |
| 1 | `credential_parsing` | AttestBook | yes | conditional on a recognised format with a structural parser | parser outcome, disclosure count and bounds |
| 2 | `format_recognition` | AttestBook | yes | required | recognised format, detection source, parser availability |
| 3 | `cryptographic_verification` | external | no | required | explicitly records issuer JWS signature, KB-JWT proof and status-list checks as not executed |
| 4 | `schema_validation` | AttestBook | yes | conditional on a matching pinned reference and supplied document | reference count, documents supplied/applied, findings |
| 5 | `attestation_constraints` | AttestBook | yes | required | format support, TS11 vocabulary, key-binding presence |
| 6 | `issuer_trust` | external | no | required | explicitly records that no trust anchors were applied |
| 7 | `protocol_conformance` | external | no | not applicable to a standalone artifact | explicitly records that no protocol exchange exists |
| 8 | `interoperability` | external | no | not applicable to a standalone artifact | explicitly records that no external wallet/verifier execution occurred |

The `applicability` column follows D-8: applicability is decided by the selected rulebook,
credential format and request, not by whether AttestBook implements the check. Cryptography
and issuer trust are required for any credential, so their absence is `NOT_TESTED`, never
`NOT_APPLICABLE`. Protocol conformance and interoperability are request-scoped
`NOT_APPLICABLE` because a single credential artifact contains no issuer/verifier interaction
and no external execution; those statuses assert nothing about success and are never derived
from another dimension passing.

The result also carries `limitations`: every finding of a dimension whose status is not
`PASS` or `FAIL`, with a stable `code`, the `dimension`, its `status` and a non-sensitive
message. For a structurally valid credential the list explicitly names the unverified issuer
signature, key-binding proof, status-list check, issuer trust, protocol conformance and
end-to-end interoperability. A caller never has to infer an absent crypto, trust, protocol or
interoperability check from `overallStatus` alone.

## 3. Why schema documents are supplied by the caller

A rulebook version snapshot records schema references (`formatIdentifier`, `uri`, W3C SRI
`integrity`); it does not embed the fetched schema bodies. AttestBook does not fetch remote
schemas in this slice: the SSRF-safe, size-limited fetch path is issue #30. The request
therefore carries `schemaDocuments` with the **exact UTF-8 document text**. The engine:

- requires every supplied URI to match a schema reference of the selected attestation type in
  that exact rulebook version (otherwise `400 invalid_request`);
- verifies `sha256-...` SRI over the UTF-8 encoding of the exact supplied text when the
  reference carries one; a mismatch is `FAIL` and the document is **not compiled or applied**;
  an invalid or `sha384`/`sha512` pin is `INCONCLUSIVE` and is also not applied; a reference
  with no `#integrity` is `NOT_TESTED` and is not applied;
- treats a document with a string `vct` as SD-JWT VC Type Metadata and any other object as
  JSON Schema 2020-12; type metadata with an `extends` parent is applied for its own claims
  but reported `INCONCLUSIVE` with `type_metadata_extends_unsupported` because the parent
  chain is not resolved yet;
- executes JSON Schema only when it declares JSON Schema 2020-12 (or no `$schema`) and uses
  no keyword AttestBook cannot bound safely. `format`, `pattern`, `patternProperties`,
  `uniqueItems`, the legacy `dependencies` applicator and the
  `$ref`/`$dynamicRef`/`$recursiveRef` family are reported `NOT_TESTED` with
  `unsupported_schema_keyword`; unknown keywords and other dialects are also `NOT_TESTED`
  instead of being ignored and reported as validated. A document that mixes a root `vct`
  with JSON Schema keywords is `NOT_TESTED` as `ambiguous_schema_document` because either
  classification would skip constraints. JSON Schema and Type Metadata evaluation runs in a
  separate Bun worker process with a 2-second hard timeout and a 256 MiB RSS watchdog; hitting
  either limit is reported as `NOT_TESTED`, not as a credential failure.

A reference with no supplied document makes schema validation `NOT_TESTED`. A reference whose
integrity pin cannot be verified (unsupported algorithm or malformed value) is not applied; if
no pinned reference was applied, the schema dimension is `NOT_TESTED` with `executed: false`
rather than an executed `INCONCLUSIVE`. A `FAIL` remains an executed conclusion even when the
failing reference was not applied. Supplying an unrelated schema cannot widen validation
silently.

## 4. Typed contract

```http
POST /api/v1/credentials/validate
Content-Type: application/json
```

```json
{
  "rulebookId": "9f1c1f6e-3a8e-4e7d-9d2c-0f3b5a7c1e11",
  "rulebookVersion": "1.0",
  "attestationType": "PID",
  "credential": "<compact SD-JWT VC or { \"format\": \"mso_mdoc\", \"value\": \"...\" }>",
  "schemaDocuments": [
    {
      "uri": "https://example.org/vct/pid",
      "content": "{\"vct\":\"https://example.org/vct/pid\",\"claims\":[...]}"
    }
  ]
}
```

`credential` may be a bare string (auto-detected) or `{ format?, value }`. `schemaDocuments`
is optional and limited to four documents of at most 128 KiB each; the body is limited to
4 MiB. The credential itself is limited to 512 KiB.

The response is wrapped in the product-API success envelope (`{ "data": ... }`; see
[`docs/api.md`](api.md)). The `data` object includes:

| Field | Meaning |
| --- | --- |
| `validationId`, `validatedAt` | Run identity and timestamp; runs are not persisted yet |
| `rulebook` | `id`, `name`, `version`, recomputed `digest`, `digestVerified`, `specVersion`, `status` |
| `attestation` | Selected `name`, `attestationLoS`, `bindingType`, `supportedFormats` |
| `credential` | Non-sensitive facts only: `format`, `vct`, `disclosureCount`, `keyBindingPresent` |
| `schemaReferences` | Pinned reference URI/integrity, detected `kind`, whether it was `applied` |
| `dimensions` | The eight FR-010 dimensions, each with `status`, `applicable`, `executed`, `findings` and machine-readable `evidence` |
| `violations` | Flattened `error`/`warning` findings for clients |
| `limitations` | Explicit unexecuted or inconclusive checks, one entry per finding of a dimension that is not `PASS`/`FAIL` |
| `overallStatus` | D-8 aggregation of `dimensions` |

Findings carry a stable `code`, `severity`, `dimension`, optional JSON Pointer `path` and an
`expected` constraint. Type-metadata array elements use `*` as a wildcard segment. Claim
values and the raw credential artifact are never returned; `evidence.details` holds only
non-sensitive facts and explicit `false` flags for checks that did not run.

## 5. Statuses and aggregation

Statuses follow FR-012: `PASS`, `FAIL`, `NOT_TESTED`, `NOT_APPLICABLE`, `INCONCLUSIVE`.
Aggregation follows D-8:

- `FAIL` if any dimension fails;
- else `INCONCLUSIVE` if any dimension is inconclusive;
- else `NOT_TESTED` if any applicable dimension was not executed;
- else `PASS` only when every applicable dimension passed;
- `NOT_APPLICABLE` only when no dimension is applicable.

The dimension constructor enforces the matching per-dimension invariants before aggregation
(§2), so an unexecuted dimension cannot be `PASS` and cannot contribute a passing overall
result. Because cryptographic verification and issuer trust are applicable but not implemented
here, a structurally valid credential returns `overallStatus: "NOT_TESTED"` with structural
`PASS` dimensions. This is the intended result: a locally passing credential is not "fully
valid" or interoperable, and an overall `PASS` is not reachable in this slice (FR-012,
AC-16/AC-17).

## 6. Unsupported formats

The issuer-signed JWT must carry a `typ` header of `dc+sd-jwt` or `vc+sd-jwt`.
`dc+sd-jwt` is the only format with a structural parser. `mso_mdoc`, `jwt_vc_json`,
`jwt_vc_json-ld` and `ldp_vc` are recognised from an explicit `format` hint or from the TS11
baseline (`src/standards/profiles.ts`) and reported as recognised. Their parsing and schema
dimensions are `NOT_TESTED`; the attestation-constraints dimension is `INCONCLUSIVE` because
the rulebook-level checks ran but the credential-dependent key-binding check did not. A format
backed only by the caller hint and not confirmed by parsing is `INCONCLUSIVE`, not `PASS`. A
rulebook that does not list the credential format fails the attestation-constraints dimension.
No generic JSON validator is presented as mdoc or W3C VC support (FR-011).

## 7. Privacy, logging and limits

The engine never logs or persists the credential, disclosures or claim values. The HTTP
error handler logs only the method, path and error class. Results expose claim paths and
constraints, not values. Hard bounds are: 512 KiB credential, four schema documents of 128 KiB,
4 MiB body, 64-level schema/claim nesting, 1,000 disclosures, 4,096 credential claim nodes.
Schema documents are evaluated in a separate Bun worker process with a configurable hard
timeout (default 2 s), RSS limit (default 256 MiB), output cap (1 MiB) and concurrency cap
(two children). The RSS watchdog needs Linux `/proc`; on any other platform the sandbox fails
closed. The HTTP process never compiles or runs an untrusted schema itself; rulebook-driven
issuer fixture generation uses the same runner and shares its concurrency cap, so a busy
sandbox can also answer `503 fixture_unavailable` there (FR-013, `docs/fixtures.md` §2.4). In
validation, a limit hit produces `NOT_TESTED` evidence with `schema_evaluation_timeout`,
`schema_evaluation_memory_exceeded`, `schema_evaluation_output_exceeded`,
`schema_evaluation_failed`, `schema_sandbox_busy` or `schema_sandbox_unavailable`. Claim depth
is checked before and after disclosures are unpacked. Each JSON Schema document is compiled with a fresh Ajv instance so caller-supplied
`$id` state cannot leak between requests.

## 8. Verification

Tests execute the real pinned libraries and a real migrated SQLite registry:

- `src/validation/sd-jwt.test.ts` — real SD-JWT VC parsing, disclosure integrity, protected
  claims, unsupported hash algorithm, key-binding detection, `typ` header and claim-depth/
  disclosure-count bounds;
- `src/validation/schema.test.ts` — Type Metadata positive/negative attribute checks, JSON
  Schema positive/negative checks, SRI mismatch/unsupported algorithm/missing pin, rejection
  of catastrophic-regex, format, uniqueItems, legacy `dependencies` and `$ref` routes,
  unsupported dialects, unknown keywords and ambiguous `vct`/JSON Schema documents,
  unresolved Type Metadata `extends`, oversized credential claim sets, the sandbox timeout
  path and missing documents;
- `src/validation/dimensions.test.ts` — the eight-dimension catalogue, the exhaustive
  applicability table, table-driven status-semantics tests and rejection of every
  contradictory applicability/execution/status combination;
- `src/validation/non-conflation.test.ts` — the four spec §16 negative implications, plus a
  table-driven proof across valid, invalid-signature, missing-claim, unsupported-format and
  unrecognized inputs that no unexecuted dimension or overall result is `PASS`;
- `src/validation/engine.test.ts` — pinned version/digest evidence, dimension statuses,
  applicability/execution flags, evidence details, limitations, unsupported formats, key
  binding, digest-tamper abort, version pinning;
- `src/validation/schema-dimension.test.ts` — an unverifiable integrity pin with nothing
  applied is `NOT_TESTED`/unexecuted (also end to end), partial application stays executed
  `INCONCLUSIVE`, and a non-applied `FAIL` remains an executed conclusion;
- `src/validation/schema-sandbox.test.ts` — real-child timeout, memory, output, busy,
  unavailable, malformed-output and mixed integrity/timeout behaviour;
- `src/app.validation.test.ts` — typed HTTP contract with `applicable`/`executed`/`evidence`
  and `limitations` fields, 400/404/413/503 cases, an invalid signature over HTTP that is
  not overall success, /health responsiveness during a hostile sandbox run, and no credential
  or claim values in responses or logs;
- `src/config.test.ts` — `DATABASE_PATH` configuration.

## 9. Non-claims and next slices

This slice does not verify signatures, keys, certificates, status lists or trust anchors, and
does not claim TS11, ETSI, OpenID4VCI or interoperability conformance. Issue #33 reports the
exhaustive applicability, status semantics and non-conflation evidence; it does not implement
cryptographic verification, trust resolution or protocol execution. Issue #30 owns the safe
remote schema/import fetch that will replace caller-supplied documents; issue #34 owns the
versioned REST/OpenAPI surface and validation persistence. FR-010 allows external adapters or
test orchestration to supply other dimensions, but this slice accepts no external dimension
evidence: caller-supplied dimension results are ignored, so an untested dimension cannot be
made to PASS. The FR-021 comparison slice ([`docs/headless-wallet-comparison.md`](headless-wallet-comparison.md))
accepts a caller-supplied external wallet observation in a *separate* report; it never feeds
that observation into this engine, never changes an AttestBook dimension status and never
derives an overall validation PASS from it. Validation options (FR-009) are not accepted yet,
draft versions are publicly
readable by design (writes are authenticated and provider-scoped; see
[`docs/security.md`](security.md)), and a supplied schema document that
belongs to the attestation but not to the credential's format is ignored rather than reported.

A `vct#integrity` claim on the credential is not compared with the supplied Type Metadata in
this slice; only the rulebook reference `#integrity` is verified. That is part of the
`CRYPTO (integrity)` dimension and remains `NOT_TESTED`.
