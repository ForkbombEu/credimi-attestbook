AttestBook is a registry and validation platform for EUDI attestation rulebooks.
The [rulebook catalog](/) and the [validation playground](/playground) are
clients of the same public product API, and every validation result is tied to
one exact rulebook version. This page defines the vocabulary those views share;
the [Quick start](/guide/quick-start) then walks through both views.

## One ownership chain

The concepts form one chain. A **provider** owns **rulebooks**. A rulebook
declares **attestation types**, each with **schema references**. Its **draft**
working copy is frozen into a version, and a **published** version is the
**immutable snapshot** identified by its **content digest**.
**Structural-validation evidence** is always recorded against one snapshot, not
against "the rulebook in general".

## Provider

An Attestation Scheme Provider is the product identity that owns rulebooks and
is authoritative for publishing them. AttestBook generates the provider
identifier on the server and keeps it stable: it is not derived from the
provider's name, URL or contact details, so a rename does not change it.

Ownership and publication authority are AttestBook product state. A rulebook's
source URL is provenance, not an authorization: importing or citing a URL never
confers the right to publish under that provider (FR-003). The catalog's
**Provider** column and filter use this identity, and the public API exposes the
same projection at `GET /api/v1/providers`.

`provider` is not a TS11 wire member. It stays in the registry's product
metadata and is never inserted into a standards document
(`docs/registry.md` §4).

## Rulebook

A rulebook is the durable product identity for one Attestation Rulebook and its
version history. It carries a name, description, owning provider, source URL,
provenance, the applicable specification/profile, its attestation types and
its schema references.

The rulebook identifier is opaque and stable for the rulebook's lifetime. It is
not the TS11 `SchemaMeta.id`: that identifier belongs to a version's standards
projection and can change when a new version is written
(`docs/registry.md` §3). A rulebook's displayed version, status and digest
describe its working copy and version list; they do not re-create the rulebook.

## Attestation type

An attestation type is one kind of attestation a rulebook governs, such as a
Person Identification Data (PID) attestation. It declares the level of
assurance, the binding type, the supported credential formats and the schema
references for each format. A rulebook can declare more than one attestation
type, and a validation request always selects exactly one.

The type name is stable within its rulebook. When AttestBook checks a draft
against the TS11 v1.0.1 baseline, it projects each attestation type into one
`SchemaMeta` document; the whole rulebook is a product grouping of those
documents, not a single wire document (`src/editor/draft.ts`,
`docs/standards.md` §4.1).

## Schema reference

A schema reference pins the schema that a credential of one format must
satisfy. It has three parts:

- `formatIdentifier`, the credential format the reference applies to;
- `uri`, the absolute location of the schema or type metadata document;
- `integrity`, a W3C Subresource Integrity value that pins the exact bytes.

A rulebook version can also carry hosted schema documents: AttestBook stores the
bytes a provider registered and serves them from a public, content-addressed
URL. The reference still points at that URL with its SRI pin, and the stored
document is kept beside the rulebook, never inside a standards document
(`docs/registry.md` §6.6–§6.7). Imported catalogs, remote schemas and stored
documents are untrusted input: they are bounded and validated before use, and an
unpinned or unmatched document is reported rather than applied.

## Draft

A rulebook starts as a `draft` working copy. While it is a draft, its metadata,
attestation types and schema references can be replaced, and the provider can
freeze a labelled draft version. Version labels are unique per rulebook and use
numeric `MAJOR.MINOR` or `MAJOR.MINOR.PATCH`.

A frozen draft version is a snapshot of the working copy at freeze time, but it
is still a draft: it can be refreshed to the current content, and it can be
published. If the working copy changed after the freeze, publishing with a stale
digest is refused as a conflict; the provider must refresh the draft version
first (`docs/registry.md` §6.1). A published rulebook's working copy cannot be
edited directly (the change is refused as `immutable`); creating the next draft
version reopens the working copy as `draft`, while its published versions stay
retrievable.

## Published and historical versions

Publishing freezes a draft version and makes it the rulebook's current published
version. Publishing another version later does not rewrite the earlier one: it
moves to `historical`. Both `published` and `historical` versions are retrievable
and both are immutable; `historical` means "published once and superseded", never
"never published".

