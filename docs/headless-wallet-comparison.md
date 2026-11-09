# Headless-wallet comparison evidence

**Status:** Phase 5 implementation for
[issue #50](https://github.com/ForkbombEu/credimi-attestbook/issues/50) (specification
FR-021). It provides AttestBook-side validation inputs and results suitable for comparing a
headless-wallet credential capture with an external wallet's observed behaviour. It does
**not** orchestrate a wallet, start a Credimi test execution or verify an external
observation.

**Authoritative spec:** [`docs/specification.md`](specification.md) §12 (FR-021) and §11
(FR-019).
**Requirements:** [`docs/requirements.md`](requirements.md) FR-021.
**API contract:** [`docs/api.md`](api.md) §3.9.
**Structural validation evidence:** [`docs/validation.md`](validation.md).
**Capture evidence and correlation:** [`docs/capture.md`](capture.md) §9.
**Credimi adapter:** [`docs/credimi-integration.md`](credimi-integration.md).
**Traceability:** [`docs/traceability.md`](traceability.md).

## 1. Scope and boundaries

FR-021 describes a comparison between two things that are not the same measurement:

1. AttestBook validates the headless wallet's captured credential against one pinned rulebook
   version (`POST /api/v1/captures/{captureId}/validate`, FR-019/FR-020).
2. Credimi observes the external wallet's protocol and interoperability behaviour.
3. Credimi reports structural, protocol and interoperability failures separately.

This slice implements step 1 and provides the structured seam for step 2. It never performs
step 3 as a verdict and never acts as the orchestration platform:

- AttestBook does not start, schedule or observe a wallet, a Credimi execution or an
  interoperability test. `POST /api/v1/captures/{captureId}/compare` is a read-only
  projection over the correlation AttestBook already recorded.
- The AttestBook side is the structural and schema evidence from the real validation engine.
  The protocol, interoperability, cryptographic and trust dimensions are not executed here
  and are never reported `PASS` by AttestBook.
- The external wallet observation is caller-supplied and untrusted. AttestBook records it
  as bounded input, labels it `external`, bounds it and never verifies it, signs it or turns
  it into an AttestBook validation status.
- The comparison is not an interoperability verdict. It separates the two evidence sources
  and lists every dimension it cannot establish instead of omitting it.

The implementation is the pure module `src/comparison/` (`types.ts`, `compare.ts`,
`input.ts`) plus the `/api/v1/captures/{captureId}/compare` route and the Credimi adapter's
`compareCapture` method.

## 2. The comparison report

The report is `attestbook.headless-wallet-comparison@1`. It is JSON-serializable and carries
no raw artifact, disclosure, claim value or key material.

| Member | Meaning |
| --- | --- |
| `kind`, `contractVersion` | Contract marker and version (`1`). |
| `comparedAt` | AttestBook timestamp of the report, RFC 3339 UTC. |
| `rulebook` | The exact pinned version the capture was validated against: `rulebookId`, `rulebookName`, `version`, `contentDigest`, `digestVerified`, `specVersion`, `rulebookStatus`, `attestationType` and `boundAt`. |
| `capture` | `captureId`, `correlationId`, `testExecutionRef`, `sourceComponent`, `protocol` and `credentialFormat`, preserved from the capture envelope. |
| `attestbook` | `validationId`, `validatedAt`, `overallStatus`, the non-sensitive `credential` facts, the `schemaReferences` and whether each was applied, the structured `violations` and the explicit `limitations` of the validation run. |
| `externalWallet` | The caller-supplied observation, or `null` when none was supplied. |
| `comparison.schema` | The four AttestBook-executable dimensions: `credential_parsing`, `format_recognition`, `schema_validation`, `attestation_constraints`. |
| `comparison.protocol` | `protocol_conformance`, supplied only by the external observation. |
| `comparison.interoperability` | `interoperability`, supplied only by the external observation. |
| `comparison.trust` | `cryptographic_verification` and `issuer_trust`, supplied only by the external observation. |
| `comparison.unsupported` | Every dimension the comparison cannot establish, with a stable `code`, the AttestBook status (when one exists) and a reason. |
| `nonClaims` | Explicit `false` values for external-observation verification and the four AttestBook-unexecuted dimensions. |
| `limitations` | Static and dynamic limitations, including the mock-backed capture boundary. |

Every dimension entry reports `attestbook`, `external` and one `result`:

| `result` | Meaning |
| --- | --- |
| `agreement` | Both sources supplied a conclusive `PASS`/`FAIL` for the same dimension and they match. |
| `divergence` | Both supplied a conclusive result and they differ. |
| `attestbook_only` | Only AttestBook executed the dimension. |
| `external_only` | Only the caller's observation exists. |
| `not_provided` | Neither source supplied evidence. |
| `not_comparable` | Both supplied a value, but at least one is `NOT_TESTED`, `NOT_APPLICABLE` or `INCONCLUSIVE`, or AttestBook did not execute the dimension. |

A `divergence` is evidence for Credimi's report, not an AttestBook failure: the external
value is not AttestBook's status. The report never merges the two streams.

## 3. External wallet observation

The request body of `POST /api/v1/captures/{captureId}/compare` may carry:

