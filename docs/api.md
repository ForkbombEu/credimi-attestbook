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
- stable export of published/historical artifacts and a public publication export manifest
  with the artifact digest, bounded provenance and an explicit signature boundary (added by
  [issue #42](https://github.com/ForkbombEu/credimi-attestbook/issues/42));
- authenticated import preview and import of URL/JSON sources;
- authenticated issuer metadata discovery and candidate rulebook association (added by
  [issue #43](https://github.com/ForkbombEu/credimi-attestbook/issues/43));
- public rulebook-driven unsigned issuer fixture generation (added by
  [issue #44](https://github.com/ForkbombEu/credimi-attestbook/issues/44));
- structural credential validation against a pinned rulebook version.

The public API is the integration boundary for Credimi. The standalone adapter documented in
[`docs/credimi-integration.md`](credimi-integration.md) (issue #49) consumes these routes only:
it exposes rulebook selection, version pinning, credential validation and capture-evidence
correlation without database access or a Credimi runtime dependency. It adds no route.

Deliberately **not** in this slice:

- the TS11 catalogue interface (`GET/PUT/DELETE /schemas`, JWS responses) — it must be
  implemented separately and exactly if a later issue adds it (architecture §5);
- capture validation and validation-result persistence; no route pretends to offer them;
- provider-management HTTP routes, rate limiting and token expiry/rotation — future hardening;
  the implemented write-auth model is documented in [`docs/security.md`](security.md);
- a publication signature: no export claims one. OWF 0.5.4 signs only a bare OWF-profile
  `SchemaMeta` compact JWS and does not implement the TS11 v1.0.1 catalogue-response JWS,
  while a version snapshot is not a `SchemaMeta` document; the manifest reports this boundary
  instead of inventing proprietary signing semantics
  ([`docs/standards.md`](standards.md) §5.8 and §6.2). The editor's draft document is a
  working-copy projection, not a version snapshot or a standards document. The catalog,
  rulebook-detail, credential playground and draft-editor views are documented in
  [`docs/ui.md`](ui.md); they are UI routes, not API routes.

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
- The OpenAPI document's `info.version` tracks the contract document (currently `1.7.0`,
  additive after the lifecycle and comparison operations added by #41, the publication
  export operations added by #42, issuer discovery added by #43, issuer fixture generation
  added by #44, the mock-backed capture explorer added by #48 and the optional pinned
  correlation digest added by #49); it is separate from the package version reported by
  `/health`.
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
| `GET` | `/api/v1/rulebooks/{rulebookId}/versions/{version}/export` | no | `200` | Download the exact immutable bytes of a published or historical artifact; `Content-Digest`, `ETag` and an attachment filename are returned. Drafts answer `409 conflict`. |
| `GET` | `/api/v1/rulebooks/{rulebookId}/versions/{version}/export/manifest` | no | `200` | Publication export manifest: frozen identity, digest, bounded provenance, integrity result and the explicit signature boundary. Drafts answer `409 conflict`. |
| `POST` | `/api/v1/imports/preview` | yes | `200` | Bounded, read-only URL/JSON import preview. |
| `POST` | `/api/v1/imports` | yes | `200` | Import compatible entries as drafts, reporting per-entry dispositions. |
| `POST` | `/api/v1/issuers/discover` | yes | `200` | Bounded OpenID4VCI issuer metadata discovery with candidate rulebook associations, ambiguity and unmatched reporting. |
| `POST` | `/api/v1/credentials/validate` | no | `200` | Structural credential validation with per-dimension evidence. |
| `GET` | `/api/v1/captures` | no | `200` | Mock-backed page of normalized capture evidence with correlation identifiers and explicit evidence gaps. |
| `GET` | `/api/v1/captures/{captureId}` | no | `200` | One capture with its redacted artifact projection, evidence timeline and the validation linked to its pinned rulebook version. |
| `POST` | `/api/v1/captures/{captureId}/validate` | yes | `200` | Correlate a captured issued credential with a pinned rulebook version and record the structural validation result. |

Representations are the public projection of the services: rulebook `provenance`,
`metadata` and `importKey`, attestation/schema-reference `metadata` and version `provenance`
are **never** returned by the catalogue and version reads. The publication export manifest is
the one deliberate exception, because FR-008 requires published artifacts to be associated
with provenance metadata; it carries a bounded projection (`adapter`, `sourceUrl`,
`contentDigest`, `retrievedAt`, `profile`, `conformance`, `importedAt`) rather than the raw
version provenance, so import-internal and untrusted source fields never reach the public
manifest. The manifest is a product artifact, not a standards document. The import preview
omits the importer-internal canonical document; that document is derived data used only to
commit an import.

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

### 3.4 Publication export and integrity

`GET /api/v1/rulebooks/{rulebookId}/versions/{version}/export` is the publication-grade
retrieval route. It returns the exact stored bytes of a **published or historical** version,
never a re-serialization: the bytes must still hash to the recorded digest or the request
fails as a server fault. `Content-Digest` carries the RFC 9530 structured SHA-256 value,
`ETag` carries the quoted hex digest, and `Content-Disposition` names the download from the
frozen rulebook name and version label. A draft version is a working copy, not a publication
artifact, and answers `409 conflict`. The existing `/content` route remains the unbounded
exact-bytes read for any version, including drafts.

`GET /api/v1/rulebooks/{rulebookId}/versions/{version}/export/manifest` describes the same
artifact without copying it:

```json
{
  "data": {
    "format": "attestbook.publication-export@1",
    "rulebookId": "...",
    "providerId": "...",
    "version": "1.0",
    "status": "published",
    "name": "PID Rulebook",
    "sourceUrl": "https://issuer.example.org/rulebooks/pid",
    "specVersion": "ts11@1.0.1",
    "mediaType": "application/vnd.attestbook.rulebook-version+json",
    "contentDigest": "…64 lowercase hex characters…",
    "byteLength": 1234,
    "createdAt": "…",
    "publishedAt": "…",
    "provenance": {},
    "integrity": { "algorithm": "sha256", "verified": true },
    "signature": {
      "status": "unsupported",
      "reason": "OWF 0.5.4 signs only a bare OWF-profile SchemaMeta compact JWS. …"
    },
    "limitations": ["…"]
  }
}
```

Every manifest field comes from frozen data: the version row, a bounded projection of its
provenance and the snapshot document. The rulebook's mutable working copy is never read, so the
manifest for a published version is identical across repeated exports and is unaffected by later
edits, a new draft version or supersession. `status` changes from `published` to `historical`
when a newer version supersedes it; the digest, publication time, bytes and bounded provenance
do not change.

The manifest makes **no signature claim**. The mandatory OWF package provides only a bare
OWF-profile `SchemaMeta` compact JWS (`signSchemaMeta`/`verifySchemaMeta`), which the
standards adapter already uses for that supported operation
([`docs/standards-adapter.md`](standards-adapter.md) §6). A version snapshot is not a
`SchemaMeta` document and OWF 0.5.4 does not implement the TS11 v1.0.1 catalogue-response
JWS, so the export reports `signature.status: "unsupported"` instead of inventing a
proprietary signature. Integrity is the SHA-256 digest, which consumers must recompute over
the exported bytes.

Publication itself stays an authenticated, owner-scoped transition
(`POST .../publish`); the export reads are public, matching the public catalogue reads. Each
publication writes the `version.publish` audit row with the actor provider, version,
digest, profile and superseded versions, in the same transaction as the state change.

### 3.5 Issuer metadata discovery

`POST /api/v1/issuers/discover` is the authenticated, read-only FR-006 slice. The request is
the Credential Issuer Identifier:

```json
{ "credentialIssuer": "https://issuer.example" }
```

Discovery inserts `/.well-known/openid-credential-issuer` into the issuer identifier between
the host and the path (OpenID4VCI 1.0 §12.2.2), then retrieves it under the import pipeline's
§15 controls (https-only URL validation, public-address pinning, redirect re-validation, total
deadline, response-size and JSON-shape bounds), validates the members it uses and extracts the
supported credential configurations. An explicit earlier appended-path metadata URL is also
accepted for older issuers. It understands the OpenID4VCI 1.0 `credential_configurations_supported`
object and the earlier `credentials_supported` shape.

Each configuration reports its `format`, type identifiers (`vct`/`doctype`/legacy `type`;
`vct` is a case-sensitive StringOrURI and may be a URN), display name, exposed schema references
and a `mapping` with `status`, `candidates` and, for an unmatched configuration, a `reason`.
`matched` carries exactly one candidate, `ambiguous` more than one and `unmatched` none. Every
candidate is an **exact pin**:

```json
{
  "rulebookId": "…",
  "rulebookName": "PID Rulebook",
  "version": "1.0",
  "contentDigest": "…64 lowercase hex characters…",
  "specVersion": "ts11@1.0.1"
}
```

Only published or historical rulebook versions are candidates; drafts are mutable and never
used. Several matching versions of the same rulebook collapse to its current version, so a
single history does not look ambiguous; matching several rulebooks is reported as ambiguous
rather than resolved by a policy the API has not been given. The result also carries the
retrieval provenance (`metadataUrl`, redirects, retrieval time, content type, byte length and
the SHA-256 of the exact bytes), bounded issuer fields, aggregate counts, diagnostics and
limitations.

The route writes nothing: discovered issuers, metadata snapshots and explicit manual mappings
are not persisted in this slice. Issuer metadata is never treated as rulebook content, no
exposed reference is fetched and no signature, trust or conformance result is derived from it.
The discovery contract is documented in [`docs/discovery.md`](discovery.md).

### 3.6 Issuer fixtures

`POST /api/v1/issuers/fixtures` is the public FR-013 slice. It synthesizes an **unsigned**
credential claim payload from the JSON Schema 2020-12 attribute constraints that one pinned
rulebook version references. It is not a credential issuer: the payload carries
`kind: "attestbook.unsigned-issuer-fixture@1"`, `signed: false` and `issued: false`.

```json
{
  "rulebookId": "…",
  "rulebookVersion": "1.0",
  "attestationType": "PID",
  "format": "dc+sd-jwt",
  "schemaDocuments": [
    { "uri": "https://issuer.example/schema/pid.json", "content": "{ … }" }
  ],
  "overrides": [{ "path": "/given_name", "value": "Ada" }]
}
```

The caller supplies the exact schema document bytes, exactly as for credential validation.
Each URI must be a schema reference of the selected attestation type in that version (and of
the requested `format`, when present), and its sha256 SRI value must match before the
document can ground a payload. References without a verifiable pin, references without a
supplied document and SD-JWT VC Type Metadata references are reported and never used; when
no reference is usable the route answers `400 invalid_request` rather than an ungrounded
fixture.

The response carries the pinned rulebook evidence, the effective attribute definitions (JSON
Pointer, required flag, types and supported constraints), the generated payload, an explicit
payload-validation status against the supplied documents, the applied overrides, labelled
negative cases and limitations. `overrides` replace existing attributes by JSON Pointer and
are re-validated; an override that deliberately violates a constraint yields
`payloadValidation.status: "FAIL"` with findings instead of pretending success. Negative cases
are derived from the supported constraints in deterministic order, each verified to fail the
supplied documents before it is returned. Their `id` is stable (`<category>:<path>`) and
`expected` is always `FAIL`.

Compilation, synthesis, payload evaluation and negative-case verification run in the same
resource-bounded sandbox as credential validation, with a shared concurrency limit. The route
writes nothing and performs no network request. A timeout, memory or output limit answers
`400 invalid_request`; a busy or unavailable sandbox answers `503 fixture_unavailable`. The
contract, supported synthesis subset and non-claims are documented in
[`docs/fixtures.md`](fixtures.md).

### 3.7 Verifier constraints and OpenID4VP-aware mappings

`POST /api/v1/verifiers/constraints` is the public FR-014 slice. It returns the **typed
attribute and format constraints** of one pinned rulebook version and the verifier-policy
interfaces AttestBook can map them to. It is not an OpenID4VP endpoint: the DCQL mapping is an
explicitly partial query fragment and the result carries no proof or protocol result.

```json
{
  "rulebookId": "…",
  "rulebookVersion": "1.0",
  "attestationType": "PID",
  "format": "dc+sd-jwt",
  "schemaDocuments": [
    { "uri": "https://issuer.example/schema/pid.json", "content": "{ … }" }
  ]
}
```

`format` and `schemaDocuments` are optional. Without `format`, every supported format of the
attestation type is resolved. The caller supplies the exact schema document bytes, as for
credential validation and fixtures; each URI must be a schema reference of the selected
attestation type (and of the requested `format`, when present), and its sha256 SRI value must
match before the document can ground constraints. An unpinned reference, an unsupplied
document and SD-JWT VC Type Metadata are reported and never used; a supplied document that
does not match its pin, a foreign URI or an unbounded document is `400 invalid_request`.

Each format reports a `grounding` state, its schema references, the typed attributes (JSON
Pointer, required flag, JSON types, extracted constraints, unresolved keywords and a DCQL claim
path) and a `dcql` mapping. The DCQL mapping has `complete: false`; its `credentialQuery`
contains only the format and claim paths of a `dc+sd-jwt`/`mso_mdoc` rulebook, and every
unexpressible constraint is listed in `unsupported` with a stable `code`, `scope` and reason.
The pinned snapshot has no `vct`/`doctype`, no trusted authorities and no protocol material, so
those gaps are reported instead of fabricated. `policyInterfaces` enumerates the supported
native constraints, the partial DCQL interface and the unsupported Presentation Exchange
interface. `nonClaims` states `presentationRequest: false`, `proof: false` and the
cryptographic/trust/protocol/interoperability dimensions as `NOT_TESTED`.

The route writes nothing and performs no network request. The contract, supported extraction
subset and non-claims are documented in [`docs/verifier.md`](verifier.md).

### 3.8 Capture explorer and pinned-rulebook correlation

`GET /api/v1/captures` is the read model behind UI-006 and FR-019. It is **mock-backed**: the
server seeds it from the deterministic local `MockCaptureSource`s, every entry carries
`source.transport: "mock"`, and no live `capture-issuer`/`capture-verifier` endpoint is
contacted. Pagination is `limit` (default 50, maximum 100) and `offset`.

A list entry is the normalized metadata envelope joined with the exact rulebook version of a
recorded validation and with explicit gaps:

```json
{
  "captureId": "e2e-issued-credential-capture",
  "correlationId": "credimi-e2e-correlation-48",
  "source": { "sourceId": "mock-capture-issuer", "component": "capture-issuer", "transport": "mock", "description": "…" },
  "provenance": { "capturedAt": "2026-11-05T09:48:23Z", "receivedAt": "…" },
  "interactionType": "issuance",
  "protocol": "openid4vci",
  "credentialFormat": "dc+sd-jwt",
  "artifactType": "issued-credential",
  "testExecutionRef": "credimi-e2e-execution-48",
  "declaredRedaction": { "status": "none", "policyRef": null, "redactedPaths": [], "redactedDigest": null },
  "artifact": { "availability": "inline", "mediaType": "application/vc+sd-jwt", "byteLength": 2048, "uri": null },
  "rulebook": null,
  "validation": null,
  "evidenceGaps": [
    { "code": "no_rulebook_binding", "message": "…" },
    { "code": "validation_not_run", "message": "…" }
  ],
  "evidenceComplete": false
}
```

`GET /api/v1/captures/{captureId}` adds the redacted projection (`artifactProjection`), the
source metadata, the ordered `timeline` and the explicit `limitations`. The raw inline
artifact is **never** returned: `artifactProjection.document` is the default-policy redaction
of the JSON artifact (path-preserving `[redacted]` placeholders), and an external reference is
reported with `availability: "external"` and no projection. The stable gap codes are
`external_artifact_not_fetched`, `artifact_redacted_by_source`,
`no_test_execution_reference`, `no_rulebook_binding`, `validation_not_run` and
`validation_not_applicable`; an absent field is never a pass.

`POST /api/v1/captures/{captureId}/validate` takes the pinned selection and an optional
snapshot digest:

```json
{
  "rulebookId": "…",
  "rulebookVersion": "1.0",
  "attestationType": "…",
  "rulebookDigest": "<optional lowercase hex SHA-256>"
}
```

It runs the **real** structural credential engine on the capture's segregated inline artifact
and records the correlation. A supplied `rulebookDigest` that no longer matches the version
snapshot is refused with `409 conflict` before anything is recorded, so a stale pin cannot
overwrite an existing correlation. The response is the engine's `CredentialValidationResult` plus
the exact binding (`rulebook.id`, `name`, `version`, `contentDigest`, `digestVerified`,
`specVersion`, `status`), the attestation type and the AttestBook `boundAt`, together with the
caller-owned `captureId`, `correlationId` and `testExecutionRef` preserved verbatim (FR-019;
AttestBook still does not mint a correlation id, CD-5). The operation writes no registry data,
does not change a pinned snapshot and is not a durable run history. It requires a provider
bearer token because it records server state that every reader sees; the correlation binding
does not carry the acting provider id.

Evidence that cannot be validated honestly is refused with `409 conflict` and a safe message:
an external reference (not fetched) and a non-`issued-credential` artifact type. The
source-redacted refusal remains a defensive check that the version 1 normalizer currently makes
unreachable, because it rejects an inline artifact that already declares redaction and an
external artifact is refused before that check. A malformed request body or query is
`400 invalid_request`; an unknown capture or unknown rulebook/version/attestation type is
`404 not_found`; a capture-source transport failure is `502 capture_fetch_failed`. A
structural validation status never implies cryptographic, issuer-trust, protocol or
interoperability success. The contract and non-claims are documented in
[`docs/capture.md`](capture.md) §9.

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
| Import or issuer discovery | unsafe/malformed/unsupported source or issuer metadata, limits, refused input | `422` | `import_rejected` |
| Import or issuer discovery | remote fetch failure, DNS failure, timeout, redirect limit, oversized remote response, unsupported remote status | `502` | `import_fetch_failed` |
| Import or issuer discovery | `invalid_source`/`invalid_url` client input | `400` | `invalid_request` |
| Issuer fixtures | malformed request, unmatched/unpinnable schema document, unsupported synthesis constraint, unknown override path | `400` | `invalid_request` |
| Issuer fixtures | rulebook, version, attestation type or stored snapshot does not exist | `404` | `not_found` |
| Issuer fixtures | fixture sandbox at its concurrency limit or unavailable on this platform | `503` | `fixture_unavailable` |
| Verifier constraints | malformed request, foreign/unpinned schema document, integrity mismatch, invalid JSON, exceeded inspection bound or unsupported format | `400` | `invalid_request` |
| Verifier constraints | rulebook, version, attestation type or stored snapshot does not exist | `404` | `not_found` |
| Capture explorer | malformed page bound or correlation body | `400` | `invalid_request` |
| Capture explorer | missing, unknown or revoked bearer token on capture correlation | `401` | `unauthorized` |
| Capture explorer | capture, pinned rulebook, version or attestation type does not exist | `404` | `not_found` |
| Capture explorer | external reference not fetched or non-credential artifact type | `409` | `conflict` |
| Capture explorer | capture-source transport failure | `502` | `capture_fetch_failed` |
| API wiring | registry, validation, issuer discovery, issuer fixtures, verifier policy resolver or capture explorer not configured | `503` | `registry_unavailable` / `validation_unavailable` / `capture_unavailable` |
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
  public read surface. The two exceptions are the import preview and issuer discovery: both
  make the server perform a bounded outbound fetch under the untrusted-import controls, so
  their HTTP routes require the same provider bearer token even though they write nothing.
- Writes, the import preview and issuer discovery require a provider bearer token. Tokens use
  the `att_` prefix and are stored only as SHA-256 hashes; the raw secret is returned once by
  operator provisioning, which is not an HTTP route. The API never echoes a token. The route
  table's `security` flag gates authentication centrally, before any request body is read, so a
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
bun test src/discovery  # discovery extraction, bounds and association
bun test src/fixtures   # fixture synthesis, grounding and negative cases
bun test src/verifier   # typed verifier constraints and OpenID4VP-aware mappings
bun test src/api/verifier.test.ts  # verifier-constraint HTTP contract
bun run check           # formatting, lint, strict typecheck and all tests
```

The API tests use real temporary SQLite databases, real registry services, the real import
pipeline (offline JSON sources only) and a genuinely signed SD-JWT VC fixture. Discovery tests
use an injected transport and DNS resolver, so no test performs a real network request. They
do not claim coverage of HTTP rate limits or provider-management routes. The catalog UI has its
own component and browser tests described in [`docs/ui.md`](ui.md).

## 9. Limitations and next slices

- Catalogue pagination is applied in memory after filtering; versions and attestations are
  returned in full. A paginated store query is a later registry slice.
- No generic `Idempotency-Key` store, no request-body content-type enforcement beyond JSON
  parsing, and no HTTP rate limits for reads, preview, import or discovery. Rate limiting is
  still missing for the outbound-fetch routes, so an authenticated provider can repeat a
  bounded fetch; the import and discovery services' own size, time, redirect and fan-out
  limits still apply to every call. Rate limiting, token expiry/rotation and
  provider-administration routes remain future hardening work documented in
  [`docs/security.md`](security.md) §8.
- Import previews expose a projection (no internal canonical document) and do not persist a
  preview; an import re-runs the preview under the same controls.
- Discovery is read-only: it does not persist discovered issuers, metadata snapshots or
  manual mappings, and it does not fetch exposed references or verify signed metadata
  ([`docs/discovery.md`](discovery.md) §1 and §9).
- Issuer fixtures are unsigned claim payloads, not issued credentials. They are synthesized
  from caller-supplied, integrity-verified schema documents and only within the supported
  JSON Schema subset; compilation and evaluation run in the shared resource-bounded sandbox,
  and the route fetches no schema, signs nothing and persists nothing
  ([`docs/fixtures.md`](fixtures.md) §2.4, §3 and §6).
- Verifier constraints are typed attribute and format constraints plus explicitly partial
  OpenID4VP DCQL mappings. The route produces no presentation request, proof, trust decision
  or protocol result, reports every mapping it cannot express, and inspects only
  caller-supplied, integrity-verified schema documents within hard bounds
  ([`docs/verifier.md`](verifier.md) §2.1, §5 and §6).
- Validation results are returned synchronously and are not persisted
  (`GET /api/v1/validations/{id}` does not exist in this slice; the specification lists it as
  a suggested resource, not an implemented one).
- Capture routes are implemented only for the deterministic mock source. The explorer keeps
  its normalized evidence and recorded correlations in memory, never fetches an external
  artifact reference, does not unpack a captured presentation submission and does not persist a
  run history. A live `capture-issuer`/`capture-verifier` connector remains unimplemented and
  absent rather than present as a placeholder.
- The TS11 catalogue API remains unimplemented and is absent from the OpenAPI document rather
  than present as a placeholder.