A rulebook's catalogue status describes its working copy: while the next draft is
in progress, the catalogue status is `draft` even though a published version
remains available in the version list (`docs/registry.md` §6.1). The catalog's
**Status** column is therefore not a claim that no published version exists.

## Immutable snapshot

A version's snapshot is the deterministic JSON document AttestBook freezes at
publication: the format marker, rulebook identifier, version label, profile,
name, description, source URL, attestation types, their schema references and
rulebook-level schema references. Internal metadata, provenance, provider
identity and timestamps are deliberately excluded, because changing them must
not change what a version means.

The exact bytes are stored once in a content-addressed artifact store and are
served with their media type and a `Content-Digest` header. For a published or
historical version, the export route returns those same bytes with a manifest
built only from frozen data. Reproducibility is byte-exact: re-serialising the
same source with different key order or whitespace produces different bytes and
a different digest, so consumers should pin and compare the digest rather than
re-format the document (`docs/registry.md` §6.2, §6.5).

The snapshot is AttestBook's internal artifact, not a TS11/OWF wire document.
The standards projection and the product snapshot are kept separate
(`docs/registry.md` §4).

## Content digest

A content digest is the lowercase hexadecimal SHA-256 of the snapshot's exact
bytes. It is the version's content address: the same bytes always have the same
digest, and any byte change produces a different one. A validation run, export
or capture correlation references the exact rulebook identifier, version and
digest it used, so a later edit cannot silently change the evidence.

The digest is not a signature and says nothing about who published the content.
It is also not a version label: labels are caller-supplied and unique per
rulebook, while the digest identifies bytes. A consumer can recompute the digest
over downloaded bytes, and the registry can verify its stored bytes against the
recorded digest (`docs/registry.md` §6.2–§6.3).

## Structural-validation evidence

Structural validation checks a credential against one pinned rulebook version and
reports evidence per validation dimension, never a single "valid" bit. The
FR-010 catalogue is fixed and ordered: credential parsing, format recognition,
cryptographic verification, schema validation, attestation-specific constraints,
issuer and trust-policy validation, protocol conformance and end-to-end
interoperability.

This build executes the four structural dimensions and reports their evidence;
cryptographic verification and issuer trust are `NOT_TESTED`, and protocol
conformance and interoperability are `NOT_APPLICABLE` to a single credential
artifact. The overall status is `FAIL` when a dimension fails, `INCONCLUSIVE`
when a dimension is inconclusive and nothing failed, and `NOT_TESTED` when an
applicable dimension did not execute. Because cryptographic verification and
issuer trust are always applicable and never executed here, an overall `PASS`
is not reachable in this structural-only slice (`docs/registry.md` §7 and
`src/validation/status.ts`).

A structural pass never implies cryptographic validity, issuer trust, protocol
conformance or interoperability. The result states its limitations, the pinned
version and digest, the schema references it applied and the individual
violations, so a reader can see what was actually checked. A schema reference
whose URI is this deployment's canonical hosted URL is resolved from
AttestBook's immutable store and applied; a caller-supplied document is used the
same way. When neither is available, the schema dimension stays `NOT_TESTED`
rather than being reported as passed.

## Standards expectations versus the product API

EUDI standards define the rulebook and attestation metadata model, and AttestBook
tracks EC TS11 v1.0.1 as its initial baseline. The implemented public product API
is AttestBook's own `/api/v1` contract. It is not the TS11 catalogue API, and the
pinned OWF package does not implement that catalogue's signed envelope and
filtering. Standards-facing work is therefore reported as an adapter result or an
explicit limitation, never as a compliance claim.

## Where this is documented

- `docs/registry.md` §3–§4 and §6 for identifiers, the standards metadata
  boundary, lifecycle, digest and immutability.
- `docs/standards.md` §4–§6 for the `SchemaMeta`/`SchemaURI` data model,
  structural validation and the TS11 divergence.
- `docs/specification.md` §5 FR-001–FR-003 for rulebook, version and provider
  requirements, and §17 for reproducibility and portability expectations.
- `docs/ui.md` §3 for the routes and data flow behind the catalog and
  playground.

Continue with the [Quick start](/guide/quick-start) to use these concepts in the
[catalog](/) and the [playground](/playground).
