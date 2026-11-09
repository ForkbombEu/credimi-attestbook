# Security threat model, retention policy and Phase 6 audit

**Status:** Phase 6 security audit for
[issue #52](https://github.com/ForkbombEu/credimi-attestbook/issues/52). It reviews the
controls that earlier slices implemented for the specification §15 mandatory list, records
the security evidence and residual risks, and documents the data-retention and redaction
policy AttestBook actually enforces. It is a security record, not a conformance, trust or
interoperability claim.

**Authoritative spec:** [`docs/specification.md`](specification.md) §15 (security
requirements) and §18 Phase 6.
**Related:** [`docs/security.md`](security.md) (authentication, provider authorization,
secret handling and the write-API audit trail), [`docs/import.md`](import.md) (remote import
controls), [`docs/discovery.md`](discovery.md) (issuer metadata discovery),
[`docs/capture.md`](capture.md) (capture envelope, redaction and explorer),
[`docs/registry.md`](registry.md) (immutability and artifact storage),
[`docs/api.md`](api.md) (HTTP contract and error table) and
[`docs/architecture.md`](architecture.md) §11 (the Phase 0 threat/risk outline).
**Issues reviewed:** #28–#51, whose merged code this audit verifies.

## 1. Scope and method

AttestBook treats every remote document, credential, schema, capture artifact and request
body as untrusted input. The audit answers four questions for each §15 control:

1. where the boundary is enforced in code;
2. which test would fail if the control were removed or weakened;
3. what data the control retains, for how long, and how it is redacted; and
4. which risk remains after the control.

In scope: outbound remote import and discovery, schema-reference and recursion handling,
credential and schema input to validation, capture evidence, local artifact and audit
retention, provider authentication/ownership and the HTTP surface that exposes them.

Out of scope and stated as residual risk: TLS termination, operating-system and database
hardening, network-edge DDoS protection, backups, multi-node deployment, real
`capture-issuer`/`capture-verifier` integrations, browser-side transport security and
third-party services. Those are deployment responsibilities or later slices, not controls
this repository can prove from its test suite.

No production control in this audit is asserted from documentation alone: every "implemented"
row names the code and a test that exercises it. Where a control is partial, the residual
risk is stated instead of being upgraded to "mitigated".

## 2. Assets, actors and trust boundaries

### 2.1 Assets

| Asset | Why it matters |
| --- | --- |
| Rulebook drafts, attestations, schema references | Untrusted imported content becomes product data; it must not gain authority or mutate released bytes. |
| Published/historical version snapshots and their content-addressed artifacts | Reproducibility and export depend on exact immutable bytes. |
| Provider bearer tokens | A token grants every write authority of its provider. |
| Audit trail (`audit_log`) | The record of privileged mutations; must not leak secrets. |
| Capture evidence and correlations | May contain personal data, credentials, tokens or keys. |
| Credentials and schema documents submitted for validation | Sensitive request bodies that must not be logged, persisted or audited. |
| Import and discovery source bytes | Untrusted, potentially large or hostile; bounded and not retained. |
| Service availability and local disk | A hostile source or caller must not exhaust memory, CPU, sockets or storage without bound. |

### 2.2 Actors

| Actor | Credentials | Authority |
| --- | --- | --- |
| Anonymous reader | none | Public catalogue, version, export, capture-explorer and health reads; public structural credential validation. |
| Provider account | Provider bearer token (`att_…`) | Create/mutate only its own rulebooks; import its own drafts; preview imports; discover issuer metadata. |
| Operator | Out-of-band deployment access | Provision providers and first tokens, inspect the audit trail, configure and maintain the deployment. No HTTP route performs provider administration. |
| Remote import / issuer source | none | Untrusted input; never trusted for provider identity, trust or publication authority. |
| Capture source (mock in this build) | Hashed adapter credential | Supplies evidence to the adapter boundary; its metadata and artifact content remain untrusted. |
| Malicious provider | A valid token | Can consume its own bounded request budget and attempt cross-provider access, which ownership checks must deny. |

### 2.3 Trust boundaries

```text
browser/client ──HTTP──> app (4 MiB body limit, central bearer check)
                         ├─> registry service ──> SQLite (rulebooks, versions, artifacts, audit)
                         ├─> import/discovery ──> bounded HTTPS fetch ──> remote source
                         ├─> validation ──> separate schema sandbox child
                         └─> capture adapter ──> normalizer ──> in-memory explorer
```

- Provider identity is derived only from the bearer token, never from a URL, an import
  source, issuer metadata or a request body.
- Remote bytes cross into the application only through the shared bounded fetch path used by
  import and discovery. No other module fetches a URL.
- Schema documents supplied by a caller are evaluated in a separate child process, not in the
  HTTP process.
- A capture source's artifact is normalized and bounded before it is interpreted; raw inline
  bytes stay segregated from the metadata envelope.
- SQLite is the only durable store. Capture evidence and correlations are memory-only.

## 3. Threat catalogue and current status

Status values: **mitigated** means the named control and test exist and no material gap is
known within the stated boundary; **partial** means a control exists but a stated residual
risk remains; **open** means no control is implemented and the risk is accepted for this
phase.

| ID | Threat | Scenario | Controls and implementation | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| T1 | SSRF | An imported catalogue or issuer metadata names `http(s)://127.0.0.1`, `169.254.169.254`, a private, link-local, CGNAT, multicast, documentation or IPv4-mapped/NAT64 address. | `validateImportUrl` accepts only absolute `https` on the default port without credentials; literal hosts are classified before any I/O. `resolveImportTarget` resolves once and rejects the URL if **any** answer is non-public. | `src/import/url.test.ts` (literal, mapped-IPv6, mixed-answer and DNS-failure cases); `src/import/http.test.ts` (transport never called for a blocked URL). | mitigated |
| T2 | DNS rebinding | A resolver returns a public address for validation and a private address for the connection. | The transport connects to the resolved and validated address and sends the original hostname only as TLS SNI/`Host`; there is no second resolution. DNS lookup is bounded by the caller's remaining deadline. | `src/import/http-transport.test.ts` (pinned address/`Host`, TLS certificate mismatch); `src/import/url.test.ts` (slow resolver bound). | mitigated |
| T3 | Redirect abuse | A public source redirects to a private address, a non-`https` URL or an endless chain. | Redirects are followed manually, capped at 3, and every target is re-validated and re-resolved under the same address rules before it is fetched; the total wall-clock budget is shared across redirects. | `src/import/http.test.ts` (private/non-https redirect refusal, redirect limit, total deadline); `src/discovery/discover.test.ts` (re-validation on the discovery path). | mitigated |
| T4 | Response, JSON and fan-out resource exhaustion | A hostile source returns a multi-gigabyte body, a lying `Content-Length`, chunked data over the cap, deeply nested JSON, an enormous catalog or unbounded schema references. | 2 MiB source cap enforced from the header and while streaming; 10 s per request and 15 s total; 48 JSON levels, 20 000 values, 256 KiB strings, UTF-8 only, `__proto__` rejected; 100 catalog entries; 16 schema references per entry and 2 048-character URIs. Discovery adds 200 configurations, 32 type identifiers and 16 references/authorization servers per document. | `src/import/http.test.ts` (oversized response, missing content-length, timeout); `src/import/http-transport.test.ts` (chunked body over the cap while streaming); `src/import/json.test.ts` (depth/node/string limits); `src/import/preview.test.ts` (catalog and reference limits); `src/discovery/discover.test.ts` (size, content type, metadata bounds). | mitigated |
| T5 | Recursive or hostile JSON Schema | A schema uses `$ref`/`$dynamicRef`/`$recursiveRef` cycles, hides a catastrophic `pattern`, or nests deeply to exhaust the evaluator. | JSON Schema references are **not resolved**: `$ref`, `$dynamicRef`, `$recursiveRef`, `pattern`, `patternProperties`, `format`, `uniqueItems` and legacy `dependencies` are rejected as unsupported and reported `NOT_TESTED` instead of executed. Documents deeper than 64 levels fail; credentials with more than 4 096 claim nodes are not evaluated. Only integrity-verified documents reach the separate sandbox (2 s hard timeout, 256 MiB RSS watchdog, 1 MiB output cap, 2 concurrent children, fail-closed without `/proc`). OWF `extends` chains are bounded at depth 10. | `src/validation/schema.test.ts` (every `$ref` route, cyclic references, depth bound, claim-node bound, regex/format/`uniqueItems`); `src/validation/schema-sandbox.test.ts` (timeout, RSS kill, concurrency, fail-closed); `src/standards/references.test.ts` (extends-depth cap, SRI mismatch). | mitigated |
| T6 | Credential and secret exposure in reads, logs or audit | A validation, capture or update path echoes a credential, token, private key or personal attribute; a rejected request logs its body. | Tokens are stored SHA-256-hashed and never echoed; request headers/bodies/URLs are not logged; the only request log is method/path/error class; audit detail carries identifiers, field names and digests only; capture raw bytes are segregated and the explorer returns only the default-policy redacted projection; partial redaction keeps an allow-list and falls back to full redaction for opaque or unparseable artifacts; validation inputs are not logged or persisted. | `src/api/security.test.ts` (no credential in `401` bodies, error logs or audit rows); `src/capture/security.test.ts` (no secret echo, redacted artifact bytes); `src/capture/redaction.test.ts` (partial/full, fallback, digest split); `src/api/captures.test.ts` (raw artifact never returned). | mitigated |
| T7 | Unnecessary retention of personal data or artifacts | Capture evidence, credentials or import source bytes are persisted indefinitely or retained by the wrong component. | Capture evidence is in-memory only (explorer bounded at 10 000 records and 100 source pages; mock idempotency keeps only the capture id and SHA-256, bounded at 1 024 accepted captures); validation inputs are never stored; import stores provenance/digest, not source bytes; published/historical version artifacts are intentionally immutable; no HTTP delete exists for released artifacts. The detailed policy is §4. | `src/capture/explorer.test.ts` (instance-local evidence with no shared store, redacted projection); `src/capture/adapters/mock.test.ts` (idempotency keeps only ids/hashes, store-full refusal); `src/import/importer.test.ts` (source bytes not written); `src/registry/versions.test.ts` and `src/db/migrations.test.ts` (immutability triggers). | partial — see F4 and F5 |
| T8 | Unauthorized publication or cross-provider mutation | A provider uses its token to mutate or publish another provider's rulebook, or a URL/source claims an authority it does not have. | Every write route requires a bearer token; ownership is re-checked in the registry service (`requireOwnedRulebook`) and cannot be supplied by a request body. Publication checks ownership before replay/version lookup. Provider identity is never inferred from remote content. | `src/api/security.test.ts` (protected operation set, `401` on every protected route, foreign `403` with unchanged state); `src/registry/authorization.test.ts` (service-level denial); `src/api/publication.test.ts` (owner-only publication). | mitigated |
| T9 | Missing or tampered audit evidence | A privileged mutation happens without a durable record, or the audit trail is exposed/leaks data. | Every registry mutation writes an `audit_log` row with actor, action, entity and safe detail; publication records version, digest, profile and superseded versions. The trail is not exposed over HTTP; operators read it from the database. | `src/registry/registry.test.ts` (every mutation, actor, safe detail); `src/registry/versions.test.ts` and `src/api/publication.test.ts` (`version.publish` detail); `src/import/importer.test.ts` (import create audit) added by this audit. | partial — denied attempts are not audited (F3) |
| T10 | Code execution from imported documents | A remote catalogue, schema or Type Metadata document embeds JavaScript, a Markdown script or a dynamic import. | Imported documents are handled as data only: `JSON.parse`, the OWF codecs and Ajv over verified documents; never `eval`, `Function` or dynamic import. AttestBook does not render untrusted Markdown or HTML. | `src/import/json.test.ts`, `src/import/preview.test.ts`, `src/validation/schema.test.ts`; the dependency boundary is checked by `src/dependencies.test.ts`. | mitigated |
| T11 | Token compromise and replay | A token leaks and is replayed; an old token is never rotated. | 256 random bits, `att_` prefix, only the hash stored, explicit provider-scoped revocation, missing/unknown/revoked indistinguishable. Tokens are not put in URLs, bodies, browser storage or logs. | `src/registry/authorization.test.ts`, `src/api/security.test.ts`; UI token handling in `ui/src/draft.test.ts`/`ui/e2e/editor.spec.ts`. | partial — no expiry/rotation (F2) |
| T12 | Trusting an untrusted source or its conformance claim | An unsigned catalogue or issuer metadata is treated as a verified rulebook, trust anchor or interoperability result. | Retrieved bytes are recorded with provenance and digest; a source's conformance claim can only lower AttestBook's classification; unresolved references are `NOT_TESTED`; discovery returns candidates and never a conformance/trust result; no signature verification is fabricated. | `src/import/preview.test.ts` (claim downgrade); `src/discovery/discover.test.ts`, `src/discovery/metadata.test.ts` (candidates, invalid metadata); `src/acceptance/workflow.test.ts` (not-tested dimensions stay not tested). | mitigated |

## 4. Data-retention and redaction policy

The policy below is what the implementation enforces today. "Retention" is the lifetime of
the data in AttestBook; deletion outside the product (database files, backups) is an operator
responsibility.

| Data | Where it lives | Retention | Redaction, access and enforcement |
| --- | --- | --- | --- |
| Raw bearer token | Never stored; returned once by provisioning/issuance | Not retained | Only its SHA-256 hash is stored in `auth_tokens`; no API or log echoes the raw value; revocation is provider-scoped. |
| Provider, rulebook, attestation and schema-reference metadata; drafts | SQLite `providers`, `rulebooks`, `attestations`, `schema_references` | Until the rulebook is deleted while it has no published/historical versions | Public read by design; `metadata` is bounded to 64 KiB; imported internal metadata is never merged into a standards document. |
| Draft version rows | SQLite `rulebook_versions` (status `draft`) | Until the draft rulebook is deleted | Not exported; cannot become published/historical without the explicit publication transition. |
| Published/historical version snapshots and artifacts | SQLite `rulebook_versions` and content-addressed `artifacts` | Intentionally indefinite: exact bytes are required for reproducibility | Immutability enforced by service checks and SQL triggers; a status-only `published → historical` transition is allowed; no HTTP delete; export is public by design. |
| Audit log | SQLite `audit_log` | Retained with the database; operator-controlled | Append-only through the API; never exposed over HTTP; detail is limited to identifiers, actions, field names, version labels and digests. |
| Import source bytes | Not stored | Request memory only | Only a SHA-256 content digest, bounded provenance (URL, redirects, content type, byte length, timestamps, profile/conformance) and normalized content reach the registry. |
| Issuer metadata bytes | Not stored | Request memory only | Only a bounded projection (issuer, endpoints, configurations, references, provenance) is returned; raw bytes are not logged or returned. |
| Credentials and schema documents submitted for validation/conformance | Not stored | Request memory only; the schema child exits after evaluation | No audit row, no log line and no database write; findings carry paths, statuses and safe messages only. |
| Capture envelope metadata | In memory in the explorer | Process lifetime; a restart clears it | Public read; metadata is defined as non-sensitive scalar data and shape-bounded (F5). |
| Capture raw inline artifact | In memory, segregated in `NormalizedCaptureArtifact.sensitive` | Process lifetime; not persisted; never logged or indexed | Only the default-policy redacted projection is returned by the API. The original `integrity` digest describes the unredacted bytes; `redaction.redactedDigest` describes the projection. |
| Capture explorer evidence and correlations | In memory | Process lifetime; bounded at 10 000 records / 100 pages per source | Correlation requires a provider token because it is visible to every reader; external references are never fetched. |
| Mock capture idempotency | In memory | Process lifetime; bounded at 1 024 accepted captures | Keeps only the capture id and the SHA-256 of the exact submission; raw submission and artifact bytes are not retained. A full store rejects a new capture instead of growing. |
| Server logs | Process stdout/stderr | Operator log retention | Startup/shutdown lines and one unhandled-error line with method, path and error class only; no headers, bodies, URLs, exception messages or stacks. |
| Outbound fetch provenance | Stored in rulebook provenance | With the rulebook | Bounded projection; redirect chains are included in stored provenance but excluded from the public export manifest. |

### 4.1 Redaction policy

- **Default policy reference:** `attestbook.default-capture-redaction@1`
  (`DEFAULT_CAPTURE_REDACTION_POLICY_REF`).
- **Partial mode** replaces values whose member name matches the sensitive list (tokens,
  authorization, secrets, keys, credential artifacts, disclosures, common personal claims)
  or a sensitive suffix, and keeps only allow-listed non-personal protocol/structural members
  at scalar positions. Every replacement is recorded as a JSON Pointer; path evidence is
  bounded at 64 entries and 256 characters.
- **Full mode** replaces every scalar while keeping member names and array positions so
  paths remain referenceable.
- **Opaque/unparseable artifacts** fall back to full redaction with an explicit
  `redaction_full_fallback` diagnostic. A projection that exceeds the envelope bounds also
  falls back instead of copying raw bytes.
- **Re-serialization** drops duplicate members, formatting and escapes, so a no-match partial
  projection is labelled `partial`; the original bytes are returned only when they are
  already the canonical serialization and nothing was hidden.
- **Limitations:** redaction is a member-name policy, not a semantic classifier. Personal
  data placed under a preserved name, or encoded in a member name, would be kept. Callers
  can add `sensitiveKeys`; sources must not use personal data as member names. Capture
  metadata is trusted to be non-sensitive (F5), and only the default projection is served.

### 4.2 Deletion and retention operations

- There is no HTTP endpoint to delete a published or historical version or its artifact.
- Deleting a draft rulebook removes its draft rows; content-addressed artifact bytes are
  append-only and are not reclaimed by the current code (F4). This is a deliberate safe
  default, not a garbage collector.
- Capture evidence, correlations and mock idempotency state disappear on process restart;
  there is no persistence layer to delete.
- Backups, WAL files and the database file itself are operator-managed; the repository does
  not implement retention beyond the product boundary.

## 5. Audit logging

### 5.1 Events

`audit_log` records the acting provider (`actor_provider_id`, `null` only for operator
provisioning), action, entity type/id, timestamp and safe detail.

| Action | Entity | When | Detail |
| --- | --- | --- | --- |
| `provider.provision`, `provider.update`, `provider.delete` | provider | Operator/provider lifecycle | Changed field names; deleting a provider records the delete. |
| `token.issue`, `token.revoke` | auth_token | Token lifecycle | Optional label; never the token or hash. |
| `rulebook.create`, `rulebook.update`, `rulebook.delete` | rulebook | Rulebook and draft mutations | Changed field names; created ids. |
| `attestation.create`, `attestation.update`, `attestation.delete` | attestation | Attestation working-copy mutations | Rulebook id, name and reason. |
| `schema_ref.create`, `schema_ref.update`, `schema_ref.delete` | schema_ref | Schema-reference mutations | Rulebook/attestation ids, format and reason. |
| `version.create`, `version.refresh` | rulebook_version | Draft snapshot creation/refresh | Version label and content digest. |
| `version.publish` | rulebook_version | Publication | Version, content digest, profile, superseded versions. |

An import writes one `rulebook.create` row (and its child rows) for every newly created
draft, attributed to the importing provider. Re-importing unchanged content writes nothing
and therefore creates no new audit row.

### 5.2 Boundaries

- The trail is not exposed over HTTP; only operators with database access can read it.
- Rejected authentication and authorization attempts are **not** audited (F3): writing an
  audit row before authentication would let an unauthenticated caller force database writes,
  and the current schema needs an actor to attribute them. Edge or reverse-proxy logs are the
  recommended compensating control.
- Reads, including credential validation, capture reads and exports, are not mutations and
  are not audited.
- Capture correlations are in-memory state and are not audited because they are not
  persisted; they are visible to every reader and require a provider token to create.
- The repository does not implement audit tamper-proofing. An operator with database access
  can alter the table; deployment access control and backups are the boundary.

## 6. Resource-limit budget

| Component | Bound | Default | Constant / enforcement |
| --- | --- | --- | --- |
| HTTP API body | Request body | 4 MiB | `MAX_API_BODY_BYTES`, Hono `bodyLimit` before route auth |
| Import transfer | Source bytes | 2 MiB | `DEFAULT_IMPORT_LIMITS.maxSourceBytes` (header and streaming) |
| Import time | Per request / total across redirects | 10 s / 15 s | `requestTimeoutMs` / `totalTimeoutMs` |
| Import redirects | Chain length | 3 | `maxRedirects`, each re-validated |
| Import JSON | Depth / values / string | 48 / 20 000 / 256 KiB | `maxJsonDepth`, `maxJsonNodes`, `maxJsonStringLength` |
| Import catalog | Entries / references / URI length | 100 / 16 / 2 048 | import limits, shared with the registry batch ceiling |
| Discovery | Configurations / type ids / refs / auth servers | 200 / 32 / 16 / 16 | `src/discovery/metadata.ts` |
| Schema documents | Depth / claim nodes / extends depth | 64 / 4 096 / 10 | `MAX_SCHEMA_DEPTH`, `MAX_CREDENTIAL_CLAIM_NODES`, `MAX_EXTENDS_DEPTH` |
| Schema evaluation | Time / RSS / output / concurrency | 2 s / 256 MiB / 1 MiB / 2 | `DEFAULT_SANDBOX_LIMITS`, configurable by `SCHEMA_SANDBOX_*` |
| Registry write | Attestations / references / metadata / batch | 64 / 16 / 64 KiB / 100 | `src/registry/validation.ts` |
| Capture submission | Envelope / JSON depth / values / string | 512 KiB / 24 / 4 096 / 384 KiB | `DEFAULT_CAPTURE_LIMITS` |
| Capture artifact | Inline bytes / reference URI | 256 KiB / 2 048 | `DEFAULT_CAPTURE_LIMITS` |
| Capture explorer | Records / source pages / page size | 10 000 / 100 / 100 | `src/capture/explorer.ts` |
| Mock capture store | Accepted captures | 1 024 | `DEFAULT_MAX_ACCEPTED_CAPTURES` |

Residual resource risks: there is **no HTTP rate limit and no bounded outbound-fetch
concurrency** per process (F1). An authenticated provider can therefore consume its share of
sockets and wall-clock time up to whatever the deployment can accept. The per-request bounds
above stop a single request from being unbounded; they do not stop many bounded requests.
Deployments should front AttestBook with a rate-limiting proxy until a later slice adds an
application-level budget.

## 7. Findings and remediation

| ID | Severity | Finding | Status / remediation |
| --- | --- | --- | --- |
| F1 | medium | No HTTP rate limiting and no bounded outbound-fetch concurrency; an authenticated provider can make many bounded import/discovery requests at once. | Open by phase design. Compensating controls: per-request time/size/redirect caps, provider authentication, deployment-level rate limiting. Recommended next slice: a shared fetch budget with a bounded wait queue and a documented `503`/`502` mapping; do not implement it as an unbounded queue. |
| F2 | medium | Tokens have no expiry or rotation policy; revocation is explicit. | Open. Tokens are 256-bit, stored hashed and provider-scoped; a deployment must terminate TLS and rotate by revoking and re-issuing. Tracked as future hardening in `docs/security.md` §8. |
| F3 | low | Denied authentication/authorization attempts and import fetch failures are not audited. | Accepted. Auditing before authentication would allow unauthenticated write amplification; attribution needs an actor. Use edge/reverse-proxy security logs. Revisit with a separate `security_event` store if the product needs it. |
| F4 | low | Content-addressed artifacts are append-only; deleting a draft rulebook does not reclaim unreferenced bytes. | Accepted retention decision: published/historical bytes must never be reclaimed, and there is no safe GC yet. Operators perform database maintenance/backups. A future GC may delete only artifacts referenced by no version row, after an explicit retention window and with an audit row. |
| F5 | medium | Capture `metadata` is defined as non-sensitive and displayed as supplied; a malicious source could place personal data there. | Documented boundary and explicit explorer limitation. The normalizer bounds its shape and the return projection; sources must not place secrets in metadata. A future semantic classifier or a metadata redaction policy is recommended before a live capture integration. |
| F6 | high if misconfigured | TLS termination is deployment-owned; AttestBook serves HTTP. | Documented in `docs/security.md` §8. A deployment must terminate TLS in front of the service; bearer tokens are not meaningful over plaintext transport. |
| F7 | low | Remote `$ref` resolution and remote schema fetching are not implemented. | Deliberate safe default: references are retained, bounded and reported `NOT_TESTED`; the schema evaluator rejects reference keywords. Any future resolver must reuse the import URL/DNS/redirect/size controls and the sandbox, never a second fetch path. |
| F8 | medium | Single-writer SQLite and no audit tamper-proofing. | Deployment constraint (D-7) documented in `docs/implementation-plan.md`; backups and database access control are operator responsibilities. |
| F9 | info | Capture integration is mock-backed; no live `capture-issuer`/`capture-verifier` endpoint is contacted. | Explicitly labelled `transport: "mock"`; real integration requires the component contracts and its own SSRF/auth/retention review. |

### 7.1 Remediation implemented by this audit

- Added the explicit JSON Schema recursion/cycle regression test to
  `src/validation/schema.test.ts` (the threat-specific cases T5 names).
- Added import audit verification to `src/import/importer.test.ts`, including a check that
  audit detail never contains the imported document's content.
- Added capture retention/no-persistence verification to `src/capture/explorer.test.ts`.
- Wrote this threat model, retention policy and remediation register; linked it from the
  write-API security model, the architecture threat outline and the traceability matrix.

No production control for SSRF, recursion, redaction or provider ownership had to be
re-implemented: #30–#35 and #46–#51 already shipped those controls, and this audit verifies
them rather than replacing them. The open findings above are genuine residual risks, not
controls silently claimed as done.

## 8. Verification

Run from the repository root:

```
bun run check
bun run docs:check
```

| §15 control | Primary tests |
| --- | --- |
| SSRF protection / safe URL validation | `src/import/url.test.ts`, `src/import/http.test.ts`, `src/import/http-transport.test.ts`, `src/discovery/discover.test.ts` |
| Network timeouts and response-size limits | `src/import/http.test.ts`, `src/import/http-transport.test.ts` |
| JSON parsing and JSON Schema reference limits | `src/import/json.test.ts`, `src/import/preview.test.ts`, `src/validation/schema.test.ts` |
| Safe handling of recursive references | `src/validation/schema.test.ts` (cyclic `$ref`/`$dynamicRef`/`$recursiveRef`, depth bound), `src/standards/references.test.ts` (extends depth) |
| Resource-consumption limits | `src/validation/schema-sandbox.test.ts`, `src/fixtures/generate.test.ts`, `src/capture/security.test.ts`, `src/app.validation.test.ts` (4 MiB body) |
| Authentication and authorization | `src/api/security.test.ts`, `src/api/routes.test.ts`, `src/registry/authorization.test.ts` |
| Provider ownership enforcement | `src/api/security.test.ts`, `src/api/publication.test.ts`, `src/registry/authorization.test.ts` |
| Secret redaction / personal-data minimization | `src/api/security.test.ts`, `src/capture/redaction.test.ts`, `src/capture/security.test.ts`, `src/capture/explorer.test.ts` |
| Secure artifact storage and immutability | `src/registry/versions.test.ts`, `src/db/migrations.test.ts`, `src/publication/export.test.ts` |
| Audit logging for publication operations | `src/api/publication.test.ts`, `src/registry/versions.test.ts`, `src/registry/registry.test.ts`, `src/import/importer.test.ts` |

## 9. Residual risks and non-claims

- The controls above protect AttestBook's own process and stores. They do not make a
  deployment production-ready: TLS, edge rate limiting, database hardening, backups and
  secret distribution remain operator duties.
- AttestBook does not verify catalogue signatures, issuer trust, credential cryptography,
  protocol conformance or interoperability in this phase. A capture artifact, imported
  catalogue or issuer metadata document is evidence, not authority.
- The capture explorer and its sources are mock-backed. Retention behaviour for a real
  capture integration must be re-evaluated when that integration exists; it may need a
  durable store, deletion API and access-control model.
- Redaction is name-based and cannot guarantee that arbitrary personal data is removed when
  it appears under a preserved name or in a member name.
- No security finding here may be converted into a "verified secure" or "TS11 conformant"
  claim. The test suite demonstrates the controls that were executed; it does not prove the
  absence of unknown vulnerabilities.

## 10. References

- [Specification §15 and Phase 6](specification.md)
- [Write-API security model](security.md)
- [Remote import controls](import.md)
- [Issuer discovery controls](discovery.md)
- [Capture envelope, redaction and explorer](capture.md)
- [Registry immutability and artifact storage](registry.md)
- [API contract and error table](api.md)
- [Architecture §11 threat/risk outline](architecture.md)
- [Requirements-to-tests traceability](traceability.md)
- [Issue #52](https://github.com/ForkbombEu/credimi-attestbook/issues/52) and its
  predecessors #28–#51
