# Reproducible continuous conformance results

**Status:** Phase 5 implementation for
[issue #51](https://github.com/ForkbombEu/credimi-attestbook/issues/51) (specification
FR-022). It provides a stable result reference and machine-readable structural evidence for
recurring rulebook validation, driven by external orchestration. AttestBook does **not**
schedule, start or observe a recurring execution and does **not** turn a structural result
into a standards, cryptographic, trust, protocol or interoperability verdict.

**Authoritative spec:** [`docs/specification.md`](specification.md) §12 (FR-022).
**Requirements:** [`docs/requirements.md`](requirements.md) FR-022.
**API contract:** [`docs/api.md`](api.md) §3.10.
**Structural validation evidence:** [`docs/validation.md`](validation.md).
**Credimi adapter:** [`docs/credimi-integration.md`](credimi-integration.md).
**Traceability:** [`docs/traceability.md`](traceability.md).

## 1. Scope and boundaries

FR-022 asks for reproducible, deterministic validation suitable for automated execution, with
machine-readable outputs, stable error classifications and explicit version references.
Credimi (or another orchestrator) owns recurrence and run history. This slice provides the
AttestBook side:

- one request runs the same structural validation as
  `POST /api/v1/credentials/validate` against one exact pinned rulebook version;
- the response is an `attestbook.conformance-result@1` with an input digest, a
  content-addressed result reference, stable failure classes and the pinned
  rulebook/version/digest/specification/attestation type;
- repeating the same pinned run yields the same reference, so an orchestrator can store it
  and detect a later change;
- a changed credential, schema document, rulebook snapshot or structural evidence yields a
  different reference.

The implementation is the pure module `src/conformance/` plus
`POST /api/v1/conformance/runs` and the Credimi adapter's `runConformance` method. It adds no
scheduler, queue, worker or Credimi runtime dependency:

- AttestBook does not start, schedule or observe a Credimi test execution, a wallet or an
  interoperability test.
- The endpoint is read-only: it persists no run, writes no correlation and returns no
  server-generated result identifier that would need retention.
- The orchestrator supplies the pin and the credential on every run; AttestBook never
  resolves "the latest version" and never changes a rulebook snapshot.

## 2. The run request

`POST /api/v1/conformance/runs` accepts the same bounded body as credential validation:

```json
{
  "rulebookId": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "rulebookVersion": "1.0",
  "attestationType": "PID",
  "credential": "<compact SD-JWT VC>",
  "schemaDocuments": [
    { "uri": "https://example.org/schemas/pid.json", "content": "{ ... }" }
  ]
}
```

The `rulebookVersion` names the exact label; there is no range and no implicit upgrade.
`schemaDocuments` is optional, and each supplied document must still match the corresponding
pinned reference URI and its `sha256` SRI value before it is applied. The engine recomputes
the version snapshot digest and aborts on a mismatch, so a result is always tied to the bytes
it reports.

The request is bounded and rejected before interpretation: a malformed body is
`400 invalid_request`, an unknown rulebook/version/attestation type is `404 not_found`, an
oversized body is `413 payload_too_large`, and an unwired validation service is
`503 validation_unavailable`.

## 3. The result

The response is `{ "data": <attestbook.conformance-result@1> }`:

| Member | Meaning |
| --- | --- |
| `kind`, `contractVersion` | Contract marker and version (`1`). |
| `resultReference` | Lowercase hex SHA-256 of the canonical reference payload. Stable for the same pinned inputs and evidence when `deterministic` is `true`. |
| `deterministic` | `true` only when no runtime condition cut the run short; otherwise `false`, and the result must be retried before it is compared with an earlier run. |
| `environmentConditions` | Distinct sorted finding codes that show a runtime condition cut the run short, for example `schema_sandbox_busy`, `schema_sandbox_unavailable`, `schema_evaluation_timeout`, `schema_evaluation_memory_exceeded`, `schema_evaluation_output_exceeded` or `schema_evaluation_failed`. Empty for a deterministic run. |
| `pin` | `rulebookId`, `version`, `contentDigest`, `specVersion`, `attestationType` and `digestVerified: true`. |
| `input` | `credentialDigest`, the optional `credentialFormatHint`, the supplied `schemaDocuments` (`uri` + `contentDigest`, sorted by URI in UTF-16 code-unit order, locale-independent) and an `inputDigest`. No raw credential or schema document is returned. |
| `outcome` | One of `structural_pass`, `structural_fail`, `inconclusive`, `evidence_incomplete`, `not_applicable`. A run with an environment condition is `structural_fail` when the structural aggregate is `FAIL`, otherwise `inconclusive`. |
| `failureClasses` | Stable failure classes for failed dimensions, each with its dimension and distinct `error` finding codes (sorted). |
| `evidence` | `overallStatus`, the non-sensitive credential facts, the attestation evidence, schema references, the eight `dimensions` with their findings and evidence, flattened `violations` and explicit `limitations`. |
| `references` | Canonicalization (`attestbook.stable-json@1`), digest algorithm (`sha256`), reference scope, the FR-012 status taxonomy and the `engine` build versions (AttestBook package and the pinned OWF schema package), which are outside the reference payload. |
| `nonClaims` | Explicit `false` values for cryptographic verification, issuer trust, protocol conformance, interoperability, standards conformance and scheduled recurrence. |
| `limitations` | Static limitations of the result. |

