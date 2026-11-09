# Credimi integration adapter: rulebook selection, pinned validation and evidence

**Status:** Phase 5 implementation for
[issue #49](https://github.com/ForkbombEu/credimi-attestbook/issues/49) (specification
FR-020, acceptance criterion AC-15). It exposes a standalone client and stable contracts for
Credimi to select a rulebook, pin one exact version, request credential validation and
correlate capture evidence. It adds no Credimi runtime dependency, reads no AttestBook
database and makes no orchestration, protocol or interoperability claim.

**Authoritative spec:** [`docs/specification.md`](specification.md) §12 (FR-020) and §11
(FR-015…FR-019).
**API contract:** [`docs/api.md`](api.md) — the adapter consumes the public `/api/v1` API.
**Validation evidence:** [`docs/validation.md`](validation.md) and
[`docs/traceability.md`](traceability.md).
**Capture evidence:** [`docs/capture.md`](capture.md) §9.
**Related issues:** #50 (headless-wallet comparison evidence) and #51 (reproducible continuous
conformance) build on this slice; neither is implemented here.

## 1. Purpose and boundaries

Credimi is AttestBook's primary external consumer (spec §12). It must be able to:

1. list available rulebooks;
2. select an attestation type;
3. pin one rulebook version;
4. request credential validation;
5. retrieve structured results;
6. associate results with a test execution;
7. display rulebook conformance evidence; and
8. keep protocol and interoperability observations separate.

This slice delivers 1–6 through the public HTTP API plus a reference client; displaying the
evidence (7) remains Credimi's UI, fed by the structured responses. AttestBook does **not**
become a second orchestration platform:

- AttestBook never queries Credimi, never starts a test execution and never mints a
  correlation or test-execution identifier. `testExecutionRef` and `correlationId` are opaque,
  caller-owned values supplied by the capture evidence.
- The client is ordinary HTTP JSON. It never reads AttestBook's SQLite database and has no
  dependency on Credimi's Temporal, StepCI or PocketBase runtime.
- Validation is structural only. A returned dimension is a check AttestBook executed; the
  cryptographic, issuer-trust, protocol and interoperability dimensions are reported
  `NOT_TESTED` or `NOT_APPLICABLE`, never PASS (FR-012).

