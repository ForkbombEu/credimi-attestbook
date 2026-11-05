# AttestBook registry — persistence, identifiers and authorization

**Status:** Phase 1 registry slice implemented by [issue #28](https://github.com/ForkbombEu/credimi-attestbook/issues/28).
It provides a persistent SQLite registry for providers, rulebooks, attestation types, schema
references, write credentials and an audit trail. It is **not** the HTTP contract, the
publication/versioning lifecycle or a conformance claim.

**Authoritative spec:** [`docs/specification.md`](specification.md) (FR-001, FR-003, §13, §15, §17)
**Decisions:** [`docs/implementation-plan.md`](implementation-plan.md) D-7 (SQLite) and D-10
(provisional product authentication)
**Architecture:** [`docs/architecture.md`](architecture.md) §6 (authorization and ownership),
§7 (domain model) and §10 (persistence tradeoffs)

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

Deliberately **not** in #28:

- published/draft version rows, content digests, content-addressed artifacts and provenance
  snapshots — issue #29;
- URL/JSON import, fetch hardening and re-import idempotency — issues #30/#31;
- the versioned REST API and generated OpenAPI — issue #34;
- protected HTTP write routes, rate limits and API security documentation — issue #35;
- publication UI and the rulebook editor — Phase 2.

Until #34 wires these services into the HTTP application, the database is not opened by
`src/server.ts`; the services are exercised directly by tests and are the intended seam for
the API layer.

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

Initial tables:

| Table | Purpose | Integrity rules |
| --- | --- | --- |
| `providers` | Attestation Scheme Provider and publication-authority account binding | unique, operator-assigned, non-empty authority; JSON-object metadata |
| `auth_tokens` | Provisional write credentials | only a SHA-256 token hash is stored; provider-scoped, revocable |
| `rulebooks` | Stable rulebook identity and product metadata | provider foreign key; status ∈ draft/published/historical; JSON-object provenance/metadata |
| `attestations` | Attestation types owned by a rulebook | unique `(rulebook_id, name)`; formats stored as JSON array |
| `schema_refs` | Format identifier, URI and SRI value | one format per attestation type (and separately one per rulebook-level scope); an optional attestation must belong to the same rulebook |
| `audit_log` | Privileged mutation trail | action, actor provider (nullable for bootstrap), entity and timestamp |
| `schema_migrations` | Applied migration bookkeeping | version, checksum and application timestamp |

`rulebook_versions` and `artifacts` are intentionally deferred to #29. The draft work in #28
is kept consistent with that future model: stable rulebook identity and product metadata live
in `rulebooks`; versioned standards bytes and digests will be added alongside it, not merged
into these product columns.

## 3. Stable identifiers

All AttestBook identifiers are **server-generated, opaque and stable for the lifetime of the
resource**:

| Resource | Identifier | Stability rule |
| --- | --- | --- |
| Provider | `providers.id` | Never derived from a name, URL or contact detail; survives account renames |
| Rulebook | `rulebooks.id` | The stable AttestBook identity; it is not the TS11 `SchemaMeta.id` and does not change when the rulebook name, source URL or metadata changes |
| Attestation type | `attestations.id` | Stable within its rulebook; name changes do not create a new identity |
| Schema reference | `schema_refs.id` | Stable within its rulebook; URI/integrity updates do not create a new identity |
| Write token | `auth_tokens.id` | Stable public token handle; the raw bearer secret is separate and shown only once |

The default generator is UUID v4 (`crypto.randomUUID()`), created inside the service, and
callers cannot supply or override provider/rulebook/attestation/schema-reference IDs. Database
primary keys are the only identity authority; SQLite row ids are insertion order and are not
exposed.

The TS11 v1.0.1 `SchemaMeta.id` is a **per-version wire value** (server-assigned UUID, TS11
§4.3.1) and is not the same thing as the AttestBook rulebook id. The standards adapter in
`src/standards/` keeps the canonical wire document and product
metadata (`ProductMetadata`) as separate types; #29 stores a version's exact wire document and
digest next to, not instead of, this stable product identity.

## 4. Standards metadata boundary

FR-001 requires AttestBook-specific metadata to be distinguishable from normative TS11 fields
and forbids injecting proprietary fields into standards documents. The registry therefore
stores three classes of data separately:

| Data | Class | Storage | Serialized into a TS11/OWF document? |
| --- | --- | --- | --- |
| `attestationLoS`, `bindingType`, `supportedFormats[]` | TS11/ETSI values (extensible data, D-5) | typed columns + JSON array | Yes, only through the standards adapter |
| `schema_refs.format_identifier`, `uri`, `integrity` | TS11 `Schema` values / W3C SRI | typed columns | Yes, only through the standards adapter |
| `applicableSpec` (e.g. `ts11@1.0.1`) | AttestBook profile baseline | column | No: it identifies which profile a version is written against |
| `sourceUrl`, `provenance_json` | AttestBook provenance | column / JSON | No |
| `metadata_json` on providers, rulebooks, attestations and schema references | AttestBook-internal metadata | JSON column | No |
| `publicationStatus`, timestamps, ownership, `auth_tokens`, `audit_log` | AttestBook product state | typed columns/tables | No |

Rules enforced by the implementation and its tests:

- internal metadata is held in its own columns and is **never** merged into a canonical
  standards document; the adapter's `ProductMetadata` type and `productMetadataLeaks` guard
  make that boundary explicit;
- enumerated TS11/ETSI values are validated as bounded strings, not closed TypeScript unions,
  so a later ETSI value does not require a registry migration (D-5);
- import/provenance information (`sourceUrl`, `provenance`) is product data and does not
  become a TS11 member; `sourceUrl` also does not confer publication authority (FR-003);
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
   every rulebook/attestation/schema mutation authenticate the token. Tokens use the `att_`
   prefix, 256 random bits and a SHA-256 hash at rest; the raw secret is returned once at
   issuance and cannot be recovered from the database.
3. **Ownership is checked on the stored resource.** A mutation loads the rulebook and requires
   its `provider_id` to equal the authenticated actor's provider. The create input has no
   provider field, so a caller cannot create a rulebook for another provider. Cross-provider
   attempts fail with `forbidden`, and token management is scoped to the actor's provider.
4. **Reads are public.** Provider and rulebook catalogue reads (including attestations and
   schema references) require no token, mirroring the public-read requirement of TS11 §5.2.1.
5. **Draft-only mutation.** Published and historical rulebooks reject updates and deletes with
   `immutable`. #29 owns the draft→published→historical lifecycle; until then publication
   status cannot be changed through the service.
6. **Mutations are audited.** Creates, updates, deletes, token issuance and revocation write
   an `audit_log` row with the acting provider (or `null` for operator provisioning). Removing
   an attestation type deletes its schema references explicitly and records
   `schema_ref.delete` rows with reason `attestation.delete` before the attestation row.
   Deleting a rulebook likewise records an explicit `schema_ref.delete` and
   `attestation.delete` row for each child (reason `rulebook.delete`) before the rulebook row.
   Child mutations also update the rulebook's `updatedAt`.

Token revocation is idempotent and only affects the authenticated provider's tokens. Phase 1
does not yet implement token expiry, rotation policy, rate limiting or HTTP-level request
authentication; those are #35 concerns, and the single-writer SQLite limitation is documented
in the implementation plan (R-6, D-7). Secrets, token hashes and payload metadata are never
logged by this module.

## 6. Validation and failure model

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
| `conflict` | duplicate attestation name/schema format, or provider still owns rulebooks |
| `immutable` | mutation of a published or historical rulebook |

Messages never include token values, hashes or raw payloads.

## 7. Verification

The implementation is covered by real temporary SQLite files (not in-memory fakes):

- `src/db/migrations.test.ts` — migration from an empty
  database, idempotent re-run, checksum and unknown-version rejection, WAL/foreign-key
  enforcement, orphan/duplicate/malformed-row rejection.
- `src/registry/registry.test.ts` — provisioning and
  hashed-token storage, issue/revoke, rulebook and attestation/schema CRUD, persistence across
  a database reopen, cascades, audit entries, invalid writes, duplicate conflicts, immutable
  published/historical state and invalid identifiers.
- `src/registry/authorization.test.ts` — public reads
  without a token, cross-provider mutation denial for every resource, token scoping and
  unauthorized writes that leave the database unchanged.

Run the suite with `bun run check` (format, lint, strict typecheck and tests). The tests cover
the #28 acceptance criteria; they do **not** claim HTTP contract coverage (#34), publication
immutability (#29) or import security (#30).

## 8. Related work

- [`docs/implementation-plan.md`](implementation-plan.md) §5 — persistence decision, schema
  plan and storage rules.
- [`docs/traceability.md`](traceability.md) Matrix B — FR-001/FR-003 registry test mapping.
- [`docs/standards-adapter.md`](standards-adapter.md) — canonical model, wire codecs and the
  product-metadata boundary used by future version storage.
- Issues [#29](https://github.com/ForkbombEu/credimi-attestbook/issues/29),
  [#30](https://github.com/ForkbombEu/credimi-attestbook/issues/30),
  [#34](https://github.com/ForkbombEu/credimi-attestbook/issues/34) and
  [#35](https://github.com/ForkbombEu/credimi-attestbook/issues/35) for the next slices.