`evidence` is the structural validation projection; it deliberately omits the validation
identifier, the validation timestamp and mutable registry metadata (rulebook name and
publication status), because none of those is part of the pinned input or the structural
evidence.

## 4. Determinism and stable references

`inputDigest` is SHA-256 over the canonical JSON of:

```
{ format: "attestbook.conformance-input@1",
  pin: { rulebookId, version, contentDigest, specVersion, attestationType },
  credentialDigest, credentialFormatHint,
  schemaDocuments: [{ uri, contentDigest }] }
```

The supplied `schemaDocuments` are sorted by URI in UTF-16 code-unit order
(locale-independent) before digesting, because the engine matches them by URI and rejects
duplicate URIs; a different request order therefore does not change the input identity. The
ordering uses the same comparator as the canonical object-key ordering, never
`localeCompare`, so a server or verifier under a different locale/ICU build computes the same
digest.

`resultReference` is SHA-256 over the canonical JSON of:

```
{ format: "attestbook.conformance-reference@1",
  contractVersion: 1, pin, input: <the input object>,
  deterministic, environmentConditions,
  outcome, evidence, failureClasses }
```

Canonicalization sorts object keys recursively; array order stays significant except where a
field is documented as sorted. The result reference therefore changes when:

- the pinned rulebook identifier, version, snapshot digest, specification version or
  attestation type changes;
- the exact credential bytes, the explicit format hint or a supplied schema document changes;
- the structural evidence changes (a dimension status, a finding, an evidence detail or a
  limitation), even when the input is identical;
- a runtime condition cut the run short and therefore changed `environmentConditions`.

It does **not** change when only the validation identifier, the validation timestamp, the
rulebook's mutable name/publication status, the static limitation prose or the non-claim
constants change. When `deterministic` is `true`, `POST /api/v1/conformance/runs` is
idempotent and side-effect free: the same pinned request returns the same `resultReference`
and the same `inputDigest`.

A run with `deterministic: false` was cut short by the environment (for example a schema
sandbox at its concurrency limit or unavailable on the platform). It still reports the
evidence it produced, but its reference must **not** be compared with an earlier run as
drift: retry the same pinned request until a deterministic result is returned. A concurrent
load on the public validation routes can cause such a condition, so an orchestrator must
treat it as a retryable runtime limitation rather than a rulebook change.

A reference is a stable identifier, not a stored resource. External orchestration keeps it
with its own run history; AttestBook does not turn conformance results into a second
execution history or idempotency store.

## 5. Failure classification

`outcome` maps the conservative FR-012 aggregate status to a structural outcome:
`PASS` → `structural_pass`, `FAIL` → `structural_fail`, `INCONCLUSIVE` → `inconclusive`,
`NOT_TESTED` → `evidence_incomplete`, `NOT_APPLICABLE` → `not_applicable`. In this
structural-only build a `structural_pass` is not reachable, because cryptography and issuer
trust are required and not executed; the honest aggregate is `evidence_incomplete`.

When `environmentConditions` is non-empty the run was cut short, so the outcome is
`structural_fail` only when the structural aggregate is `FAIL`; every other environment
condition is reported as `inconclusive`, never as a pass or a clean `evidence_incomplete`
result.

Each failed dimension contributes one `failureClasses` entry:

| Dimension | Stable class |
| --- | --- |
| `credential_parsing` | `credential_unparseable` |
| `format_recognition` | `format_unrecognized` |
| `schema_validation` | `schema_violation` |
| `attestation_constraints` | `attestation_constraint_violation` |
| any other failed dimension | `dimension_failure` |

