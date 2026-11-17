The Capture explorer is the public UI-006 view of AttestBook capture evidence. It
groups normalized capture artifacts with the pinned rulebook version they were
validated against, preserves the source's opaque correlation identifiers and
lists the evidence that is missing or unavailable. Start at [the capture
explorer](/captures).

**Mock-backed:** every capture the explorer shows today comes from deterministic
local mock fixtures. The only implemented transport is `mock`, no live
`capture-issuer` or `capture-verifier` connector is integrated, and no capture in
the UI is evidence of a real wallet interaction.

## What the two capture explorer pages show

The list at [the capture explorer list](/captures) is public and needs no session. Each
row is one normalized capture: its source component and `mock` transport label,
interaction and protocol, artifact type and credential format, capture and receipt
times, correlation id, opaque test-execution reference, pinned rulebook version,
validation status and the explicit evidence gaps.

The detail page at `/captures/<captureId>` adds the normalized metadata, the
source-declared redaction, the ordered evidence timeline and the explorer's
limitations. Inline evidence is shown only as the default-policy redacted
projection with path-preserving placeholders; an external `artifactRef` is
reported as **External artifact not fetched** and is never fetched to render the
page. The raw artifact is never returned by the read model.

Only the validation form on the detail page needs a session: it records a
correlation that every reader can see, so an anonymous reader gets a sign-in
prompt instead and no request is sent.

## Mock-backed evidence is labelled, not implied

- Every source names its transport, and every capture from the mock source is
  labelled `mock` next to a visible **Mock** badge. The explorer notice repeats
  that no live component is operational.
- The fixtures are deterministic local artifacts for both components, covering
  every version 1 artifact type. They are normalized through the same envelope
  normalizer as any submitted capture, so the mock boundary is the origin of the
  evidence, not a shortcut around validation.
- Missing evidence stays visible. The read model reports
  `external_artifact_not_fetched`, `artifact_redacted_by_source`,
  `no_test_execution_reference`, `no_rulebook_binding`, `validation_not_run` and
  `validation_not_applicable` as gaps, and an absent field is never treated as a
  pass.
- The explorer read model and every correlation are in memory for the server
  process only. Restarting the server discards them; the explorer is not a
  durable run history or a persistence design.

## Rulebook correlation

`POST /api/v1/captures/{captureId}/validate` correlates one capture with one
exact rulebook version. The request carries `rulebookId`, `rulebookVersion`,
`attestationType` and an optional lowercase-hex `rulebookDigest`. AttestBook runs
the real structural credential engine on the capture's segregated inline
artifact, then records the exact binding: rulebook identifier, name, version,
content digest, specification version, rulebook status, the selected attestation
type and the binding time.

- The caller-owned `captureId`, `correlationId` and `testExecutionRef` are
  preserved verbatim. AttestBook does not mint a correlation id.
- A supplied digest that no longer matches the version snapshot is refused with
  `409 conflict` before anything is recorded, so a stale pin cannot overwrite
  correct evidence.
- Evidence that cannot be validated honestly is refused with `409 conflict`: an
  external reference that was not fetched, or an artifact that is not an
  `issued-credential`. A captured presentation submission is not unpacked into a
  credential.
- The correlation never mutates the pinned rulebook version or its artifact, and
  it writes no registry data.

## The headless-wallet comparison read model

`POST /api/v1/captures/{captureId}/compare` is a read-only projection over a
correlation that already exists. It returns the
`attestbook.headless-wallet-comparison@1` report: the exact pinned rulebook
binding, the AttestBook structural and schema evidence, and, optionally, a
caller-supplied external wallet observation.

The report keeps the two evidence sources apart. The `schema` group holds the
dimensions AttestBook executes (`credential_parsing`, `format_recognition`,
`schema_validation` and `attestation_constraints`). The `protocol`,
`interoperability` and `trust` groups are supplied only by the external
observation, which is recorded as bounded input, labelled `external`, and never
verified or folded into an AttestBook validation status. `unsupported` names
every dimension the comparison cannot establish, and `nonClaims` fixes
`externalObservationVerified` and the four AttestBook-unexecuted dimensions to
`false`.

AttestBook starts no wallet, no Credimi execution and no interoperability test.
The comparison report has no UI page of its own: it is a machine-readable
integration artifact for Credimi, not a successful integration demonstration.

Credimi remains the orchestration platform for test executions (FR-020) and owns
any recurring conformance schedule (FR-022). AttestBook provides validation
evidence and the FR-021 comparison seam; recurring conformance runs use their
own deterministic validation API, not the capture explorer.

## Where the mock/sample boundary ends

These parts are implemented and exercised in this build:

- the versioned capture envelope, bounded normalization and redaction;
- the pull and push adapter contracts with the mock transport;
- the mock-backed explorer read model, explicit evidence gaps and the public
  read routes;
- the real structural credential validation engine for a captured issued
  credential, linked to the exact pinned rulebook version and digest;
- the comparison projection over the recorded correlation.

These parts are **not** implemented and are not claimed:

- a live `capture-issuer` or `capture-verifier` integration, an operational
  capture component or any real capture evidence;
- fetching an `artifactRef`; its declared digest is recorded but not verified;
- persistence, retention or a durable correlation history beyond the server
  process;
- signing, encryption or any claim that a capture artifact is authentic or
  complete;
- cryptographic verification, issuer trust, protocol conformance,
  interoperability or wallet orchestration.

Only structural and schema evidence is established by AttestBook. A structural
pass never implies cryptographic, issuer-trust, protocol or interoperability
success, and `NOT_TESTED` or `INCONCLUSIVE` stays explicit rather than becoming a
pass. Nothing on this page describes a capability that the application does not
have.

## Where this is documented

- `docs/ui.md` §1 and §3 for the capture explorer UI, routes, states and the
  mock labelling.
- `docs/capture.md` §9 and §11 for the read model, correlation and explicit
  limitations.
- `docs/headless-wallet-comparison.md` for the comparison contract, bounds and
  non-claims.
- `docs/specification.md` §14 UI-006 and §11–§12 FR-019–FR-022 for the
  requirement boundary: design the capture interface for future integration, do
  not implement a fake production integration, and keep orchestration outside
  AttestBook.

The operation-by-operation contract is in [the API reference](/docs) and the
canonical `/openapi.json` document.
