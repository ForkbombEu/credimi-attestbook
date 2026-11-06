# Versioned REST and OpenAPI contracts

**Status:** Phase 1 implementation of
[issue #34](https://github.com/ForkbombEu/credimi-attestbook/issues/34). This document
describes the public product API that the running server actually exposes, the error
envelope every route shares, the URL versioning and idempotency policies, and how the
OpenAPI 3.1 document is generated and validated in CI. It is not a TS11 catalogue API and
makes no standards-conformance claim.

**Authoritative spec:** [`docs/specification.md`](specification.md) §13, §15 and §16.
**Architecture:** [`docs/architecture.md`](architecture.md) §5 (HTTP/API boundary) and §6
(authorization and provider ownership).
**Services exposed:** [`docs/registry.md`](registry.md), [`docs/import.md`](import.md) and
[`docs/validation.md`](validation.md).
**Decisions:** [`docs/implementation-plan.md`](implementation-plan.md) D-10 (provisional
bearer authentication), D-14 (Hono + Zod/OpenAPI layer) and D-15 (CI jobs, including the
`openapi` job introduced by this slice).

## 1. Scope and boundaries

Implemented and exposed by this slice:

- public catalogue reads of rulebooks, attestation types, schema references and versions;
- the public provider projection used by the catalog UI (added by
  [issue #36](https://github.com/ForkbombEu/credimi-attestbook/issues/36));
- exact snapshot bytes and the content digest of one version;
- authenticated create of a draft rulebook (including rulebook-level schema references),
  create of a draft version and publication;
- public read, authenticated full replacement and public live validation of a draft working
  copy (added by [issue #40](https://github.com/ForkbombEu/credimi-attestbook/issues/40));
- deterministic version comparison, authenticated draft-snapshot refresh and public
  publication-readiness checks (added by
  [issue #41](https://github.com/ForkbombEu/credimi-attestbook/issues/41));
- authenticated import preview and import of URL/JSON sources;
- structural credential validation against a pinned rulebook version.

Deliberately **not** in this slice:

- the TS11 catalogue interface (`GET/PUT/DELETE /schemas`, JWS responses) — it must be
  implemented separately and exactly if a later issue adds it (architecture §5);
- issuer discovery, capture validation and validation-result persistence; no route pretends
  to offer them;
- provider-management HTTP routes, rate limiting and token expiry/rotation — future hardening;
  the implemented write-auth model is documented in [`docs/security.md`](security.md);
- stable retrieval/export of published artifacts, publication signing and the remaining
  FR-008 publication work — later slice
  ([issue #42](https://github.com/ForkbombEu/credimi-attestbook/issues/42)). The editor's
  draft document is a working-copy projection, not a version snapshot or a standards
  document. The catalog, rulebook-detail, credential playground and draft-editor views are
  documented in [`docs/ui.md`](ui.md); they are UI routes, not API routes.

Every handler calls the real registry, import or validation service. A service that is not
wired answers `503` with a typed code instead of a placeholder success response.

## 2. Versioning policy

- The product API lives under **`/api/v1`**. The major version is part of the URL; there is
  no separate version header.
- `GET /health` is an unversioned operational endpoint used by container health checks. It
  is not part of the product resource API and does not follow `/api/v1` path changes.
- Within `v1` the contract evolves **additively**: new optional response fields, new
  endpoints and new optional request members are allowed. Removing or renaming a field,
  changing a type or status, or making an optional request member required is a breaking
  change and requires `/api/v2`.
- The OpenAPI document's `info.version` tracks the contract document (currently `1.3.0`,
  additive after the lifecycle and comparison operations added by #41); it is separate from the package
  version reported by `/health`.
- Clients must tolerate unknown response fields. Unknown request members are ignored by the
  handlers except where the API deliberately projects a whitelist (internal registry
  metadata, provenance and the import identity can never be set through the API).

## 3. Resource surface

All paths below are prefixed with the API base. `auth` means an AttestBook provider bearer
token in the `Authorization: Bearer <token>` header. All operations are synchronous in Phase
1.

| Method | Path | Auth | Success | Purpose |
| --- | --- | --- | --- | --- |
| `GET` | `/health` | no | `200` | Liveness and build version (unversioned). |
| `GET` | `/api/v1/providers` | no | `200` | Public provider projection (`id`, `name`, `createdAt`) used by the catalog UI. |
| `GET` | `/api/v1/rulebooks` | no | `200` | Filtered, paginated catalogue listing. Query parameters: `providerId`, `status`, `limit` (default 50, max 100), `offset` (default 0). |
| `POST` | `/api/v1/rulebooks` | yes | `201` + `Location` | Create a draft rulebook, its attestation types and their schema references. An optional top-level `schemaReferences` array adds rulebook-level references. `sourceUrl` is optional and may be omitted or `null`. |
| `GET` | `/api/v1/rulebooks/{rulebookId}` | no | `200` | One rulebook's public product metadata. |
| `GET` | `/api/v1/rulebooks/{rulebookId}/draft` | no | `200` | The draft working copy as one editable document (metadata, attestation types with references, rulebook-level references). |
| `PUT` | `/api/v1/rulebooks/{rulebookId}/draft` | yes | `200` | Full replacement of the owning provider's draft working copy. `409 immutable` for a published/historical rulebook; frozen version snapshots and artifacts are never changed. |
| `POST` | `/api/v1/rulebooks/validate-draft` | no | `200` | Read-only live validation of an unsaved draft document: structural findings plus TS11 v1.0.1 adapter findings and explicit limitations. |
| `GET` | `/api/v1/rulebooks/{rulebookId}/attestations` | no | `200` | Attestation types of the working copy, each with its schema references. |
| `GET` | `/api/v1/rulebooks/{rulebookId}/schema-references` | no | `200` | Every schema reference of the working copy, including rulebook-level references. |
| `GET` | `/api/v1/rulebooks/{rulebookId}/versions` | no | `200` | Draft, published and historical versions in creation order. |
| `POST` | `/api/v1/rulebooks/{rulebookId}/versions` | yes | `201` + `Location` | Freeze the current working copy as a new draft version. |
| `GET` | `/api/v1/rulebooks/{rulebookId}/versions/{version}` | no | `200` | One version record and its content digest. |
| `GET` | `/api/v1/rulebooks/{rulebookId}/versions/{version}/content` | no | `200` | The exact snapshot bytes; `Content-Digest` and `ETag` carry the SHA-256. |
| `POST` | `/api/v1/rulebooks/{rulebookId}/versions/{version}/publish` | yes | `200` | Publish the owning provider's draft version. |
| `POST` | `/api/v1/rulebooks/{rulebookId}/versions/{version}/refresh` | yes | `200` | Re-snapshot a draft version from the current working copy; an unchanged snapshot is a no-op and published/historical versions answer `409 immutable`. |
| `GET` | `/api/v1/rulebooks/{rulebookId}/versions/{version}/compare?to={version}` | no | `200` | Deterministic structural comparison of two snapshots. Identity fields are excluded and changes are JSON Pointer paths sorted by path. |
| `GET` | `/api/v1/rulebooks/{rulebookId}/versions/{version}/publication-readiness` | no | `200` | Pre-publication checks and explicit limitations; never a publication or a conformance claim. |
| `POST` | `/api/v1/imports/preview` | yes | `200` | Bounded, read-only URL/JSON import preview. |
| `POST` | `/api/v1/imports` | yes | `200` | Import compatible entries as drafts, reporting per-entry dispositions. |
| `POST` | `/api/v1/credentials/validate` | no | `200` | Structural credential validation with per-dimension evidence. |

Representations are the public projection of the services: rulebook `provenance`,
`metadata` and `importKey`, attestation/schema-reference `metadata` and version `provenance`
are **never** returned. The import preview omits the importer-internal canonical document;
that document is derived data used only to commit an import.

### 3.1 Success envelopes

Single resources and action results use `{ "data": ... }`. The rulebook catalogue also
carries pagination:

```json
{
  "data": [{ "id": "...", "name": "...", "publicationStatus": "published" }],
  "pagination": { "limit": 50, "offset": 0, "total": 1 }
}
```

`limit` and `offset` are applied after the provider/status filters; `total` is the filtered
count. The Phase 1 registry listing is in-memory, which is acceptable for the bounded MVP
catalogue and is the documented limitation until a paginated store query exists.

`GET /api/v1/providers` uses the same `{ "data": [...] }` envelope. Its public projection
contains only `id`, `name` and `createdAt`: publication authority, registry metadata and
tokens are never exposed.

`POST /api/v1/rulebooks` and `POST /api/v1/rulebooks/{rulebookId}/versions` return `201` and
a `Location` header pointing at the canonical GET path. The other writes and imports return
`200` with the resulting representation.

### 3.2 Draft editor documents

The editor works on the normalized working copy through one document, not on a version
snapshot and not on a TS11/OWF wire document:

```json
{
  "id": "...",
  "providerId": "...",
  "name": "PID Rulebook",
  "description": "...",
  "sourceUrl": "https://issuer.example.org/rulebooks/pid",
  "applicableSpec": "ts11@1.0.1",
  "publicationStatus": "draft",
  "attestations": [
    {
      "name": "Person Identification Data",
      "attestationLoS": "iso_18045_high",
      "bindingType": "key",
      "supportedFormats": ["dc+sd-jwt"],
      "schemaReferences": [
        {
          "formatIdentifier": "dc+sd-jwt",
          "uri": "https://issuer.example.org/schemas/pid",
          "integrity": null
        }
      ]
    }
  ],
  "schemaReferences": [],
  "createdAt": "...",
  "updatedAt": "..."
}
```

`PUT /api/v1/rulebooks/{rulebookId}/draft` replaces the whole document in one transaction:
rulebook metadata, attestation types and both per-attestation and rulebook-level schema
references. Internal provenance, metadata, the import identity and publication state are not
accepted from the caller; a whitelist projection strips them first. An attestation matched by
name and a reference matched by attestation, `formatIdentifier` and `uri` keep their
registry-internal metadata and identity, so saving an imported draft unchanged does not
reset its importer provenance; new or changed entries start with `{}`. The write is
**idempotent** (the same document produces the same working copy), authorized by the owning
provider's bearer token, and allowed only while the rulebook's working copy status is
`draft`. Published and historical rulebooks answer `409 immutable`; an invalid document
answers `400` and leaves the previous working copy untouched. Editing a rulebook that has
published versions never mutates those snapshots or their content-addressed artifacts.

`POST /api/v1/rulebooks/validate-draft` takes the same document shape minus the registry
ids and writes nothing. Its report is:

```json
{
  "data": {
    "valid": false,
    "saveable": true,
    "profile": "ts11@1.0.1",
    "diagnostics": [
      {
        "severity": "error",
        "code": "invalid_member_value",
        "message": "format \"mso_mdoc\" is not listed in supportedFormats",
        "path": "attestations.0.schemaReferences.0.formatIdentifier"
      }
    ],
    "limitations": ["Live standards validation covers the TS11 v1.0.1 baseline; ..."]
  }
}
```

`valid` is true only when no structural or standards-level error is present. `saveable`
distinguishes structural failures, which block the `PUT`, from standards findings: the
registry stores profile enumerations as extensible text (decision D-5), so an out-of-baseline
value is reported but does not prevent persisting a work-in-progress draft. `profile` is
`null` when the document's `applicableSpec` is outside the implemented TS11 v1.0.1 live
checks. Standards validation projects each attestation type into a SchemaMeta document (the
source URL stands in for the rulebook URI; a fixed placeholder is used when no source URL is
set) and runs the real adapter, so the editor reports actual adapter findings rather than a
second hand-written rule set. It makes no TS11 or ETSI conformance claim.

### 3.3 Version comparison and publication readiness

`GET /api/v1/rulebooks/{rulebookId}/versions/{version}/compare?to={label}` compares the
authored content of two stored snapshots. The path version is the baseline, `to` is the
compared version, and both must belong to the same rulebook. The comparison is a structural
diff, not a byte diff: the snapshot identity fields (`format`, `rulebookId` and the version
label) are excluded, so two labels with the same content report `identical: true`. Object
keys are visited in sorted order and the change list is sorted by JSON Pointer path, so the
same two snapshots always produce the same response. Each change is `added`, `removed` or
`changed` and carries the `before` and/or `after` value.

`GET /api/v1/rulebooks/{rulebookId}/versions/{version}/publication-readiness` is a public,
read-only assessment. It executes the checks this build can actually run and reports them
individually:

| Check | Meaning |
| --- | --- |
| `draft_version` | Only a `draft` version can be published; published and historical artifacts are immutable. |
| `rulebook_status` | The rulebook working copy may move to `published`. A leftover draft on an already-published rulebook is not publishable until the next draft version reopens the working copy; a historical rulebook never is. |
| `snapshot_integrity` | The stored bytes still hash to the recorded SHA-256 digest. |
| `snapshot_current` | The draft snapshot still matches the current working copy; a stale draft must be refreshed. |
| `content_valid` | The snapshot content passes the same structural and TS11 v1.0.1 standards validation the editor runs. |
| `standards_profile` | Whether the profile baseline was actually validated; an unsupported profile is a warning, not a silent pass. |
| `attestation_types` | The rulebook defines at least one attestation type. |

`ready` is true only when no check reports `fail`. The response also carries explicit
`limitations`: remote schema documents, issuer trust, signing and interoperability are not
verified by these checks, and the assessment makes no TS11 or ETSI conformance claim.
Readiness is advisory for direct API callers; `POST .../publish` remains the authoritative
transition and still rejects a stale snapshot with `409 conflict`.

The rulebook-status check mirrors the publish transition exactly: a draft version cannot be
published while its rulebook is `published` (it answers `409 immutable`) or `historical`.
Creating the next version returns a `published` rulebook to `draft`, after which a leftover
draft version can be published and supersedes the current published version.

## 4. Errors

Every error body has the same shape:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "rulebookVersion must be a non-empty string",
    "details": { "reason": "invalid_json" }
  }
}
```

`code` is stable and machine-readable; `message` is safe to display and never contains a
bearer token, credential material, claim values or remote document bytes. `details` is
present where a stable sub-reason helps the client (currently import failures carry
`reason` and sometimes `path`).

| Source | Condition | HTTP | `error.code` |
| --- | --- | --- | --- |
| API body parsing | malformed/non-object JSON, invalid query or path value, malformed import envelope | `400` | `invalid_request` |
| Registry | `invalid_input` | `400` | `invalid_request` |
| Registry | missing, unknown or revoked token | `401` | `unauthorized` |
| Registry / publish handler | authenticated provider does not own the resource | `403` | `forbidden` |
| API / registry | resource does not exist | `404` | `not_found` |
| Registry | duplicate version label, stale draft snapshot | `409` | `conflict` |
| Registry / draft editor | published or historical rulebook cannot be edited | `409` | `immutable` |
| Registry / version handlers | published/historical immutability, historical republication, refresh of a frozen version | `409` | `immutable` |
| Body limit middleware | body larger than 4 MiB | `413` | `payload_too_large` |
| Import | unsafe/malformed/unsupported source, limits, refused import | `422` | `import_rejected` |
| Import | remote fetch failure, DNS failure, timeout, redirect limit, oversized remote response, unsupported remote status | `502` | `import_fetch_failed` |
| Import | `invalid_source`/`invalid_url` client input | `400` | `invalid_request` |
| API wiring | registry or validation not configured | `503` | `registry_unavailable` / `validation_unavailable` |
| API | unexpected failure | `500` | `internal_error` |

Unknown routes under any path answer `404` with `not_found` and the same envelope. The
mapping is implemented once in `src/api/errors.ts`; the OpenAPI document references the same
`ErrorEnvelope` component for every error response. Every `401` response also carries the
RFC 6750 challenge `WWW-Authenticate: Bearer realm="attestbook"`.

## 5. Authentication and authorization

The complete security model, including token lifecycle, the operation/ownership matrix and
secret-handling guarantees, is documented in [`docs/security.md`](security.md). This section
summarizes the HTTP contract.

- Reads are public, mirroring TS11's public-read requirement and the registry service's
  public read surface. The single exception is the import preview: a URL preview makes the
  server perform a bounded outbound fetch under the untrusted-import controls, so the HTTP
  route requires the same provider bearer token as import even though it writes nothing.
- Writes and the import preview require a provider bearer token. Tokens use the `att_`
  prefix and are stored only as SHA-256 hashes; the raw secret is returned once by operator
  provisioning, which is not an HTTP route. The API never echoes a token. The route table's
  `security` flag gates authentication centrally, before any request body is read, so a
  protected operation cannot forget the check. Missing, malformed, unknown and revoked
  credentials all answer `401` with `unauthorized` and the bearer challenge.
- Ownership is enforced by the registry service on the stored resource, not by the route.
  The publish route additionally authenticates and checks ownership before its idempotent
  replay check so a foreign or missing token cannot get a write-shaped success or probe
  version existence.
- `metadata`, `provenance` and `importKey` are registry-internal. The create handler
  projects a whitelist of public fields, so a caller cannot inject them even though the
  service type accepts them internally, and a rulebook is always attributed to the
  authenticated provider.

Rate limiting, token expiry/rotation and provider-administration routes are not implemented
in Phase 1; [`docs/security.md`](security.md) §8 records those limitations.

## 6. Idempotency policy

Phase 1 supports idempotency where the domain provides a deterministic identity; it does
**not** implement a generic `Idempotency-Key` request store.

| Operation | Policy |
| --- | --- |
| `POST /api/v1/imports` | **Idempotent for unchanged content.** Each source entry has a deterministic import identity, so re-importing the same normalized entry is a `200` with disposition `unchanged` and no write. Changed content is reported as a `conflict` and never overwrites local or published content. A URL preview's `retrievedAt` changes between calls, but that is provenance, not identity. |
| `POST .../versions/{version}/publish` | **Idempotent replay while the version is published:** the same call returns `200` and the published representation, and does not create another version. A version superseded to `historical` answers `409 immutable` and is never resurrected. |
| `POST .../versions/{version}/refresh` | **Idempotent for unchanged content:** re-snapshotting an unchanged working copy returns `200` with the same digest and writes nothing. A changed working copy produces a new digest; a published/historical version answers `409 immutable`. |
| `GET .../versions/{version}/compare` | Read-only; safe to retry. |
| `GET .../versions/{version}/publication-readiness` | Read-only; safe to retry. |
| `POST /api/v1/rulebooks` | **Not idempotent.** There is no server-side deduplication of authored rulebooks; a retried request can create a second draft. Clients that need a stable identity should use the import path or reconcile by `id`. |
| `PUT /api/v1/rulebooks/{rulebookId}/draft` | **Idempotent full replacement.** The same authorized document produces the same working copy; a retried request does not create a duplicate rulebook. A published/historical rulebook still answers `409 immutable`. |
| `POST /api/v1/rulebooks/validate-draft` | Read-only and side-effect free; safe to retry. |
| `POST /api/v1/rulebooks/{rulebookId}/versions` | **Not idempotent.** A duplicate label is `409 conflict`; the client chooses the next label after a conflict. |
| `POST /api/v1/imports/preview` | Read-only and side-effect free, but authenticated because a URL preview performs a bounded outbound fetch; safe to retry. |
| `POST /api/v1/credentials/validate` | Read-only; safe to retry. |

The import policy is the substantive idempotency mechanism implemented in Phase 1
([`docs/import.md`](import.md) §5). A generic idempotency-key store is deliberately deferred:
it needs a durable request/response store and a retention policy, and must not be invented
as an untested placeholder.

## 7. OpenAPI generation and validation

The OpenAPI 3.1 document is **generated**, not hand-maintained:

- `src/api/routes.ts` declares the route table (`API_ROUTES`), its request/response
  components, security and status codes, and registers those same paths on Hono. The
  handler map is typed `Record<ApiOperationId, ...>`, so a route without a handler is a
  compile-time error.
- `src/api/schemas.ts` defines the request/response shapes with Zod. `componentJsonSchema`
  converts each to JSON Schema 2020-12 for OpenAPI 3.1, and the same schemas validate the
  actual response bodies in the contract tests.
- `src/api/openapi.ts` builds `components.schemas`, `paths` and `securitySchemes` from those
  two sources.

Validation runs in two places:

1. `src/api/openapi.test.ts` (in the `test` job) validates the generated document against
   the **official OpenAPI 3.1 JSON Schema**, compiles every component as JSON Schema
   2020-12, and compares the documented operations with `app.routes` from the app the tests
   exercise. It also checks that every path template parameter is declared and that every
   write operation uses the bearer scheme.
2. `bun run openapi:check` (in the `openapi` CI job) performs the document/schema validation
   standalone, so a broken contract fails CI even if a route test is skipped.

The official schema is vendored at `src/api/oas-3.1-schema.json` from
<https://spec.openapis.org/oas/3.1/schema/2022-10-07> (OpenAPI Specification 3.1.0,
Apache-2.0). The loader rewrites its four `$dynamicRef: "#meta"` references to the
equivalent static `$defs/schema` reference because Ajv 8.20.0 resolves that dynamic
reference to the document root; the vendored bytes themselves are unchanged. This is a
validator workaround, not a contract change.

## 8. Verification

Run the relevant checks from the repository root:

```
bun run openapi:check   # generated OpenAPI 3.1 document validates
bun test src/api        # contract, success and error coverage
bun run check           # formatting, lint, strict typecheck and all tests
```

The API tests use real temporary SQLite databases, real registry services, the real import
pipeline (offline JSON sources only) and a genuinely signed SD-JWT VC fixture. They do not
claim coverage of HTTP rate limits or provider-management routes. The catalog UI has its own
component and browser tests described in [`docs/ui.md`](ui.md).

## 9. Limitations and next slices

- Catalogue pagination is applied in memory after filtering; versions and attestations are
  returned in full. A paginated store query is a later registry slice.
- No generic `Idempotency-Key` store, no request-body content-type enforcement beyond JSON
  parsing, and no HTTP rate limits for reads, preview or import. Rate limiting is still
  missing for preview and import, so an authenticated provider can repeat a bounded outbound
  fetch; the import service's own size, time, redirect and fan-out limits still apply to
  every call. Rate limiting, token expiry/rotation and provider-administration routes remain
  future hardening work documented in [`docs/security.md`](security.md) §8.
- Import previews expose a projection (no internal canonical document) and do not persist a
  preview; an import re-runs the preview under the same controls.
- Validation results are returned synchronously and are not persisted
  (`GET /api/v1/validations/{id}` does not exist in this slice; the specification lists it as
  a suggested resource, not an implemented one).
- The TS11 catalogue API, issuer discovery and capture routes remain unimplemented and are
  absent from the OpenAPI document rather than present as placeholders.
