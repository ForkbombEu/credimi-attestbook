# Capture artifact envelope and normalization

**Status:** Phase 4 implementation of the capture-envelope slice by
[issue #46](https://github.com/ForkbombEu/credimi-attestbook/issues/46) (specification
FR-015 and FR-018). It defines the versioned AttestBook envelope, validates untrusted
submissions and produces a metadata-only artifact with the raw evidence segregated. It is
**not** a live `capture-issuer`/`capture-verifier` integration, and no capture component is
claimed operational.

**Authoritative spec:** [`docs/specification.md`](specification.md) §11 (FR-015, FR-018) and
§15 (security requirements)
**Requirements:** [`docs/requirements.md`](requirements.md) FR-015, FR-018; AC-12
**Related:** [`docs/capture-integration.md`](capture-integration.md) (Phase 0 contract
proposal), [`docs/architecture.md`](architecture.md) §3/§7/§8/§11,
[`docs/security.md`](security.md) (untrusted-input controls),
[`docs/traceability.md`](traceability.md)
**Implementation:** `src/capture/` (`types.ts`, `normalize.ts`, `reference.ts`,
`redaction.ts`, `json.ts`, `limits.ts`, `errors.ts`)

## 1. Scope and boundaries

Implemented by #46:

- a versioned, closed capture artifact envelope (`attestbook.capture-artifact@1`) with
  correlation, provenance, interaction, protocol, format, artifact-type, party, integrity,
  redaction and scalar metadata members;
- bounded parsing of an untrusted JSON submission (byte size, UTF-8, depth, node count,
  string length, `__proto__` defensiveness) before any member is interpreted;
- safe rejection of malformed, ambiguous and unsupported submissions with stable
  `CaptureError` codes and messages that never echo artifact bytes or identifiers;
- segregation of an inline raw artifact out of the metadata envelope into a distinct
  `sensitive` result that callers must not log or index;
- validation of secure external `artifactRef` URIs (default-port `https`, no credentials,
  no fragment, no loopback/private/link-local/metadata IP literals);
- SHA-256 integrity over the exact raw artifact bytes (recomputed and enforced for an inline
  artifact; declared but explicitly unverified for an external reference);
- verbatim preservation of the caller's capture timestamp and correlation identifiers, plus
  an AttestBook receipt timestamp;
- a default redaction policy for partial and full redaction of a JSON artifact, with
  path-preserving placeholders and explicit fallback to full redaction for opaque content.

Deliberately **not** in #46:

- any HTTP route, push/pull transport, mock adapter or real `capture-issuer`/
  `capture-verifier` connector — [#47](https://github.com/ForkbombEu/credimi-attestbook/issues/47);
- persistence or external artifact storage, and its access-control boundary (CD-6);
- fetching an `artifactRef`. No network request is made by this module. A future fetcher
  must reuse the import pipeline's URL validation, DNS resolution and pinned-address checks
  (`src/import/url.ts`), not resolve the reference itself;
- binding an artifact to a rulebook version or executing validation
  ([#48](https://github.com/ForkbombEu/credimi-attestbook/issues/48));
- signing, encrypting, decrypting or otherwise authenticating capture evidence; nothing here
  claims a capture artifact is authentic, complete or protocol-conformant;
- an operational capture integration. The envelope is an internal AttestBook contract, not a
  TS11 normative structure.

## 2. Envelope version 1

The complete accepted shape is defined by `src/capture/types.ts`. "Metadata" means safe to
index or log; "Sensitive" means raw evidence that is returned only in the segregated
`sensitive` field.

| Member | Class | Rules |
| --- | --- | --- |
| `kind` | Metadata | Required; exactly `attestbook.capture-artifact@1`. |
| `envelopeVersion` | Metadata | Required; exactly `1`; another value is `unsupported_envelope_version`. |
| `captureId` | Metadata | Required opaque printable ASCII identifier without whitespace, ≤ 200 characters. |
| `correlationId` | Metadata | Required, same identifier rules; preserved verbatim. |
| `sourceComponent` | Metadata | Required; `capture-issuer` or `capture-verifier`. |
| `sourceVersion` | Metadata | Optional version-like text, ≤ 64 characters. |
| `capturedAt` | Metadata | Required RFC 3339 timestamp with an explicit offset; preserved verbatim and parsed to Unix milliseconds. |
| `interactionType` | Metadata | Required; `issuance`, `presentation` or `error`. |
| `protocol` | Metadata | Required; `openid4vci` or `openid4vp`. |
| `credentialFormat` | Metadata | Required; one of the pinned TS11 formats. |
| `artifactType` | Metadata | Required; one of `issuer-metadata`, `credential-offer`, `issued-credential`, `presentation-request`, `presentation-submission`, `verification-outcome`, `error-response`. |
| `artifactRef` | Metadata | Optional, mutually exclusive with `artifact`; `{ uri, mediaType, byteLength? }`. |
| `artifact` | Sensitive | Optional, mutually exclusive with `artifactRef`; `{ mediaType, encoding?, content, byteLength? }`. Extracted to `sensitive`, never returned in the envelope. |
| `party` | Metadata | Optional `{ role, identifier, name? }`; `role` must match the source component. |
| `testExecutionRef` | Metadata | Optional opaque identifier for the associated Credimi execution. |
| `redaction` | Metadata | Optional `{ status, policyRef?, redactedPaths?, redactedDigest? }`; coherent with the artifact source. |
| `integrity` | Metadata | Required `{ algorithm: "sha256", digest }`, lowercase hex over the exact raw artifact bytes. |
| `metadata` | Metadata | Optional flat object of at most 32 string/number/boolean/null values. |

Exactly one of `artifactRef` and `artifact` is required. Supplying both is
`ambiguous_artifact_source`; supplying neither is `missing_artifact`. Unknown top-level or
nested members are rejected instead of being carried forward: forward compatibility is
expressed by `envelopeVersion`, not by silently accepting unvalidated members. Additional
non-sensitive facts belong in `metadata`.

```json
{
  "kind": "attestbook.capture-artifact@1",
  "envelopeVersion": 1,
  "captureId": "capture-issuer-0001",
  "correlationId": "credimi-execution-0001",
  "sourceComponent": "capture-issuer",
  "sourceVersion": "0.4.0",
  "capturedAt": "2026-11-05T09:48:23Z",
  "interactionType": "issuance",
  "protocol": "openid4vci",
  "credentialFormat": "dc+sd-jwt",
  "artifactType": "issued-credential",
  "artifactRef": {
    "uri": "https://artifacts.example.test/captures/credential-0001.json",
    "mediaType": "application/json"
  },
  "integrity": { "algorithm": "sha256", "digest": "<lowercase sha-256 hex>" },
  "party": { "role": "issuer", "identifier": "https://issuer.example.test" },
  "metadata": { "environment": "mock" }
}
```

## 3. Validation and rejection

`CaptureNormalizer` is the only entry point. `normalizeBytes` accepts a UTF-8 JSON
submission; `normalize` accepts an already-parsed value and applies the same JSON bounds.
The normalizer is synchronous, writes nothing and performs no network request.

| Code | Meaning |
| --- | --- |
| `invalid_json`, `json_limit`, `response_too_large` | Not UTF-8 JSON, empty, beyond a JSON bound, or over the envelope byte limit. |
| `invalid_capture` | Wrong member type/shape, unknown or missing member, malformed identifier, metadata or party. |
| `unsupported_envelope_version` | A version other than `1`. |
| `unsupported_source_component`, `unsupported_interaction_type`, `unsupported_protocol`, `unsupported_credential_format`, `unsupported_artifact_type` | Value outside the version 1 closed enumeration. |
| `invalid_timestamp` | Not an RFC 3339 timestamp with an explicit offset, or an impossible calendar time. |
| `missing_artifact`, `ambiguous_artifact_source` | Neither or both artifact sources supplied. |
| `invalid_reference`, `blocked_reference` | Unsafe external reference (non-HTTPS, credentials, non-default port, fragment, loopback/private/link-local/metadata target). |
| `unsupported_encoding`, `invalid_artifact_encoding`, `artifact_too_large`, `artifact_size_mismatch` | Inline artifact cannot be decoded under the contract. |
| `unsupported_integrity_algorithm`, `integrity_mismatch` | Unsupported digest algorithm, or an inline artifact whose bytes do not match the declared digest. |
| `invalid_redaction`, `redaction_inconsistent`, `redaction_limit` | Incoherent redaction status/policy/paths or too many paths. |
| `metadata_limit` | Too many metadata entries, or a metadata string over its limit. |
| `redaction_unavailable` | A caller asked to redact an artifact that stayed external. |

Error messages name the failing field or rule, never the submitted value. Artifact bytes,
claim values, tokens and URLs with credentials are therefore absent from messages and logs.

## 4. Segregation, integrity and secure references

- **Prefer `artifactRef`.** An external reference keeps credential bytes out of the event
  stream. The reference is validated for scheme, credentials, port, fragment and IP-literal
  host safety. DNS names are not resolved here; a future fetcher must resolve and pin the
  address with the import pipeline's SSRF controls before connecting.
- **Inline only when necessary.** An inline artifact is decoded, bounded and moved to
  `NormalizedCaptureArtifact.sensitive`; the envelope returned alongside it contains only
  metadata. Callers must not log, index or persist `sensitive.bytes` without their own
  authorization and storage controls.
- **Integrity.** The SHA-256 digest covers the exact raw bytes. For an inline artifact the
  digest is recomputed and a mismatch rejects the submission (`verified: true`). For an
  external reference the normalizer cannot verify the bytes, so it preserves the declared
  digest, sets `verified: false` and emits the
  `external_artifact_integrity_unverified` diagnostic. This limitation is explicit, not
  silently treated as verification.

## 5. Provenance and correlation

The caller's `capturedAt` text is preserved verbatim (including its offset) and also exposed
as Unix milliseconds. The normalizer adds `receivedAt`/`receivedAtMs` in UTC from its
injectable clock. `sourceComponent`, `sourceVersion`, `captureId`, `correlationId`,
`testExecutionRef`, `party` and `metadata` are preserved without rewriting. Correlation is by
stable identifiers, never by position or time. AttestBook never mints or rewrites a caller's
correlation identifier; minting convention remains a Credimi agreement (CD-5).

## 6. Redaction

`redactNormalizedCaptureArtifact` is the supported way to turn a normalized inline artifact
into a loggable/exportable projection. It never touches the metadata envelope.

- **Partial** (default policy `attestbook.default-capture-redaction@1`) is an **allow-list**,
  not a deny-list: it keeps a scalar only when its member name is one of the non-personal
  protocol/structural names in `DEFAULT_PRESERVED_CAPTURE_KEYS` (issuer and endpoint
  identifiers, format/type selectors, algorithm and key identifiers, request/response shape
  and error codes). Every other scalar becomes `[redacted]` and its JSON Pointer is recorded
  in `redaction.redactedPaths` (up to the configured limit; a truncated list is reported by
  `redaction_paths_truncated`). Members known to contain tokens, credential artifacts,
  disclosures or claims are replaced whole. A source-declared partial redaction may omit the
  path list when it has no location evidence. Object keys and array positions are preserved,
  so findings can still name an attribute path without exposing its value; callers can extend
  the allow-list with `preservedKeys` or force-redact a name with `sensitiveKeys`.
- **Full** replaces every scalar while preserving object keys and array lengths. This is the
  only safe mode for opaque (non-JSON) artifacts and for a JSON artifact whose content cannot
  be parsed; the result is labelled `full` and carries a `redaction_full_fallback`
  diagnostic.
- A partial policy that replaces nothing records `status: "none"` rather than claiming a
  redaction happened.
- `redaction.redactedDigest` is the SHA-256 of the redacted bytes. The envelope `integrity`
  continues to describe the unredacted original, so the original can be verified without
  retaining a copy; a consumer must compare `redactedDigest`, not `integrity`, against
  redacted bytes.
- Raw credentials, tokens, keys and personal attributes are never logged by this module.
  Declaring an inline artifact as already redacted is rejected (`redaction_inconsistent`):
  only an external reference may carry a `partial`/`full` status without this normalizer
  seeing the raw bytes.

## 7. Limits

`DEFAULT_CAPTURE_LIMITS` bounds one submission: 512 KiB envelope, 24 JSON levels, 4,096 JSON
values, 384 KiB per JSON string, 256 KiB inline artifact, 2,048-character reference URI,
200-character identifiers, 32 metadata entries, 512-character metadata strings and 64
redacted paths. `resolveCaptureLimits` rejects invalid overrides; the normalizer's clock and
limits are injectable for deterministic tests.

## 8. Tests

The specification §16 capture matrix is covered by `src/capture/`:

| §16 check | Tests |
| --- | --- |
| Valid capture artifact | `envelope.test.ts` — mock capture-issuer inline artifact, capture-verifier external reference |
| Missing artifact | `envelope.test.ts` — no source, both sources |
| Malformed artifact | `envelope.test.ts` — identifiers, timestamps, enumerations, metadata, inline artifact, integrity, JSON bounds |
| Redacted artifact | `redaction.test.ts` — partial/full, opaque and malformed-JSON fallback, envelope integrity/digest split |
| Unsupported protocol | `envelope.test.ts` — unsupported protocol and every other closed enumeration |
| Correlation identifiers | `envelope.test.ts` — verbatim capture/correlation/test-execution preservation |
| Mock capture-issuer input | `envelope.test.ts` — `issuerEnvelope` fixture |
| Mock capture-verifier input | `envelope.test.ts` — `verifierEnvelope` fixture |
| Security controls | `security.test.ts` — reference SSRF targets, no secret echo, prototype members, size bounds |

## 9. Explicit limitations

- No capture transport, mock adapter or real component integration is implemented here;
  those are #47. No capture artifact in this slice comes from a live interaction.
- An external reference's digest and the artifact behind it are not verified; a future
  fetcher must enforce SSRF-safe resolution, authentication and size limits.
- Partial redaction is a member-name allow-list, not a semantic classifier. Unknown or
  unlisted members are redacted, but personal data placed under a preserved member name (for
  example an email address used as an `issuer` value) would be kept. Callers can add the name
  to `sensitiveKeys` to force-redact it, extend `preservedKeys` for a custom non-personal
  member, or prefer storing sensitive evidence behind an authorized external reference.
- Full redaction preserves object keys and array positions so paths stay referenceable; a
  member name that is itself personal data is not redacted. Capture sources must not derive
  member names from personal data.
- `metadata` is defined as non-sensitive scalar data. The normalizer enforces its shape but
  does not classify its values, so a source must never put credentials, tokens or personal
  attributes there; they belong in the artifact (inline, or preferably external behind an
  authorized reference).
- No signing, encryption, selective-disclosure recovery or protocol conformance claim is
  made. Missing or undisclosed claims remain `NOT_TESTED` for later validation, not failures.
