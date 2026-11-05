# AttestBook — Capture Integration Contracts (Phase 0, proposed)

**Status:** Phase 0 research draft — **explicitly proposed**, not implemented, not a TS11
normative structure, and not an operational claim about `capture-issuer` or
`capture-verifier`. These contracts are designed early (spec §11) so the validation engine
and registry can later consume capture evidence **without a redesign**, but nothing here
declares an integration to be working.

**Ticket:** [#4 — Design standalone architecture, data model and capture contracts](https://github.com/ForkbombEu/credimi-attestbook/issues/4)
**Companion:** [`docs/architecture.md`](architecture.md) (modules, validation engine, security outline)
**Authoritative spec:** [`docs/specification.md`](specification.md) §11 (FR-015 … FR-019)

## 1. Purpose and scope

`capture-issuer` and `capture-verifier` are intended to provide observable evidence of real
credential issuance and presentation interactions (spec §11.1). AttestBook must be able to
**consume** that evidence, normalize it, and evaluate it against a pinned rulebook — without
owning the capture runtime, issuing/verifying credentials itself, or introducing speculative
infrastructure.

This document defines:

1. a normalized **capture artifact envelope** (FR-015);
2. the logical **contracts** for ingestion and validation (FR-018);
3. a **redaction** model (FR-015/FR-016/FR-017, spec §15);
4. **correlation** rules (FR-019);
5. **push and pull** transport contracts;
6. a **mock adapter** strategy for integration testing.

Out of scope here (deferred until their runtime contracts are known): the actual wire
format, transport and responsibilities of `capture-issuer`/`capture-verifier`. Spec §11.1
requires those to be discovered from their real implementations or documented contracts
before any operational claim.

## 2. Design principles

1. **Capture layer and validation layer stay independent.** The capture layer normalizes
   evidence into an artifact; the validation engine consumes a normalized artifact. Neither
   depends on the other's internals (spec §11.1, AC-12).
2. **No speculative broker.** Pull-based retrieval and push-based submission are supported
   through a transport-agnostic adapter interface; no event broker is introduced for
   hypothetical future requirements (FR-018).
3. **Privacy and minimization by default.** Sensitive raw artifacts are separated from
   metadata; credentials/tokens/keys/personal attributes are never logged and are redactable
   (FR-015, spec §15).
4. **Honest capability.** Capture integration is designed but not claimed implemented until
   real components are integrated (AC-12, AC-13, AC-14 are roadmap, not Phase 0 status).

## 3. Normalized capture artifact envelope (proposed)

An internal, AttestBook-owned envelope — **not** a TS11 structure. Candidate fields per
FR-015, with "class" marking **Metadata** (safe to index/log) vs **Sensitive** (subject to
redaction/external storage):

| Field | Class | Notes |
| --- | --- | --- |
| `captureId` | Metadata | Stable capture identifier |
| `correlationId` | Metadata | Correlates issuer/verifier/test execution (FR-019) |
| `sourceComponent` | Metadata | `capture-issuer` \| `capture-verifier` \| other (extensible) |
| `capturedAt` | Metadata | Capture timestamp |
| `interactionType` | Metadata | e.g. `issuance`, `presentation`, `error` |
| `protocol` | Metadata | e.g. `openid4vci`, `openid4vp` |
| `credentialFormat` | Metadata | e.g. `dc+sd-jwt`, `mso_mdoc` (extensible enum, cf. architecture §4.2) |
| `artifactType` | Metadata | e.g. `issuer-metadata`, `credential-offer`, `issued-credential`, `presentation-request`, `presentation-submission`, `verification-outcome`, `error-response` |
| `artifactRef` | Metadata | Secure reference to externally stored artifact (preferred over embedding) |
| `artifact?` | Sensitive | Inline artifact, only when no external reference is possible |
| `issuerOrVerifier` | Metadata | Associated issuer/verifier identity |
| `testExecutionRef` | Metadata | Associated (Credimi) test execution |
| `redactionStatus` | Metadata | `none` \| `partial` \| `full` (+ `redactionPolicyRef`) |
| `integrity` | Metadata | Digest/SRI over the (unredacted) artifact and over the envelope metadata |
| `metadata` | Metadata | Extensible, non-sensitive |

Rules:

- Prefer `artifactRef` (external, secure) over `artifact` (inline) so credential contents
  are not embedded in every event (FR-015).
- `integrity` covers the raw artifact bytes so a redacted artifact can be verified against
  its original digest without retaining the original in the same store.
- Unknown fields are preserved (same lossless principle as the standards adapter).

## 4. Logical contracts (proposed names, not mandatory)

From FR-018; names are illustrative, not a frozen public API.

| Contract | Responsibility |
| --- | --- |
| `CaptureSource` | A configured origin of capture artifacts (component, transport, credentials, pull policy) |
| `CaptureImporter` | Acquire artifacts from a `CaptureSource` (pull) or receive pushed submissions (push) |
| `CaptureNormalizer` | Validate the envelope, verify integrity, apply redaction policy, produce a normalized artifact |
| `CaptureArtifact` | The normalized envelope (§3) |
| `CaptureValidationRequest` | Bind a normalized artifact to a rulebook version, attestation type and validation options |
| `CaptureValidationResult` | Validation findings correlated to the capture artifact (reuses `ValidationResult` from architecture §7/§8) |

The transport-specific integration is an **adapter** behind these contracts, so real
`capture-issuer`/`capture-verifier` connectors can be added later without touching the
validation engine (FR-018, AC-12).

## 5. Redaction model

Capture artifacts may contain sensitive credential data. Default policy:

1. **Do not log** raw credentials, tokens, private keys or personal attributes (spec §15).
2. **Separate** sensitive raw artifacts from metadata; store raw artifacts behind a
   secure reference (`artifactRef`) with access control.
3. **Redaction levels** recorded on the artifact: `none`, `partial`, `full`, with the policy
   that produced it. A redacted artifact must retain enough structure for format/type
   recognition and structural validation, while claims marked sensitive are removed or
   replaced with a placeholder that preserves the attribute **path** (so findings can still
   reference the attribute without exposing its value).
4. **Integrity over the original** is retained in `integrity`, so a consumer can confirm a
   redacted artifact corresponds to the original without seeing the original.
5. **Selective disclosure and encryption** (presentation flows, FR-017) mean captured
   presentation data may not expose all claims; the validator must treat absent
   claims as `NOT_TESTED` rather than as FAIL.

## 6. Correlation and traceability (FR-019)

AttestBook supports correlation among: rulebook version, credential artifact, issuance
interaction, verification interaction, capture source, (Credimi) test execution, and
validation results — **without owning the test orchestration lifecycle**.

- Use **stable identifiers and explicit references** (not positional/temporal coupling):
  `correlationId`, `captureId`, `testExecutionRef`, `rulebookVersion` + `contentDigest`.
- `CaptureValidationResult` carries back the `captureId`/`correlationId` so Credimi can join
  AttestBook findings with its own protocol/interoperability results (spec §11.2, §12).
- Correlation identifiers are opaque and provider-supplied where possible; AttestBook never
  rewrites a caller's correlation id.

## 7. Push and pull contracts

Both are supported (FR-018). They share the normalized envelope; only the transport and
trigger differ.

### 7.1 Pull (AttestBook retrieves)

- `CaptureImporter` polls or fetches a `CaptureSource` (e.g. an HTTP endpoint) on a schedule
  or on demand.
- Conditional fetching (ETag/Last-Modified) and idempotent ingestion by `captureId`
  (deduplication, no double-import).
- Retrieval is subject to the same SSRF/timeouts/size limits as catalog import
  (architecture §11, T1–T3).

### 7.2 Push (source submits)

- `POST /api/captures` accepts a normalized `CaptureArtifact`; response is the accepted
  `captureId` (idempotent on resubmission of the same `captureId`).
- `POST /api/captures/validate` (or an async job + result resource) runs
  `CaptureValidationRequest` → `CaptureValidationResult`.
- Pushed artifacts are validated as untrusted input before normalization.

### 7.3 Transport adapter interface (proposed)

```
CaptureSource   ──► CaptureImporter ──► CaptureNormalizer ──► Validation Engine
     ▲                                       │
     └── (http adapter | mock adapter | future capture-* connectors)
```

Only an HTTP adapter and a mock adapter are anticipated for Phase 4; real
`capture-issuer`/`capture-verifier` connectors are added when their contracts are available
(spec §11.4, "Then integrate actual capture components when their contracts are available").

## 8. Mock strategy

For integration testing **before** real capture components exist, a **mock capture adapter**
is provided, clearly identified as such (FR-018, UI-006, AC-13):

- `MockCaptureSource` emits deterministic fixture artifacts covering the artifact types in
  §3: issuer metadata, credential offer, issued credential, presentation request,
  presentation submission, verification outcome, error response.
- Fixtures are **vendored locally** with explicit "captured on `<timestamp>`, from `<source>`"
  provenance; no live capture endpoint is called in unit/CI tests (same offline principle as
  the catalog importer, [#3](https://github.com/ForkbombEu/credimi-attestbook/issues/3) §7).
- The mock exercises the **full pipeline** (import → normalize → redact → validate →
  correlate) but is labeled `mock` in every result so it is never mistaken for a real
  capture integration.
- Test matrix from spec §16 "Capture tests": valid artifact, missing artifact, malformed
  artifact, redacted artifact, unsupported protocol, correlation identifiers, mock
  capture-issuer input, mock capture-verifier input.

## 9. What is and is not claimed

- **Proposed and designed:** envelope, contracts, redaction, correlation, push/pull,
  mock strategy.
- **Not implemented, not claimed operational:** any real `capture-issuer` /
  `capture-verifier` integration, capture transport, or capture-backed validation. These
  remain Phase 4 work (spec §11.4) gated on the components' actual contracts.
- **Not a broker:** no message queue or event bus is part of this design.

## 10. Open decisions for approval

| ID | Decision | Source |
| --- | --- | --- |
| CD-1 | Exact `CaptureArtifact` field set and JSON Schema (the envelope in §3 is a candidate, not frozen) | FR-015 |
| CD-2 | Default redaction policy depth (which attributes are sensitive by default) and the placeholder representation | FR-015, spec §15 |
| CD-3 | Pull schedule vs on-demand only, and how a `CaptureSource` is authenticated | FR-018 |
| CD-4 | Whether push ingestion is synchronous or async-by-default | FR-018 |
| CD-5 | Correlation-id ownership convention with Credimi (who mints `correlationId`) | FR-019 |
| CD-6 | External artifact storage/access model (`artifactRef`) and its access-control boundary | FR-015 |

## 11. References

- [`docs/specification.md`](specification.md) §11, §15, §16 (capture tests)
- [`docs/architecture.md`](architecture.md) §3, §7, §8, §11
- Issue [#4](https://github.com/ForkbombEu/credimi-attestbook/issues/4), [#17](https://github.com/ForkbombEu/credimi-attestbook/issues/17) (Phase 4 roadmap)