```json
{
  "externalWallet": {
    "walletId": "wallet-a",
    "observedAt": "2026-11-05T09:48:30Z",
    "interaction": "issuance",
    "observations": [
      { "dimension": "cryptographic_verification", "status": "PASS", "code": "signature-valid", "detail": "Wallet A verified the issuer signature." },
      { "dimension": "issuer_trust", "status": "NOT_TESTED" },
      { "dimension": "protocol_conformance", "status": "PASS", "code": "issuance-flow-complete" },
      { "dimension": "interoperability", "status": "FAIL", "code": "claim-not-presented", "detail": "Wallet A did not present the family_name claim." }
    ]
  }
}
```

The body is bounded before interpretation:

- `walletId` is an opaque printable-ASCII identifier without whitespace, at most 200
  characters; it is trimmed, bounded and never resolved.
- `observedAt` is an RFC 3339 timestamp with an explicit offset, trimmed and preserved.
- `interaction` is `issuance`, `presentation` or `both`.
- `observations` holds 1–8 entries over distinct FR-010 dimensions. Each entry has a `status`
  in the FR-010 status set and optional `code` (≤ 120 characters) and `detail` (≤ 500
  characters). A repeated dimension is rejected; nothing is silently appended.
- A malformed body is `400 invalid_request` with a safe message. The observation is never
  echoed in an error.

The observation is optional. Without it, the report still carries the AttestBook structural
evidence and lists the protocol, interoperability, cryptographic and trust dimensions as
unsupported or not provided.

## 4. Exact pin linkage

The AttestBook side is never resolved from "the latest version". The comparison reads the
correlation recorded by `POST /api/v1/captures/{captureId}/validate`, which binds the capture
to the exact `rulebookId`, `version`, `contentDigest`, `specVersion`, `attestationType` and
`boundAt`. The report carries that same binding.

A capture that has no recorded correlation answers `409 conflict` and names the missing step;
the comparison never validates a second time against different bytes. The Credimi adapter's
`compareCapture` additionally verifies the returned `rulebook` against its `CredimiRulebookPin`
and raises `pin_mismatch` on a changed identifier, version, digest or attestation type. A
stale pin therefore becomes a typed failure before Credimi uses the evidence.

## 5. Unsupported comparison dimensions

Every dimension AttestBook does not execute is explicit in `comparison.unsupported`:

- `cryptographic_verification`, `issuer_trust`, `protocol_conformance` and `interoperability`
  are reported with `code: "attestbook_does_not_execute"`. Their reason states whether an
  external observation was supplied and that AttestBook does not verify it. They are never
  `PASS` and never contribute to the AttestBook `overallStatus`.
- A structural dimension that neither the validation nor the observation supplied is
  `no_evidence_supplied`.
- A dimension where both supplied a value but the values are not comparable is
  `not_comparable`.

`nonClaims` fixes the four AttestBook-unexecuted dimensions and the unverified external
observation to `false`. The report has no aggregated `PASS`: a structural PASS cannot become
a protocol or interoperability conclusion (FR-010, FR-012).

## 6. API and Credimi adapter

`POST /api/v1/captures/{captureId}/compare` is a public, read-only operation. It answers
`404` for an unknown capture, `409` for an uncorrelated capture, `400` for a malformed body,
`503` when the capture explorer is not wired and `502` when a capture source fails. It
persists nothing and never fetches an external artifact reference.

The standalone adapter in `src/integration/credimi/` exposes
`compareCapture({ captureId, pin, externalWallet? })`. It sends the observation through the
public API, parses the response with the API's own Zod schema, verifies the pin and returns
the typed report. It still has no Credimi runtime dependency and no database access.

## 7. Tests

The feature is covered by fixture-driven tests:

- `src/comparison/compare.test.ts` — exact pin linkage, the four comparison groups,
  agreement/divergence/not-comparable/not-provided results, the unsupported list, the
  non-conflation invariant (an external `PASS` never changes an AttestBook status), the
  bounded non-sensitive evidence and deterministic output for a fixed clock.
- `src/comparison/input.test.ts` — every bound and rejection of the observation parser.
- `src/api/comparison.test.ts` — a real migrated SQLite registry, the real structural engine,
  a genuinely signed SD-JWT VC and the mock-backed capture explorer: correlate, compare,
  schema validation of the response, exact digest linkage, group separation, unsupported
  dimensions, `404`/`409`/`400`/`503` cases, no credential disclosure and a read-only
  correlation.
- `src/integration/credimi/client.test.ts` and `server.test.ts` — the adapter request shape,
  the empty-observation body, pin verification and the real-socket comparison round trip.
- `src/api/openapi.test.ts` — the generated OpenAPI document includes the new operation and
  components.
- `ui` has no view for this report: the comparison is a machine-readable integration artifact
  for Credimi, not a user-facing screen.

## 8. Limitations and non-claims

- No wallet, Credimi execution or interoperability test is orchestrated, scheduled or
  observed. AttestBook validates a submitted credential and records a caller-supplied
  observation.
- The external observation is not authenticated, signed or verified. It is bounded input, not
  trusted evidence. A caller must not treat it as a trusted external measurement.
- Capture evidence remains mock-backed and in memory for the server process. No live
  `capture-issuer`/`capture-verifier` connector is integrated and the comparison is not
  persisted.
- The AttestBook side is structural only. Cryptographic verification, issuer trust, protocol
  conformance and interoperability are not executed and are never claimed passed.
- The comparison does not diff two credentials or two rulebook versions. It places the
  AttestBook structural evidence of one pinned capture next to one external wallet
  observation.
- A future continuous-conformance slice ([issue #51](https://github.com/ForkbombEu/credimi-attestbook/issues/51))
  owns recurring execution and stable run history. This slice does not persist runs.
