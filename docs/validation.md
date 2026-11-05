# Credential validation: SD-JWT VC structural evidence

**Status:** Phase 1 implementation for
[issue #32](https://github.com/ForkbombEu/credimi-attestbook/issues/32). This document
describes the checks that actually run, the typed API and the evidence it returns. It makes
no cryptographic, trust, protocol, interoperability or standards-conformance claim.

**Authoritative spec:** [`docs/specification.md`](specification.md) FR-009–FR-012 and §13.
**Architecture:** [`docs/architecture.md`](architecture.md) §8 (dimension status model) and
§11 (security outline). **Decisions:** [`docs/implementation-plan.md`](implementation-plan.md)
D-6 (exact-byte digest), D-8 (conservative aggregation), D-9 (vocabulary, not issuer
enforcement), D-14 (SD-JWT VC + Ajv) and D-17 (structural scope only).
**Evidence model:** [`docs/traceability.md`](traceability.md). **Pinned version reads:**
[`docs/registry.md`](registry.md). **Real libraries:** [`docs/standards-adapter.md`](standards-adapter.md).

## 1. What the engine executes

`POST /api/credentials/validate` validates one credential artifact against one **immutable,
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
7. returns per-dimension statuses, structured findings with JSON Pointer paths, and the
   pinned rulebook version and digest.

The following are **not** executed and never reported PASS: signature verification,
key-binding proof verification, status-list checks, issuer trust, protocol conformance and
end-to-end interoperability (FR-010, FR-012, D-17).

## 2. Why schema documents are supplied by the caller

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
  classification would skip constraints. JSON Schema evaluation is bounded to 2,000 schema
  nodes and 1,000,000 schema-node × claim-node units, and Ajv stops at the first violation.

A reference with no supplied document makes schema validation `NOT_TESTED`. Supplying an
unrelated schema cannot widen validation silently.

## 3. Typed contract

```http
POST /api/credentials/validate
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

The response includes:

| Field | Meaning |
| --- | --- |
| `validationId`, `validatedAt` | Run identity and timestamp; runs are not persisted yet |
| `rulebook` | `id`, `name`, `version`, recomputed `digest`, `digestVerified`, `specVersion`, `status` |
| `attestation` | Selected `name`, `attestationLoS`, `bindingType`, `supportedFormats` |
| `credential` | Non-sensitive facts only: `format`, `vct`, `disclosureCount`, `keyBindingPresent` |
| `schemaReferences` | Pinned reference URI/integrity, detected `kind`, whether it was `applied` |
| `dimensions` | The eight FR-010 dimensions, each with a status and findings |
| `violations` | Flattened `error`/`warning` findings for clients |
| `overallStatus` | D-8 aggregation of `dimensions` |

Findings carry a stable `code`, `severity`, `dimension`, optional JSON Pointer `path` and an
`expected` constraint. Type-metadata array elements use `*` as a wildcard segment. Claim
values and the raw credential artifact are never returned.

## 4. Statuses and aggregation

Statuses follow FR-012: `PASS`, `FAIL`, `NOT_TESTED`, `NOT_APPLICABLE`, `INCONCLUSIVE`.
Aggregation follows D-8:

- `FAIL` if any dimension fails;
- else `INCONCLUSIVE` if any dimension is inconclusive;
- else `NOT_TESTED` if any applicable dimension was not executed;
- else `PASS` only when every applicable dimension passed;
- `NOT_APPLICABLE` only when no dimension is applicable.

Because cryptographic verification and issuer trust are applicable but not implemented here,
a structurally valid credential returns `overallStatus: "NOT_TESTED"` with structural `PASS`
dimensions. This is the intended result: a locally passing credential is not "fully valid" or
interoperable (FR-012, AC-16/AC-17).

## 5. Unsupported formats

The issuer-signed JWT must carry a `typ` header of `dc+sd-jwt` or `vc+sd-jwt`.
`dc+sd-jwt` is the only format with a structural parser. `mso_mdoc`, `jwt_vc_json`,
`jwt_vc_json-ld` and `ldp_vc` are recognised from an explicit `format` hint or from the TS11
baseline (`src/standards/profiles.ts`), reported as recognised, and their parsing/schema/
attestation dimensions are `NOT_TESTED`. A format backed only by the caller hint and not
confirmed by parsing is `INCONCLUSIVE`, not `PASS`. A rulebook that does not list the
credential format fails the attestation-constraints dimension. No generic JSON validator is
presented as mdoc or W3C VC support (FR-011).

## 6. Privacy, logging and limits

The engine never logs or persists the credential, disclosures or claim values. The HTTP
error handler logs only the method, path and error class. Results expose claim paths and
constraints, not values. Hard bounds are: 512 KiB credential, four schema documents of 128 KiB,
4 MiB body, 64-level schema/claim nesting, 1,000 disclosures, 4,096 credential claim nodes,
512 Type Metadata claims with 32-segment paths, 20,000,000 units of Type Metadata work, 2,000
JSON Schema nodes, 1,000,000 schema × claim units and one rendered JSON Schema violation per
document. Claim depth is checked before and after disclosures are unpacked. Each JSON Schema document is compiled with a fresh Ajv instance so caller-supplied
`$id` state cannot leak between requests.

## 7. Verification

Tests execute the real pinned libraries and a real migrated SQLite registry:

- `src/validation/sd-jwt.test.ts` — real SD-JWT VC parsing, disclosure integrity, protected
  claims, unsupported hash algorithm, key-binding detection, `typ` header and claim-depth/
  disclosure-count bounds;
- `src/validation/schema.test.ts` — Type Metadata positive/negative attribute checks, JSON
  Schema positive/negative checks, SRI mismatch/unsupported algorithm/missing pin, rejection
  of catastrophic-regex, format, uniqueItems, legacy `dependencies` and `$ref` routes,
  unsupported dialects, unknown keywords and ambiguous `vct`/JSON Schema documents,
  unresolved Type Metadata `extends`, oversized Type Metadata and credential claim sets,
  missing documents;
- `src/validation/engine.test.ts` — pinned version/digest evidence, dimension statuses,
  unsupported formats, key binding, digest-tamper abort, version pinning;
- `src/app.validation.test.ts` — typed HTTP contract, 400/404/413/503 cases, no credential or
  claim values in responses or logs;
- `src/config.test.ts` — `DATABASE_PATH` configuration.

## 8. Non-claims and next slices

This slice does not verify signatures, keys, certificates, status lists or trust anchors, and
does not claim TS11, ETSI, OpenID4VCI or interoperability conformance. Issue #33 owns the
exhaustive dimension-applicability and non-conflation evidence; issue #30 owns the safe
remote schema/import fetch that will replace caller-supplied documents; issue #34 owns the
versioned REST/OpenAPI surface and validation persistence. Validation options (FR-009) are
not accepted yet, draft versions are publicly readable and authorization for them belongs to
#35, and a supplied schema document that belongs to the attestation but not to the credential's
format is ignored rather than reported.

A `vct#integrity` claim on the credential is not compared with the supplied Type Metadata in
this slice; only the rulebook reference `#integrity` is verified. That is part of the
`CRYPTO (integrity)` dimension and remains `NOT_TESTED`.