The reference implementation is the TypeScript client in
[`src/integration/credimi/`](https://github.com/ForkbombEu/credimi-attestbook/tree/main/src/integration/credimi).
A Credimi adapter written in Go (or any other language) implements the same documented HTTP
contract; nothing in the contract depends on TypeScript.

## 2. Contract version and the rulebook pin

The adapter contract is version **1** (`CREDIMI_ADAPTER_CONTRACT_VERSION`). The HTTP API
lives under `/api/v1` and follows the additive evolution rule in [`docs/api.md`](api.md) §2:
new optional response members and new endpoints are allowed; removing or renaming a member,
changing a type or making an optional request member required needs a new major version.
Clients tolerate unknown response members; the reference client parses known members with the
API's own Zod schemas, so an unexpected shape becomes a typed failure rather than a silently
wrong result.

A **rulebook pin** is the unit of reproducibility. It is a small JSON value object that
Credimi may persist and pass back; it is not an AttestBook resource and AttestBook stores no
pin:

```json
{
  "kind": "attestbook.rulebook-pin@1",
  "rulebookId": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "version": "1.0",
  "contentDigest": "<64 lowercase hex characters>",
  "specVersion": "ts11@1.0.1",
  "attestationType": "PID"
}
```

- The pin is resolved from the authoritative version read
  (`GET /api/v1/rulebooks/{rulebookId}/versions/{version}`), never from a "latest version"
  shortcut. `contentDigest` is the lowercase hex SHA-256 of the immutable snapshot bytes that
  version read reports.
- Every validation and capture-correlation request names `rulebookId`, the exact
  `rulebookVersion` and the `attestationType`. There is no version range and no implicit
  upgrade.
- A capture correlation carries the pinned `contentDigest` as `rulebookDigest`. The server
  compares it with the snapshot it just validated and answers `409 conflict` **before**
  recording, so a stale pin cannot overwrite an existing correlation with different bytes.
- The adapter verifies the evidence the server returns against the pin: the rulebook
  identifier, version, snapshot digest and attestation type must all match, and the evidence
  must carry `digestVerified: true`. Any difference raises `pin_mismatch`; the response is
  rejected, never adjusted.
- A draft version may be pinned, but a later `refresh` changes its snapshot digest. The next
  validation then raises `pin_mismatch` instead of silently validating different bytes. For
  long-lived reproducibility, pin a published or historical version.
- Resolving a pin does not assert that the attestation type exists in the snapshot. The
  validation call resolves the type from the exact snapshot (not from the current draft), and
  an unknown type is a typed `not_found`; nothing is invented or silently substituted.

## 3. Operations and wire contract

The reference client exposes one method per operation. Every operation is synchronous HTTP
JSON; there is no polling, queue or callback.

| Client method | HTTP operation | Auth | Purpose |
| --- | --- | --- | --- |
| `listRulebooks(query?)` | `GET /api/v1/rulebooks` | no | Catalogue page; filters `providerId`, `status`, `limit`, `offset`. |
| `getRulebook(rulebookId)` | `GET /api/v1/rulebooks/{rulebookId}` | no | One rulebook's public metadata. |
| `listRulebookAttestations(rulebookId)` | `GET /api/v1/rulebooks/{rulebookId}/attestations` | no | Attestation types with their schema references, for selection. |
| `listRulebookVersions(rulebookId)` | `GET /api/v1/rulebooks/{rulebookId}/versions` | no | Draft, published and historical versions in creation order. |
| `getRulebookVersion(rulebookId, version)` | `GET /api/v1/rulebooks/{rulebookId}/versions/{version}` | no | Exact version record and its snapshot digest. |
| `pinRulebook(input)` | `GET /api/v1/rulebooks/{rulebookId}/versions/{version}` | no | Resolves and returns an `attestbook.rulebook-pin@1` from the authoritative version record. |
| `validateCredential(input)` | `POST /api/v1/credentials/validate` | no | Structural validation against the pinned version. |
| `listCaptures(query?)` | `GET /api/v1/captures` | no | Capture-evidence page with explicit gaps. |
| `getCapture(captureId)` | `GET /api/v1/captures/{captureId}` | no | One capture, its redacted projection and linked validation. |
| `correlateCapture(input)` | `POST /api/v1/captures/{captureId}/validate` | yes | Binds a captured credential to the pinned version and records the result. |

`GET /api/v1/rulebooks` also accepts `status=draft|published|historical`; the other pages are
bounded by `limit` (1–100, default 50) and `offset` (≥ 0). Successful responses are JSON; the
catalogue, rulebook, attestation and version reads use a `{ "data": ... }` or
`{ "data": [...], "pagination": ... }` envelope, and the capture list uses
`{ "data": [...], "pagination": ... }` directly.

### 3.1 Selecting a rulebook and attestation type

```
GET /api/v1/rulebooks?status=published&limit=50
GET /api/v1/rulebooks/{rulebookId}/attestations
GET /api/v1/rulebooks/{rulebookId}/versions
```

The catalogue is the public projection: provider assignment, provenance and registry-internal
metadata are not returned. The attestation list is the editable/public projection of the
working copy and carries each attestation's schema references; the selected attestation type
name is what later requests pin.

### 3.2 Requesting validation

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

`schemaDocuments` is optional. When supplied, each document must match the corresponding
pinned reference URI and its `sha256` SRI value before it is applied; the rulebook snapshot is
never changed by the request. The response carries:

- `rulebook` — the pinned identifier, name, version, digest, `digestVerified: true`, spec
  version and status;
- `attestation`, `credential` and `schemaReferences` evidence;
- the eight ordered `dimensions`, each with `status`, `applicable`, `executed`, findings and
  non-sensitive evidence;
- flattened `violations`, explicit `limitations` and a conservative `overallStatus`.

A structural `PASS` of the executed dimensions is not an overall PASS while cryptography and
trust remain unexecuted; clients must read the limitation list rather than the aggregate
alone.

### 3.3 Correlating capture evidence with a test execution

```json
POST /api/v1/captures/{captureId}/validate
Authorization: Bearer <provider token>

{
  "rulebookId": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "rulebookVersion": "1.0",
  "attestationType": "PID",
  "rulebookDigest": "<the pin's contentDigest>"
}
```

If `rulebookDigest` is supplied and the version snapshot no longer has that digest, the server
refuses with `409 conflict` before changing the recorded correlation. The response is the
recorded correlation:

```json
{
  "captureId": "<capture id>",
  "correlationId": "<source-declared correlation id>",
  "testExecutionRef": "<opaque Credimi test execution>",
  "rulebook": {
    "rulebookId": "0f8fad5b-d9cb-469f-a165-70867728950e",
    "rulebookName": "PID Rulebook",
    "version": "1.0",
    "contentDigest": "<snapshot digest>",
    "digestVerified": true,
    "specVersion": "ts11@1.0.1",
    "rulebookStatus": "published",
    "attestationType": "PID",
    "boundAt": "2026-01-01T00:00:00.000Z"
  },
  "validation": { "...": "the full structural validation result" }
}
```

The correlation is a write: it records the binding server-side and is visible to every
reader of that capture, so it requires a provider bearer token. The adapter verifies both the
binding and the nested validation result against the pin. The `captureId`, `correlationId`
and `testExecutionRef` remain opaque strings owned by Credimi; AttestBook does not resolve
them.

`GET /api/v1/captures/{captureId}` then returns the same correlation with the redacted
artifact projection, the evidence timeline and explicit `evidenceGaps` (for example
`no_rulebook_binding`, `validation_not_run`, `external_artifact_not_fetched`). Absence of
evidence is stated, never inferred as success.

## 4. Failure and timeout handling

The client maps every failure to a stable `CredimiAdapterError.code`; `status` and
`serverCode` carry secondary diagnostics and may be `null` for transport failures. Error
messages name the operation and field at fault and never contain a credential, a bearer token
or a response body.

| Code | Meaning | Retryable |
| --- | --- | --- |
| `invalid_configuration` | A client option is out of its documented range or shape. | No |
| `invalid_request` | A local argument (identifier, page bound, pin, credential) is invalid. | No |
| `authorization_required` | A capture correlation was attempted without a provider token. | No |
| `network_error` | No response was received (connection failure, reset, aborted read). | Yes |
| `timeout` | The per-attempt timeout elapsed; the request was aborted. | Yes |
| `response_too_large` | The streamed response exceeded the configured byte bound. | No |
| `invalid_response` | The body is not JSON or does not match the documented contract. | No |
| `pin_mismatch` | Returned evidence is not exactly the pinned rulebook/version/digest/type. | No |
| `unauthorized` | HTTP 401 from AttestBook. | No |
| `forbidden` | HTTP 403. | No |
| `not_found` | HTTP 404 (unknown rulebook, version, attestation type or capture). | No |
| `conflict` | HTTP 409 (evidence AttestBook refuses, or a stale `rulebookDigest` refused before recording). | No |
| `invalid_input` | HTTP 400/422 with AttestBook's typed error envelope. | No |
| `payload_too_large` | HTTP 413. | No |
| `unavailable` | HTTP 429/502/503/504 — a transient server condition. | Yes |
| `internal_error` | HTTP 500. | No |
| `http_error` | Any other non-2xx status. | No |

Transport policy (options and bounds are also exported as constants):

| Option | Default | Accepted |
| --- | --- | --- |
| `timeoutMs` | 10 000 ms | 1–120 000 ms, per attempt |
| `retries` | 1 | 0–3, **GET reads only** |
| `retryDelayMs` | 150 ms | 0–10 000 ms, fixed delay |
| `maxResponseBytes` | 8 MiB | 1 byte–32 MiB |

- The timeout covers the fetch and the body read; an exceeded timeout aborts the request
  through an `AbortController` and raises `timeout`.
- Automatic retries apply only to idempotent reads. Credential validation is side-effect free
  and the API documents it as safe to retry, but the client does not retry it automatically;
  a caller may retry after a `timeout`/`network_error`. Capture correlation is a write and is
  always single-shot.
- Every response body is read with a hard byte bound while it streams. A response larger
  than the configured bound raises `response_too_large` instead of being buffered whole.
- Redirects are refused (`redirect: 'error'`). A misconfigured or compromised server cannot
  silently move an authenticated request to another origin; the failure surfaces as
  `network_error`.

## 5. Using the client

```ts
import { CredimiAdapter } from './src/integration/credimi'

const client = new CredimiAdapter({
  baseUrl: 'https://attestbook.example',
  token: process.env.ATTESTBOOK_PROVIDER_TOKEN, // only needed for capture correlation
  timeoutMs: 10_000,
})

const page = await client.listRulebooks({ status: 'published' })
const attestations = await client.listRulebookAttestations(page.data[0].id)

const pin = await client.pinRulebook({
  rulebookId: page.data[0].id,
  version: '1.0',
  attestationType: attestations[0].name,
})

const evidence = await client.validateCredential({ pin, credential })
const correlation = await client.correlateCapture({ captureId, pin })

console.log(pin.contentDigest, evidence.overallStatus, correlation.testExecutionRef)
```

Store the pin next to the Credimi test execution. Passing it back on every request is what
makes a later run reproducible; do not re-resolve "the latest version".

## 6. Testing and verification

```
bun test src/integration          # adapter unit and real-server tests
bun run typecheck                 # strict TypeScript
bun run check                     # formatting, lint, typecheck and all tests
```

`src/integration/credimi/client.test.ts` exercises the transport boundary with an injected
`fetch`: configuration bounds, query/path construction, bearer handling, HTTP status mapping,
non-JSON error bodies, malformed success bodies, the response-size bound, retry bounds and
the timeout abort, plus direct pin-evidence verification. `src/integration/credimi/server.test.ts`
runs the client against the real Hono application over a loopback socket and a real migrated
SQLite registry, covering the complete selection → pin → validation → capture-correlation
flow, stale-pin rejection, an unknown attestation type, a rejected bearer token, a
real-socket timeout and an unreachable server. No test contacts a live capture component or
Credimi.

## 7. Limitations and non-claims

- **No Credimi runtime is bundled.** The adapter does not import or spawn Temporal, StepCI,
  PocketBase or any Credimi package. AttestBook remains deployable without Credimi
  (AC-01; `src/dependencies.test.ts`).
- **No orchestration.** AttestBook does not start, schedule or observe a Credimi test
  execution; it validates artifacts Credimi submits and stores correlations Credimi records.
- **Capture evidence is mock-backed in this build.** The capture explorer serves the
  deterministic local mock source; no live `capture-issuer`/`capture-verifier` endpoint is
  contacted, external artifact references are not fetched and capture evidence is held in
  memory. The correlation contract is stable, but a live capture integration is not claimed
  operational.
- **Structural validation only.** Cryptographic signature/proof verification, issuer trust,
  status-list checking, protocol conformance and interoperability are not executed and are
  never reported PASS. A result must not be read as ETSI, TS11 or interoperability
  conformance.
- **Protocol comparison is not implemented here.** Distinguishing rulebook findings from
  protocol/interoperability observations for a headless-wallet workflow is issue
  [#50](https://github.com/ForkbombEu/credimi-attestbook/issues/50); reproducible recurring
  conformance evidence is issue
  [#51](https://github.com/ForkbombEu/credimi-attestbook/issues/51).
- **No pin store.** AttestBook does not persist pins; Credimi owns the pin and its retention.
- **No live Credimi adapter in this repository.** Credimi's Go integration must implement the
  documented HTTP contract; this repository provides the contract and the tested reference
  client, not Credimi's deployment.