`findingCodes` lists the distinct `error`-severity finding codes of that dimension, sorted, so
a consumer can classify a failure without depending on message wording. A dimension that is
`NOT_TESTED`, `NOT_APPLICABLE` or `INCONCLUSIVE` is not a failure class; it is reported in
`evidence.dimensions` and in `evidence.limitations` (for example `signature_not_verified` or
`trust_not_evaluated`).

## 6. Version references and non-claims

The result names the exact pinned rulebook version and snapshot digest, the specification
version (`specVersion`), the attestation type and the conformance contract version. The
validation engine's evidence additionally names the scope, reason and structured details of
every dimension.

- A structural `FAIL` is a structural failure of the pinned run, not an ETSI, TS11 or
  interoperability non-conformance finding.
- Cryptographic signature verification, issuer trust, protocol conformance and
  interoperability are still not executed; `nonClaims` fixes them to `false` and the
  dimensions remain `NOT_TESTED`/`NOT_APPLICABLE`.
- No recurring execution is scheduled. `nonClaims.recurringExecutionScheduled` is always
  `false`.

## 7. API and Credimi adapter

`POST /api/v1/conformance/runs` is a public, read-only operation (it is a `POST` because it
carries the credential). It is documented in the generated OpenAPI 3.1 contract and in
[`docs/api.md`](api.md) §3.10.

The standalone adapter in `src/integration/credimi/` exposes
`runConformance({ pin, credential, schemaDocuments? })`. It sends the pinned request over the
public API, parses the response with the API's Zod schema, rejects a result that does not
name the pinned rulebook/version/digest/specification/attestation type with `pin_mismatch`,
and rejects a result whose input digest names a different credential, format hint or schema
documents with `invalid_response`. The adapter normalizes an explicit format hint and schema
URIs the same way the server does (`trim()`) and compares the schema documents by URI and
digest, not by request order. It still has no Credimi runtime dependency and no database
access.

## 8. Tests

- `src/conformance/result.test.ts` — identical results across repeated runs and across
  validation identifiers/timestamps/lifecycle metadata; reference changes on credential,
  schema-document or evidence changes; code-unit schema-document order independence; the
  documented input-digest and result-reference formulas recomputed from a result; every
  outcome mapping; every failure class; a sandbox runtime condition reported as
  non-deterministic; explicit pin, references/engine versions and non-claims; no credential or
  schema-document text in the result; refusal of evidence that does not name the requested
  pin.
- `src/api/conformance.test.ts` — the real Hono application, a real migrated SQLite registry
  and the real structural engine with a genuinely signed SD-JWT VC: two byte-identical runs,
  changed-input references, a real `FAIL` classification (`missing_key_binding`), a
  non-Linux sandbox reported as `deterministic: false` with
  `environmentConditions: ["schema_sandbox_unavailable"]`, `404`/`400`/`503` cases,
  response-schema validation and non-disclosure of the credential.
- `src/integration/credimi/client.test.ts` and `server.test.ts` — the adapter request shape,
  pin and input verification including trimmed format/URI normalization and mismatched
  format/document rejection, a malformed response and a real-socket repeated run.
- `src/api/openapi.test.ts` — the generated document includes the new operation and
  components and still matches the registered routes.

## 9. Limitations and non-claims

- No scheduler, queue or recurrence engine is implemented: external orchestration must call
  the endpoint on its own schedule.
- A run can be cut short by a runtime condition (a busy or unavailable schema sandbox, a
  timeout, a memory or output cap). Such a result carries `deterministic: false` and the
  identifying `environmentConditions`; retry it and do not compare its reference with an
  earlier run as drift.
- No conformance run is persisted. The stable reference is content-addressed and can be
  recomputed from the pinned input; there is no server-side run history to browse.
- The result is structural only. Cryptographic verification, issuer trust, protocol
  conformance and interoperability are not executed and are never inferred.
- A changed validation engine or data set can change the evidence and therefore the result
  reference for the same input; this is intentional and is why the reference is
  content-addressed over the evidence. `references.engine` names the AttestBook package
  version and the pinned OWF schema package version outside the reference payload, so an
  orchestrator can tell an engine upgrade from input drift.
- Capture evidence remains mock-backed and in memory for the server process; continuous
  conformance runs against captured artifacts are not persisted and no live capture
  component is integrated.
