# AttestBook registry — persistence, identifiers, authorization and immutable versions

**Status:** Phase 1 registry and versioning slices implemented by
[issue #28](https://github.com/ForkbombEu/credimi-attestbook/issues/28),
[issue #29](https://github.com/ForkbombEu/credimi-attestbook/issues/29), the initial
bounded import slice by [issue #30](https://github.com/ForkbombEu/credimi-attestbook/issues/30)
the idempotent re-import slice by
[issue #31](https://github.com/ForkbombEu/credimi-attestbook/issues/31), the lifecycle and
comparison slice by [issue #41](https://github.com/ForkbombEu/credimi-attestbook/issues/41)
and the publication export slice by
[issue #42](https://github.com/ForkbombEu/credimi-attestbook/issues/42).
They provide a persistent SQLite registry for providers, rulebooks, attestation types, schema
references, write credentials and an audit trail, plus draft/published/historical rulebook
versions with content-addressed artifacts, SHA-256 digests, provenance, immutable publication
and a reproducible publication export manifest, and a provider-scoped import identity that
makes re-import idempotent. They are **not** the HTTP contract, credential validation or a
conformance claim; see [`docs/import.md`](import.md) for the import pipeline.

**Authoritative spec:** [`docs/specification.md`](specification.md) (FR-001, FR-002, FR-003,
FR-008, §13, §15, §17)
**Decisions:** [`docs/implementation-plan.md`](implementation-plan.md) D-7 (SQLite), D-6
(content digest) and D-10 (provisional product authentication)
**Architecture:** [`docs/architecture.md`](architecture.md) §6 (authorization and ownership),
§7 (domain model), §9 (reproducibility and content digest) and §10 (persistence tradeoffs)

## 1. Scope and boundaries

Implemented by #28:

- a migration runner and the initial registry schema (`migrations/0001_registry.sql`);
- persistent providers, provider ownership and publication-authority binding;
- persistent rulebooks with name, description, source URL, provenance, applicable profile,
  publication status and internal metadata;
- persistent attestation types (`attestationLoS`, `bindingType`, `supportedFormats`) and
  schema references (`formatIdentifier`, `uri`, W3C SRI `integrity`);
- provisional bearer-token authentication bound to a provider, and service-level ownership
  enforcement for every mutation;
- an audit trail for privileged mutations.

Implemented by #29 (`migrations/0002_versions_artifacts.sql`):

- draft, published and historical rulebook versions with a per-rulebook SemVer label;
- content-addressed artifacts: a version's exact snapshot bytes are stored once under their
  SHA-256 digest;
- digest verification and version-specific retrieval by `(rulebookId, version)` and by
  content digest;
- immutable published and historical versions, enforced by service checks **and** SQLite
  triggers that reject `UPDATE`/`DELETE`;
- version provenance recorded on every version and a publication audit entry recording who
  published which digest under which profile, and which versions were superseded.

Implemented by #41:

- `transitions.ts`: the service-level lifecycle policy. A frozen version may only move
  `draft -> published` (publication) and `published -> historical` (supersede), and a rulebook
  working copy may only move `draft -> published` (publishing) or `published -> draft`
  (creating the next version). Every other transition is rejected with `immutable` before any
  write, in addition to the SQLite triggers;
- `lifecycle/version-diff.ts`: a deterministic structural comparison of two stored snapshot
  documents. Snapshot identity fields (`format`, `rulebookId` and the version label) are
  excluded, object keys are visited in sorted order and changes are JSON Pointer paths sorted
  by path;
- `lifecycle/readiness.ts`: publication-readiness checks over the stored bytes, the current
  working copy, the snapshot content and the owning rulebook's status (draft state, rulebook
  transition, digest integrity, staleness, structural and TS11 v1.0.1 validation, profile
  coverage and attestation types), with explicit limitations and no conformance claim. The
  registry supplies the same candidate inputs publish uses, so readiness and publication
  cannot disagree; a draft version left on a `published` rulebook is not publishable until
  the next version reopens the working copy;
- `Registry.refreshDraftRulebookVersion` is exposed over the API: a draft snapshot can be
  re-taken from the current working copy, while a published or historical version stays
  immutable.

Implemented by #42:

- `src/publication/export.ts` builds the publication export manifest from frozen data only:
  the version row, its provenance and the snapshot document. The rulebook working copy is
  never read, so the export of a published version is stable across repeated reads and later
  drafts, edits or supersession;
- the manifest carries a bounded provenance projection (`adapter`, `sourceUrl`,
  `contentDigest`, `retrievedAt`, `profile`, `conformance`, `importedAt`) rather than the raw
  provenance row. Import provenance can include untrusted envelope metadata, redirect chains
  and optional source labels, so the public manifest excludes them (§15 personal-data
  minimisation);
- the manifest carries the frozen rulebook identity, the exact byte length, the SHA-256
  content digest, the publication time, bounded provenance and an explicit
  `integrity: { algorithm: "sha256", verified: true }` result. The digest is recomputed
  before every export; a mismatch fails as a server fault rather than exporting corrupt
  bytes as verified;
- there is no publication signature: OWF 0.5.4 signs only a bare OWF-profile `SchemaMeta`
  compact JWS, a version snapshot is not a `SchemaMeta`, and the TS11 v1.0.1
  catalogue-response JWS is not implemented by the package. The manifest reports
  `signature.status: "unsupported"` with the concrete reason instead of inventing
  proprietary signing semantics (FR-008, [`docs/standards.md`](standards.md) §5.8 and §6.2);
- the HTTP layer exposes `GET .../versions/{version}/export` (exact attachment bytes with
  `Content-Digest`, `ETag` and a sanitised `Content-Disposition` filename) and
  `GET .../versions/{version}/export/manifest`. Both are public and accept only published or
  historical versions; a draft answers `409 conflict`. The existing `/content` route remains
  the exact-bytes read for any version.

Implemented by #40:

- rulebook-level schema references on create (owned by no attestation type);
- `getDraftContent` and `replaceDraftContent`: the draft working copy is readable and
  replaceable as one document through the same normalized rows, in one authorized
  transaction, without touching version snapshots or their content-addressed artifacts.

Implemented by #30:

- `RulebookImporter` creates drafts from a compatible, bounded URL/JSON preview through
  `createRulebooks`, which writes the whole source in one transaction, and stores
  `sourceUrl` plus provenance (adapter, retrieval time, byte length, exact-bytes SHA-256
  digest, envelope, profile, conformance and the source's own conformance signal);
- `createRulebook` accepts an attestation's schema references in the same call, and
  `createRulebooks` batches several creates in one transaction, so an imported rulebook, its
  attestation type and its references are written atomically; the references' OWF
  `meta`/unknown members are retained as registry-internal metadata.

Implemented by #31:

- `migrations/0003_import_identity.sql` adds `rulebooks.import_key` and a partial unique
  index on `(provider_id, import_key)`, so an external entry can map to at most one rulebook
  per provider even under a concurrent write;
- `createRulebook`/`createRulebooks` accept an optional, validated `importKey`;
- `Registry.findImportedRulebook` looks an entry identity up **only** for the authenticated
  provider, which is the service seam for idempotent re-import;
- `Registry.normalizeRulebookInput` validates and normalizes a create input exactly as a
  write would without inserting anything, so the importer fingerprints the stored form
  (trimmed text, parsed URLs, bounded arrays) rather than the raw source;
- the identity is product metadata: it is never included in a version snapshot or a
  standards document, and the import pipeline stores the per-entry content fingerprint in
  provenance.

Deliberately **not** in #28/#29/#30/#31:

- automatic application of a changed source to an existing draft (the importer reports
  conflicts instead; resolution uses the version lifecycle) — see [`docs/import.md`](import.md)
  §5;
- scheduled synchronization, conditional fetching and source-availability diagnostics —
  later FR-005 slices;
- credential validation against a version — issues #32/#33;
- the versioned REST API and generated OpenAPI — implemented by
  [issue #34](https://github.com/ForkbombEu/credimi-attestbook/issues/34) in `src/api/` and
  documented in [`docs/api.md`](api.md);
- HTTP rate limiting, token expiry/rotation and provider-management HTTP routes — not
  implemented in Phase 1; the write API's authentication, provider ownership and secret
  handling are documented in [`docs/security.md`](security.md);
- a publication signature and a TS11/OWF wire-document export — the export is the frozen
  AttestBook snapshot plus its manifest; signing is deliberately not fabricated because the
  pinned OWF package does not support the TS11 catalogue-response JWS. The draft lifecycle,
  comparison and readiness checks themselves are implemented by #41, and the export surface
  by #42;
- semantic content canonicalization — explicitly out of scope (D-6, R-17).

The server opens the database and applies migrations at startup; the registry service is
wired into the versioned HTTP API described in [`docs/api.md`](api.md), and the service
contract remains the seam the routes call.

## 2. Storage engine and migrations

The Phase 1 engine is one SQLite database file behind a repository/service boundary
(decision D-7). `src/db/database.ts` opens a connection with:

- `PRAGMA journal_mode = WAL` for concurrent readers while one writer commits;
- `PRAGMA foreign_keys = ON`, so provider→rulebook→attestation/schema relationships and
  cascades are enforced by the database;
- `PRAGMA busy_timeout = 5000` so a short write lock waits instead of failing immediately.

Migrations are ordered `.sql` files in `migrations/`, imported as text by
`src/db/migrations.ts` so the production bundle does not depend on
a runtime working directory. Each applied version is recorded in `schema_migrations` with its
SHA-256 checksum. The runner:

- applies each pending migration in its own transaction;
- is a no-op when the database is current;
- refuses a checksum that no longer matches an applied migration (edit a new migration, never
  an applied one);
- refuses a database that records a migration this build does not know, instead of silently
  running a downgraded schema.

Initial tables (`0001_registry`), version tables (`0002_versions_artifacts`) and the import
identity column added by `0003_import_identity`:

| Table | Purpose | Integrity rules |
| --- | --- | --- |
| `providers` | Attestation Scheme Provider and publication-authority account binding | unique, operator-assigned, non-empty authority; JSON-object metadata |
| `auth_tokens` | Provisional write credentials | only a SHA-256 token hash is stored; provider-scoped, revocable |
| `rulebooks` | Stable rulebook identity and product metadata | provider foreign key; status ∈ draft/published/historical; JSON-object provenance/metadata; optional 64-hex `import_key`, unique per provider through a partial index |
| `rulebook_versions` | Draft/published/historical snapshots of a rulebook | unique `(rulebook_id, version)`; digest required; artifact foreign key; status and `published_at` must agree |
| `artifacts` | Content-addressed exact snapshot bytes | `digest` primary key; bytes never updated or deleted |
| `attestations` | Attestation types owned by a rulebook | unique `(rulebook_id, name)`; formats stored as JSON array |
| `schema_refs` | Format identifier, URI and SRI value | one format per attestation type (and separately one per rulebook-level scope); an optional attestation must belong to the same rulebook |
| `audit_log` | Privileged mutation and publication trail | actor, action, entity and timestamp |
| `schema_migrations` | Applied migration bookkeeping | version, checksum and application timestamp |

The version tables are immutable where it matters: `artifacts` rejects `UPDATE` and `DELETE`
outright, `rulebook_versions` rejects `UPDATE`/`DELETE` once a row is published or
historical, and the only accepted transition for a published row is `published → historical`
when a newer version is published. The initial schema deliberately keeps stable rulebook
identity and product metadata in `rulebooks`; versioned content is stored beside it in
`rulebook_versions` and `artifacts`, never merged into the product columns.

Migration `0003_import_identity` only adds the nullable `import_key` column and the partial
unique index; existing local rulebooks keep `NULL` and are excluded from the index. SQLite
adds the column with a `length(import_key) = 64` check, so a malformed key cannot be written
even by a caller that bypasses the service.

## 3. Stable identifiers

All AttestBook identifiers are **server-generated, opaque and stable for the lifetime of the
resource**:

| Resource | Identifier | Stability rule |
| --- | --- | --- |
| Provider | `providers.id` | Never derived from a name, URL or contact detail; survives account renames |
| Rulebook | `rulebooks.id` | The stable AttestBook identity; it is not the TS11 `SchemaMeta.id` and does not change when the rulebook name, source URL or metadata changes |
| Rulebook version | `(rulebook_id, version)` | The version label is unique per rulebook; `rulebook_versions.id` is an internal opaque UUID and content changes create a new digest or a new version, never a new identity |
| Artifact | `artifacts.digest` | The SHA-256 of the exact bytes; content-addressed, so the identity *is* the content |
| Attestation type | `attestations.id` | Stable within its rulebook; name changes do not create a new identity |
| Schema reference | `schema_refs.id` | Stable within its rulebook; URI/integrity updates do not create a new identity |
| Import identity | `rulebooks.import_key` | Deterministic, not opaque: SHA-256 of the source and entry identity; unique per provider; never changes after creation and is never a public resource id |
| Write token | `auth_tokens.id` | Stable public token handle; the raw bearer secret is separate and shown only once |

The default generator is UUID v4 (`crypto.randomUUID()`), created inside the service, and
callers cannot supply or override provider/rulebook/attestation/schema-reference/version IDs.
Database primary keys are the only identity authority; SQLite row ids are insertion order and
are not exposed. Version labels are caller-supplied but validated and unique per rulebook; a
content digest is not a label, it identifies exact bytes. The import key is the one
deterministic identity: it is computed by the import service (not a user id), scoped to the
provider, and exists only to recognise the rulebook created from the same external entry on a
later import ([`docs/import.md`](import.md) §5).

The TS11 v1.0.1 `SchemaMeta.id` is a **per-version wire value** (server-assigned UUID, TS11
§4.3.1) and is not the same thing as the AttestBook rulebook id. The standards adapter in
`src/standards/` keeps the canonical wire document and product
metadata (`ProductMetadata`) as separate types; #29 stores a version's exact snapshot
document and digest next to, not instead of, this stable product identity. The snapshot is an
internal AttestBook artifact, not a TS11 wire document; import (#30) supplies the bytes that
become exportable standards content.

## 4. Standards metadata boundary

FR-001 requires AttestBook-specific metadata to be distinguishable from normative TS11 fields
and forbids injecting proprietary fields into standards documents. The registry therefore
stores three classes of data separately:

| Data | Class | Storage | Serialized into a TS11/OWF document? |
| --- | --- | --- | --- |
| `attestationLoS`, `bindingType`, `supportedFormats[]` | TS11/ETSI values (extensible data, D-5) | typed columns + JSON array | Yes, only through the standards adapter |
| `schema_refs.format_identifier`, `uri`, `integrity` | TS11 `Schema` values / W3C SRI | typed columns | Yes, only through the standards adapter |
| `applicableSpec` (e.g. `ts11@1.0.1`) | AttestBook profile baseline | column | No: it identifies which profile a version is written against |
| `sourceUrl`, `provenance_json` (rulebook and version) | AttestBook provenance | column / JSON | No |
| `rulebooks.import_key`, provenance `contentFingerprint` | Import identity and change detection | column / JSON | No: import-internal product metadata |
| version snapshot bytes (`artifacts.bytes`) | Versioned content artifact (internal, deterministic JSON) | content-addressed BLOB | No: it is not a TS11/OWF document and is never exported as one |
| `content_digest`, `published_at`, `rulebook_versions.status` | AttestBook product state | typed columns | No |
| `metadata_json` on providers, rulebooks, attestations and schema references | AttestBook-internal metadata | JSON column | No |
| `publicationStatus`, timestamps, ownership, `auth_tokens`, `audit_log` | AttestBook product state | typed columns/tables | No |

Rules enforced by the implementation and its tests:

- internal metadata is held in its own columns and is **never** merged into a canonical
  standards document; the adapter's `ProductMetadata` type and `productMetadataLeaks` guard
  make that boundary explicit;
- enumerated TS11/ETSI values are validated as bounded strings, not closed TypeScript unions,
  so a later ETSI value does not require a registry migration (D-5);
- import/provenance information (`sourceUrl`, `provenance`, `import_key`) is product data and
  does not become a TS11 member; `sourceUrl` also does not confer publication authority
  (FR-003);
- JSON columns are constrained by SQLite `json_valid`/`json_type` checks, so malformed
  metadata cannot be written even by a caller that bypasses the service.

## 5. Authentication, ownership and authorization

TS11 §5.2.2 leaves the concrete authorization mechanism unspecified, so AttestBook uses the
provisional product model of D-10. The service enforces it, not the UI or a route handler:

1. **Provisioning is an operator action.** `provisionProvider` in `src/registry/bootstrap.ts`
   creates a provider, assigns its publication authority and issues its first token. It is
   deliberately not a `Registry` service method: this is the only unauthenticated write and
   exists because a provider cannot hold a token before it exists; it is never exposed as an
   HTTP route. The publication authority is case-insensitively unique and cannot be changed
   through the service, so a provider cannot self-assert another account's authority (FR-003).
2. **Writes require a bearer token.** `issueToken`, `updateProvider`, `deleteProvider` and
   every rulebook/attestation/schema/version mutation authenticate the token. Tokens use the
   `att_` prefix, 256 random bits and a SHA-256 hash at rest; the raw secret is returned once at
   issuance and cannot be recovered from the database.
3. **Ownership is checked on the stored resource.** A mutation loads the rulebook and requires
   its `provider_id` to equal the authenticated actor's provider. The create input has no
   provider field, so a caller cannot create a rulebook for another provider. Cross-provider
   attempts fail with `forbidden`, and token management is scoped to the actor's provider.
4. **Reads are public.** Provider and rulebook catalogue reads (including attestations,
   schema references, versions, version content and digest verification) require no token,
   mirroring the public-read requirement of TS11 §5.2.1. The import-identity lookup is the
   exception: `findImportedRulebook` requires the authenticated provider's token and only
   returns that provider's rulebook, because the key is import-internal.
5. **Draft-only rulebook content.** Rulebook, attestation and schema-reference mutations
   require the rulebook to be `draft`; `published` and `historical` rulebooks reject them with
   `immutable`. Publishing a version sets the rulebook to `published`; creating the next draft
   version reopens the working copy to `draft` while every published version stays frozen. A
   rulebook with published or historical versions cannot be deleted, even while its working
   copy is a draft.
6. **Version mutations follow the lifecycle.** `createRulebookVersion` and
   `refreshDraftRulebookVersion` accept only the owning provider; `publishRulebookVersion`
   requires the stored snapshot to still match the rulebook's current content. Draft rows may
   be refreshed; published and historical rows are immutable in the service *and* in the
   database. See §6.
7. **Mutations are audited.** Creates, updates, deletes, token issuance and revocation write
   an `audit_log` row with the acting provider (or `null` for operator provisioning). Version
   creation, refresh and publication write `version.create`, `version.refresh` and
   `version.publish` rows; a publication row records the digest, profile and superseded
   versions. Removing an attestation type deletes its schema references explicitly and records
   `schema_ref.delete` rows with reason `attestation.delete` before the attestation row.
   Deleting a rulebook likewise records an explicit `schema_ref.delete` and
   `attestation.delete` row for each child (reason `rulebook.delete`) before the rulebook row.
   Child mutations also update the rulebook's `updatedAt`.

Token revocation is idempotent and only affects the authenticated provider's tokens. Phase 1
does not yet implement token expiry, rotation policy or rate limiting; the HTTP write
authentication and ownership checks are implemented in `src/api/routes.ts` and verified in
`src/api/security.test.ts`, with the complete model in [`docs/security.md`](security.md). The
single-writer SQLite limitation is documented in the implementation plan (R-6, D-7). Secrets,
token hashes and payload metadata are never logged by this module.

## 6. Versions, artifacts, digests and publication

### 6.1 Lifecycle

A rulebook starts `draft` and has no versions until the provider freezes one. A version moves
`draft → published → historical`; the rulebook's own `publicationStatus` reflects the working
copy:

| Operation | Requires | Effect |
| --- | --- | --- |
| `createRulebookVersion(rulebookId, { version, provenance? })` | owning provider; rulebook not `historical`; unique SemVer label | snapshots current content as a `draft` version; reopens a `published` rulebook to `draft` |
| `refreshDraftRulebookVersion(rulebookId, version)` | owning provider; version is `draft` | re-snapshots current content and updates the digest; no-op for identical content |
| `publishRulebookVersion(rulebookId, version)` | owning provider; version is `draft`; stored digest matches current content | freezes the version as `published`, demotes previously published versions to `historical`, sets the rulebook to `published` |
| `replaceDraftContent(rulebookId, document)` | owning provider; rulebook's working copy is `draft` | replaces metadata, attestation types and schema references in one transaction; frozen/published version rows and artifacts are untouched, and a later publish of a stale draft version still answers `conflict` until it is refreshed. Internal row metadata (the importer's `profile`/`conformance` and OWF `meta`/`unknownMembers`) is kept for an attestation matched by name and a reference matched by attestation, `formatIdentifier` and `uri`; new or changed entries start with `{}` |
| `deleteRulebook(rulebookId)` | owning provider; rulebook is `draft` and has no published/historical versions | deletes draft versions; published/historical rows can never be deleted |

`historical` is only produced by supersession: a version that was never published cannot jump
straight to `historical`, so the status always means "published once, superseded since". Version
labels are numeric `MAJOR.MINOR` or `MAJOR.MINOR.PATCH` (architecture §9; TS11 §4.5.1);
prerelease and build suffixes are not accepted yet.

Publishing a stale snapshot is refused with `conflict`: `publishRulebookVersion` recomputes the
digest of the rulebook's current content and compares it with the stored version digest. The
provider must call `refreshDraftRulebookVersion` explicitly, so a version is never published
with content that changed after the provider froze it.

Supersession follows **publication order**, not a SemVer comparison: this slice does not
require a new label to be numerically greater, so publishing `0.9` after `2.0` still makes
`2.0` historical. Authoring/ordering policy is left to the editor slice.

`replaceDraftContent` validates and builds the whole document before its transaction, so a
failed validation leaves the previous working copy byte-for-byte intact. It deletes and
re-inserts the mutable working-copy rows (with audit entries), never version or artifact
rows; `requireOwnedDraft` refuses published and historical rulebooks with `immutable`. This
is the service guarantee behind UI-003's "no published artifact mutation".

The editable document deliberately omits registry-internal row metadata. An attestation
whose name is unchanged keeps its previous row id, creation time and internal metadata; a
schema reference whose attestation, `formatIdentifier` and `uri` are unchanged does the same.
A renamed attestation or a changed reference starts fresh, so an unchanged editor save does
not reset importer provenance and does not make a later re-import report a false
`locally_modified` conflict.

While the next draft is in progress, the rulebook's catalogue `publicationStatus` is `draft`
even though a published version remains retrievable. The versioned API exposes the full
version list alongside the working state (see [`docs/api.md`](api.md)), so catalogue
consumers are not misled.

### 6.2 Content digest and artifact

The version's content is a deterministic JSON snapshot of the rulebook's content at freeze
time: format marker, rulebook id, version label, profile (`specVersion`), name, description,
source URL, attestation types with their schema references, and rulebook-level schema
references. Internal metadata, provenance, provider identity and timestamps are deliberately
excluded from the bytes; they live on the row. The bytes have media type
`application/vnd.attestbook.rulebook-version+json` and are stored once in `artifacts`, keyed by
their lowercase hex SHA-256 digest (D-6). Because the serializer fixes field order, the same
stored state produces the same bytes and digest.

This is byte-exact reproducibility, not semantic canonicalization: a re-serialized source JSON
with a different key order or whitespace is different content and gets a different digest
(known limitation R-17). The snapshot is an internal artifact, not a TS11/OWF wire document;
import (#30) supplies the exact bytes that become the exportable standards artifact, reusing
the same content-addressed store.

### 6.3 Retrieval, verification and provenance

- `getRulebookVersion(rulebookId, version)` and `listRulebookVersions(rulebookId)` return the
  version rows publicly.
- `getRulebookVersionContent(rulebookId, version)` returns the exact stored bytes and media
  type; a consumer can verify them with its own SHA-256 implementation.
- `verifyRulebookVersionDigest(rulebookId, version)` recomputes the digest over the stored
  bytes and reports `expectedDigest`, `actualDigest` and `verified`.
- `findRulebookVersionsByDigest(digest)` retrieves versions by content digest, which is how a
  validation run or export references the exact bytes it used (FR-002).
- `RulebookVersion.provenance` records version provenance. Creation defaults to the rulebook's
  provenance or accepts explicit provenance; publication is recorded in the audit log with the
  actor, timestamp, digest, profile and superseded versions, and in `published_at`.
  Provenance is captured when the version is created; refreshing draft content does not change
  it, so a rulebook-provenance change made before publication requires a new version. This
  slice has no separate "edit version provenance" operation.

Version snapshot bytes are retrievable over the public API (`GET .../versions/{version}/content`,
with a `Content-Digest` header), and published or historical artifacts additionally have the
publication-grade `GET .../versions/{version}/export` download and `.../export/manifest`
routes (§6.5). Comparison is owned by #37; this slice stores the data needed for it.

### 6.4 Immutability enforcement

Immutability does not depend on the caller using the service.
`migrations/0002_versions_artifacts.sql` adds triggers that:

- reject every `UPDATE` and `DELETE` on `artifacts`, so a digest can never disagree with its
  bytes;
- reject an `INSERT` of an existing artifact digest, so `INSERT OR REPLACE` cannot swap the
  bytes behind a key (SQLite's REPLACE deletes the old row without firing `DELETE` triggers);
- reject an `INSERT` or `UPDATE` that would claim an existing version id or
  `(rulebook_id, version)` label, so `INSERT OR REPLACE`/`UPDATE OR REPLACE` cannot delete a
  published row through conflict resolution;
- reject `UPDATE`/`DELETE` on `rulebook_versions` rows whose stored status is `published` or
  `historical`, except the status-only `published → historical` transition;
- reject a second transition or a downgrade back to `draft`.

Deleting the parent rulebook cascades to its versions, and the published/historical `DELETE`
trigger aborts the whole statement; the service also refuses such a deletion before SQL. A
draft rulebook *without* published versions can still be deleted, which removes its draft
version rows.

Tests exercise both the service checks and direct SQL attempts (including `INSERT OR REPLACE`
and `UPDATE OR REPLACE`); a rejected mutation leaves the database unchanged. Artifacts are
append-only: deleting a draft rulebook removes its draft version rows but does not reclaim
artifact bytes, because there is no safe way to delete content-addressed bytes in this slice.
Garbage collection is not implemented; retention is an operator concern until a slice adds it
explicitly.

### 6.5 Publication export

`src/publication/export.ts` (issue #42) turns a published or historical version into a stable
export: the exact stored bytes plus a manifest. The manifest is assembled only from frozen
data — the version row, its provenance and the snapshot document — so it never reads the
rulebook's mutable working copy. Consequently:

- exporting the same published version always returns the same bytes and the same manifest,
  including after the rulebook is renamed, edited, given a new draft version or superseded;
- supersession changes only `status` (`published` → `historical`), never the digest, byte
  length, publication time, provenance or exported bytes;
- the builder recomputes the SHA-256 digest over the exact bytes before producing a manifest.
  A mismatch is a server fault; corrupt bytes are never exported as verified.

The manifest's `signature.status` is always `"unsupported"` with a fixed reason. FR-008 asks
for signing only where the standard defines it; the pinned OWF package signs a bare OWF
`SchemaMeta` compact JWS only, while the exported artifact is AttestBook's internal snapshot.
Using `signSchemaMeta` for it would invent proprietary signing semantics, so the registry does
not. Integrity is the content digest, and consumers verify it themselves. The full HTTP
contract is in [`docs/api.md`](api.md) §3.4.

## 7. Validation and failure model

Inputs are validated and bounded before SQL: non-empty trimmed text, maximum lengths, JSON
objects only (with a serialized-size limit), `http(s)` URLs without embedded credentials,
bounded unique string arrays and W3C SRI-shaped `integrity` values. URLs are stored in their
parsed normal form (lowercase scheme/host, `parsed.href`), so a valid uppercase scheme cannot
trip the database's case-sensitive URL check; the length limit is re-checked after
percent-encoding expansion. Stored JSON metadata is a detached serialized copy, so a caller
cannot mutate what was persisted afterwards. These are product safety limits, not a claim of
TS11 conformance; the standards adapter remains the wire-profile validator, and SRI
**verification** belongs to #30.

Failures are typed `RegistryError`s with a stable code so the HTTP layer can map them without
parsing messages:

| Code | Meaning |
| --- | --- |
| `invalid_input` | malformed, missing, oversized or unsafe value |
| `unauthorized` | missing, unknown or revoked bearer token |
| `forbidden` | authenticated provider does not own the resource |
| `not_found` | resource does not exist (or is not part of the named rulebook) |
| `conflict` | duplicate attestation name, schema format, version label or import identity; stale draft snapshot at publication; provider still owns rulebooks |
| `immutable` | mutation of a published or historical rulebook/version, or of a stored artifact |

Messages never include token values, hashes or raw payloads.

## 8. Verification

The implementation is covered by real temporary SQLite files (not in-memory fakes):

- `src/db/migrations.test.ts` — migration from an empty
  database, idempotent re-run, checksum and unknown-version rejection, WAL/foreign-key
  enforcement, orphan/duplicate/malformed-row rejection, and schema-level rejection of
  artifact updates/deletes and published/historical version mutations.
- `src/registry/registry.test.ts` — provisioning and
  hashed-token storage, issue/revoke, rulebook and attestation/schema CRUD, persistence across
  a database reopen, cascades, audit entries, invalid writes, duplicate conflicts, immutable
  published/historical state and invalid identifiers.
- `src/registry/versions.test.ts` — deterministic snapshot bytes and digest, provenance,
  version-specific retrieval by label and by digest, digest verification, artifact dedupe,
  draft refresh, stale-publication refusal, publication/supersession, persistence across a
  reopen, unauthorized and cross-provider version mutations, and direct-SQL attempts to
  overwrite published versions or artifacts.
- `src/registry/authorization.test.ts` — public reads
  without a token, cross-provider mutation denial for every resource, token scoping and
  unauthorized writes that leave the database unchanged.
- `src/registry/create-rulebook-refs.test.ts` — transactional creation of attestation schema
  references, duplicate-format and per-attestation fan-out rejection, and rollback when a
  reference is invalid.
- `src/registry/import-identity.test.ts` — import key persistence and lookup, per-provider
  uniqueness enforced by the service and by the database index, cross-provider isolation,
  invalid-key rejection, write-free input normalization, update preservation and exclusion of
  the identity from a version snapshot.
- `src/import/` — the bounded URL/JSON import preview and authenticated draft import,
  including idempotent re-import and conflict detection; see [`docs/import.md`](import.md).
- `src/publication/export.test.ts` — frozen manifest fields, deterministic output, the
  absence of a fabricated signature, digest-mismatch and draft-version refusal, and safe
  attachment filenames for untrusted rulebook names.
- `src/api/publication.test.ts` — authorized publication and its audit row, exact exported
  bytes with `Content-Digest`/`ETag`/`Content-Disposition`, identical repeated exports and
  manifests, manifest stability across later draft edits, draft `409 conflict`, historical
  export after supersession and public/missing-resource behaviour.

Run the suite with `bun run check` (format, lint, strict typecheck and tests). The tests cover
the #28/#29/#30/#31/#41/#42 acceptance criteria; HTTP contract coverage is added by #34 in
`src/api/routes.test.ts` and the generated-OpenAPI tests. The suite does **not** claim
URL/JSON import security beyond the #30 controls, automatic source updates, scheduled
synchronization or credential validation (#32), and it does not claim a publication signature.

## 9. Related work

- [`docs/implementation-plan.md`](implementation-plan.md) §5 — persistence decision, schema
  plan and storage rules; D-6 for the digest model.
- [`docs/architecture.md`](architecture.md) §9 — reproducibility, content digest and immutable
  publication.
- [`docs/traceability.md`](traceability.md) Matrix B — FR-001/FR-002/FR-003 test mapping.
- [`docs/standards-adapter.md`](standards-adapter.md) — canonical model, wire codecs and the
  product-metadata boundary used by future version storage.
- [`docs/api.md`](api.md) — the versioned REST contract that exposes this registry.
- Issues [#30](https://github.com/ForkbombEu/credimi-attestbook/issues/30) (initial import,
  documented in [`docs/import.md`](import.md)),
  [#31](https://github.com/ForkbombEu/credimi-attestbook/issues/31) (idempotent re-import and
  conflict detection, documented in [`docs/import.md`](import.md) §5),
  [#32](https://github.com/ForkbombEu/credimi-attestbook/issues/32) (validation against a
  pinned version), [#34](https://github.com/ForkbombEu/credimi-attestbook/issues/34) (REST
  API), [#35](https://github.com/ForkbombEu/credimi-attestbook/issues/35) (secure write APIs,
  documented in [`docs/security.md`](security.md)) and
  [#37](https://github.com/ForkbombEu/credimi-attestbook/issues/37) (version-history UI)
  for the next slices.
