# Safe URL and JSON rulebook import

**Status:** Phase 1 implementation of the import slice by
[issue #30](https://github.com/ForkbombEu/credimi-attestbook/issues/30), extended by
[issue #31](https://github.com/ForkbombEu/credimi-attestbook/issues/31) with deterministic
re-import identity, idempotent re-import and conflict detection. It provides a bounded,
unauthenticated **preview** and an authenticated **draft import** for supported TS11/OWF
rulebook documents and catalog envelopes. It is not a conformance claim and does not
implement automatic source updates, the HTTP API, remote schema resolution, catalogue
signature verification or scheduled synchronization.

**Authoritative spec:** [`docs/specification.md`](specification.md) (FR-004, FR-005, §15)
**Requirements and research:** [`docs/requirements.md`](requirements.md) §FR-004/§FR-005 and
the SR-1–SR-5 security controls; [`docs/catalog-research.md`](catalog-research.md) §5–§7
**Decisions:** [`docs/implementation-plan.md`](implementation-plan.md) D-6 (digest and
change detection), D-11 (SRI and reference controls) and D-12 (separate
conformance/registration signals)
**Registry contract:** [`docs/registry.md`](registry.md)

## 1. Scope and boundaries

Implemented by #30:

- `https` URL import and local JSON import (string or bytes) as one preview pipeline;
- bounded remote retrieval with SSRF prevention, address pinning, redirect re-validation,
  timeouts, response-size limits and a restrictive content-type policy;
- bounded JSON parsing (depth, node count, string length) and catalog entry limits;
- support for a single SchemaMeta document, a bare entry array and the surveyed catalog
  envelopes `{ data | content | schemas | entries | rulebooks: [...] }`;
- structural validation through the pinned TS11/OWF adapter with every declared schema
  reference validated against https-only, length and fan-out limits;
- per-entry conformance classification and a compatibility report;
- source provenance retained in the preview and in the created rulebook
  (`sourceUrl`, retrieval time, adapter kind, byte length, SHA-256 of the exact source
  bytes, envelope shape, profile, conformance and a separate source conformance claim);
- authenticated import of a compatible preview as draft rulebooks, including their
  attestation type and schema references, in one registry transaction for the whole source.

Implemented by #31 (this slice):

- a deterministic **import identity** per source entry, stored on the rulebook as
  `rulebooks.import_key` and unique per provider, so duplicate detection does not depend on
  the source digest;
- **idempotent re-import**: re-importing unchanged normalized content writes nothing and
  returns the existing rulebook;
- **change detection and conflict reporting** for changed source content, locally edited
  drafts, rulebooks with published/historical versions and source version changes; the
  importer never overwrites local or published content;
- a reported `serialization_only_change` finding when the source bytes changed but every
  entry's normalized content stayed identical (R5.2, R-17);
- an entry `contentFingerprint` in the rulebook provenance, used to decide whether a draft
  was locally modified since the last import.

Deliberately **not** in #30/#31:

- automatic application of a changed source to an existing rulebook (a "safe update"). The
  importer reports the conflict and leaves resolution to the version lifecycle (#29) and
  the editor/API slices (#34, #37, #41); there is no invented version-label policy and no
  destructive write;
- conditional fetching, scheduled synchronization and source-availability diagnostics
  (FR-005 beyond idempotent safe re-import);
- the HTTP API, OpenAPI contract, write authorization at the HTTP layer and rate limiting
  — issues #34/#35;
- fetching, resolving or verifying `rulebookURI` or `schemaURIs`; SRI verification over
  fetched schema bytes remains delegated to OWF with a caller-supplied resolver, and this
  slice reports unresolved references as `not_tested`;
- JWS-signed catalogue responses, JWS/JWKS verification, SIROS/FIDES/EUDI-specific
  adapters and Markdown rulebooks;
- publication, version freezing and export — this slice stores draft rulebook content and
  provenance only. The exact source digest is retained in provenance, but the raw source
  bytes are not yet stored as a content-addressed version artifact; that belongs to the
  version/import follow-up slices.

## 2. Public service contract

`src/import/` exposes two operations. Neither is wired to the HTTP server yet.

```ts
const importer = new RulebookImporter({ registry })

const preview = await importer.preview({ kind: 'url', url: 'https://catalog.example/x.json' })
// or { kind: 'json', content: '<json text>', name?: 'schemas.json', sourceUrl?: 'https://…' }

const result = await importer.import(bearerToken, source)
```

- `preview(source)` is read-only and returns `ImportPreview`.
- `import(token, source)` authenticates the bearer token **before** any network request,
  re-runs the preview, refuses the whole source if any entry is incompatible, and then
  classifies every compatible entry against its import identity (§5). New entries are
  created through `Registry.createRulebooks`, which wraps them in one transaction;
  unchanged entries write nothing, and changed entries are reported as conflicts without a
  write. Source URL and provenance are stored on the created rulebook; provenance never
  enters a standards document.
- `ImportResult` carries the preview, one `ImportEntryResult` per entry (`created`,
  `unchanged` or `conflict`), the rulebooks created by this call, the reported
  `ImportConflict`s and source-level re-import diagnostics (§5). `result.rulebooks` is empty
  when a re-import changed nothing or only reported conflicts.

`ImportPreview` contains:

| Field | Meaning |
| --- | --- |
| `source.adapter` | `url` or `json` |
| `source.url` / `requestedUrl` | final URL (or JSON `sourceUrl`) and original URL before redirects |
| `source.retrievedAt`, `contentType`, `status` | retrieval provenance; `status` is `null` for JSON input |
| `source.byteLength`, `contentDigest` | exact source size and lowercase hex SHA-256 of the exact bytes |
| `source.redirects` | every redirect target followed, in order |
| `source.envelope` | `single`, `array` or `catalog` (with the member and bounded envelope metadata) |
| `entries[]` | per-entry structural status, profile, conformance, source signal, diagnostics, schema references, derived name/description/version and the canonical document |
| `compatibility` | aggregate safe-import decision, valid/invalid/incompatible entry counts, counts per conformance class, reference count and human-readable limitations |
| `diagnostics` | source-level findings; unresolved schema references are reported `not_tested` |

The derived rulebook name prefers a display `title`/`displayName`/`attestationType` member
(from the source or preserved unknown members), then falls back to the canonical `id` or
version. The source's conformance block is retained separately; AttestBook's classification
is never raised by a source claim.

## 3. Structural validation and conformance

Each entry is parsed with the real adapter in
[`src/standards/`](standards-adapter.md): profile detection, the OWF package for OWF
documents and the TS11 v1.0.1 translation. Structural errors are reported per entry, so a
catalog preview names every broken entry rather than only the first.

| Classification | Meaning |
| --- | --- |
| `conformant_subset` | parses and validates strictly against the pinned TS11 v1.0.1 subset the adapter implements |
| `partial` | structurally valid but uses the OWF 0.5.4 profile, preserves unknown members/values outside the pinned TS11 baseline, or reports itself as partial |
| `not_verified` | structurally invalid, or the source explicitly reports no verified conformance |
| `prose_only` | reserved for future prose/Markdown adapters; not produced by this JSON slice |

A source conformance claim can only **lower** the classification. A `partial` claim turns a
`conformant_subset` into `partial`; `none`/`unverified` becomes `not_verified`. A claim never
upgrades the result. The original claim (`level`, optional `missing` members) is kept in
`sourceConformance` and in the rulebook provenance.

## 4. Security controls

All mandatory import controls in specification §15 / requirements SR-1–SR-5 are enforced
in code before any registry write:

| Control | Implementation |
| --- | --- |
| Safe URL validation | absolute `https` only, default port 443, no embedded credentials, bounded length; fragments are stripped |
| SSRF prevention | IP literals are checked; DNS names are resolved once under the total fetch deadline and **every** answer must be public (loopback, private, link-local, CGNAT, multicast, reserved, documentation, 6to4/NAT64 ranges are blocked, including IPv4-mapped IPv6); a mixed public/private answer is rejected |
| DNS rebinding | the transport connects to the resolved address and uses the original hostname only for TLS SNI and the `Host` header; it does not let the HTTP stack resolve the hostname a second time |
| Redirect policy | manual redirects, at most 3, each target re-validated and re-resolved under the same rules; a non-https or private redirect is refused before it is fetched |
| Network timeouts | 10 s per request and 15 s total across redirects |
| Response size | 2 MiB maximum, checked against `Content-Length` and while streaming; a fake transport's oversized body is rejected again at the fetcher boundary |
| Content type | JSON (`application/json`, `*+json`, `text/json`) plus `text/plain` and `application/octet-stream` (raw GitHub hosts serve JSON as `text/plain`); HTML/XML and other types are refused |
| JSON parsing limits | 48 levels deep, 20 000 values, 256 KiB per string/member name, valid UTF-8 only, `__proto__` rejected, bounded source bytes |
| Catalog limits | at most 100 entries per source; each entry must be a JSON object |
| Schema-reference limits | at most 16 references per attestation entry, 2 048-character https URIs without credentials; OWF `meta`/unknown members are retained as registry-internal metadata |
| Recursive references | no `$ref` is resolved by this slice, so no remote recursion is executed; unresolved references are reported `not_tested` |
| Code execution | imported documents are data only: `JSON.parse` and the standards codecs; never `eval`, `Function` or dynamic import |
| Secret/data redaction | failures never echo document bytes; request payloads, headers and raw content are not logged |

Limits are exported as `DEFAULT_IMPORT_LIMITS` and can be overridden per call through
`ImportOptions.limits` (tests use small values). Production callers should keep the
defaults.

Residual risks: a compromised resolver remains trusted at fetch time; the transport pins
the validated address, so a later DNS change cannot redirect the connection. The preview is
unauthenticated at the service level; when #34/#35 expose it over HTTP it must require the
same write authentication and rate limits as import. Redirect
targets are resolved independently. The single-writer SQLite deployment limit is documented
in [`docs/implementation-plan.md`](implementation-plan.md) D-7.

## 5. Re-import identity, idempotency and conflicts

### 5.1 Import identity

Re-import must recognise the rulebook created by an earlier import of the same external
entry. The identity is deterministic and computed from the bounded, validated input only:

```text
source identity = requested https URL        (URL import)
                | caller-supplied source URL (JSON import with sourceUrl)
                | caller-supplied file name  (JSON import with name)
                | exact source digest        (anonymous JSON, see limitation below)
entry identity  = canonical SchemaMeta id
                | derived rulebook name
                | entry index
entry key       = SHA-256("attestbook.import-entry@1", source identity, entry identity)
```

The key is stored as `rulebooks.import_key` and is unique per provider through a partial
unique index (`migrations/0003_import_identity.sql`). Lookups
(`Registry.findImportedRulebook`) are scoped to the authenticated provider, so two providers
can import the same catalogue entry without sharing ownership (FR-003). The key is
import-internal product metadata: it never enters a version snapshot or a standards
document.

The source identity deliberately uses the **requested** URL, not the post-redirect final
URL, so a changed CDN redirect does not look like a new source. The final URL and every
redirect still feed the provenance and the content fingerprint below.

### 5.2 Content fingerprint

The source digest is byte-exact (D-6), so re-serialized JSON (key order or whitespace) has a
different digest. To separate that from a semantic change, every imported entry also stores
a **content fingerprint** in provenance (`contentFingerprint`): the SHA-256 over a canonical
JSON document containing the rulebook name, description, source URL, applicable profile and
each attestation type with its schema references and retained internal metadata. Object keys
are sorted recursively; array order stays significant. Provenance, timestamps and the import
key are excluded.

This is a comparison aid for change detection, not a claim of semantic identity,
canonicalization for storage, or standards conformance. It is computed from AttestBook's
validated input, not from the raw source document.

### 5.3 Re-import decision

| Existing rulebook for the entry | Incoming content | Outcome |
| --- | --- | --- |
| none | any compatible entry | `created`: written once, in one transaction with the other new entries |
| present | fingerprint equal, same source version, same source-byte digest | `unchanged`: idempotent no-op, nothing written |
| present | fingerprint equal, same source version, different source-byte digest | `unchanged` plus a source-level `serialization_only_change` diagnostic (R5.2, R-17) |
| present | fingerprint equal, different source version | conflict `source_version_changed` |
| present | fingerprint differs, rulebook has published or historical versions | conflict `published_content` (the version labels are listed) |
| present | fingerprint differs, stored draft differs from the last imported fingerprint | conflict `locally_modified` |
| present | fingerprint differs, draft is unmodified | conflict `source_changed` |

A conflict **never writes**. Every outcome leaves the existing rulebook, its attestations,
its schema references, its provenance and every version untouched. New sibling entries of
the same catalogue are still created (and unchanged siblings stay no-ops); the result lists
each entry's disposition independently.

An `ImportConflict` carries the reason code, a human-readable message, the rulebook id, the
preserved published/historical version labels, whether the draft was locally modified, the
existing and incoming content fingerprints, and the existing and incoming source versions.
Conflicts are returned to the caller; they are not persisted as a separate import-run
history in this slice, so the rulebook provenance remains the record of the import that
created it.

### 5.4 Concurrency

A duplicate rulebook cannot be created even by two concurrent imports: the partial unique
index on `(provider_id, import_key)` makes the second write fail. `createRulebooks` wraps
the new entries of one import in one transaction, so that failure rolls the whole batch back
and the importer reports the source as `import_rejected` instead of leaving a partial
catalogue. A retry then classifies the entry as `unchanged`. This relies on the documented
single-writer SQLite deployment (D-7).

### 5.5 Limitations

- A changed source is reported, not applied. Resolving a `source_changed` conflict means the
  provider explicitly advances the draft through the version lifecycle (`refresh`/`create`
  and `publish`, #29) or deletes the unversioned draft and re-imports; this slice invents no
  automatic version label and never rewrites content.
- Only documents with a stable identity are matched reliably. A source that renames the
  displayed rulebook and has no canonical `id`, a source that changes its canonical `id`, or
  a JSON import without `sourceUrl`/`name` whose bytes changed can be treated as a new entry
  and create a second rulebook. That is safe (nothing is overwritten) but duplicate detection
  cannot help; supplying `sourceUrl` or `name` is recommended for JSON imports.
- Rulebooks created by the pre-#31 import slice carry no `import_key`. Re-importing their
  source is treated as a new import (a new draft rulebook) rather than matched to them;
  there is no deterministic backfill because the old provenance did not record a stable
  entry identity at the required granularity.
- A source version change with identical normalized content is reported as a conflict rather
  than silently updating the stored provenance, so the caller sees that the source claims a
  new version.
- Conditional fetching (`ETag`/`Last-Modified`), scheduled synchronization, source
  availability diagnostics and signature verification are later FR-005 slices.

## 6. Provenance stored on import

For every created draft rulebook, `rulebook.sourceUrl` holds the final URL for URL imports
(or the caller-supplied `sourceUrl` for JSON imports) and `rulebook.provenance` holds:

```json
{
  "adapter": "url",
  "sourceUrl": "https://catalog.example/x.json",
  "requestedUrl": "https://catalog.example/x.json",
  "retrievedAt": "2026-11-05T10:00:00.000Z",
  "contentType": "application/json",
  "byteLength": 812,
  "contentDigest": "<lowercase hex sha256 of the exact source bytes>",
  "redirects": [],
  "envelope": { "kind": "catalog", "member": "data", "metadata": { "schemaVersion": "2.0.0" } },
  "entryIndex": 0,
  "sourceId": "…",
  "sourceVersion": "1.0.0",
  "profile": "ts11@1.0.1",
  "conformance": "conformant_subset",
  "sourceConformance": { "level": "partial", "missing": ["attestationLoS"] },
  "contentFingerprint": "<lowercase hex sha256 of the normalized rulebook content>",
  "importedAt": "2026-11-05T10:05:00.000Z"
}
```

The digest identifies the exact source bytes, compensating for the surveyed catalogs not
publishing a reliable per-entry digest. `contentFingerprint` identifies the normalized
content and is the basis for local-edit detection on re-import (§5). Both are product
metadata and are never merged into a TS11/OWF document or a version snapshot. Publication
authority is not inferred from the source URL (FR-003); the importing provider owns the
created draft.

## 7. Verification

Offline fixtures and injected transport/resolver keep the suite deterministic:

- `src/import/url.test.ts` — https-only/default-port/credential rules, private/link-local/
  metadata/mapped-IPv6 address blocking, mixed-answer rejection, DNS failure;
- `src/import/http.test.ts` — JSON content type, oversized body, public redirects, private
  and non-https redirect refusal, redirect limit, HTTP status, timeout, blocked initial URL
  never reaching the transport;
- `src/import/http-transport.test.ts` — the real TLS transport against a local self-signed
  server: pinned address/`Host`, certificate mismatch rejection, streaming byte cap,
  per-request timeout and redirects returned without being followed;
- `src/import/json.test.ts` — invalid JSON/UTF-8, byte/depth/node/string limits,
  `__proto__` rejection, UTF-8 BOM;
- `src/import/preview.test.ts` — valid TS11 and OWF documents, SIROS `data` / FIDES
  `content` / bare-array envelopes, invalid entries, source conformance downgrade,
  schema-reference count/scheme/length limits, invalid catalog and entry limits,
  provenance for URL and JSON sources;
- `src/import/importer.test.ts` — authenticated URL/OWF/catalog imports, retained source URL
  and digest, persisted attestation/schema references and OWF meta, all-or-nothing refusal
  and authentication before the network;
- `src/import/reimport.test.ts` — idempotent re-import of unchanged bytes, a serialization-only
  source change, JSON source-URL identity, provider-scoped identity, and the four conflict
  codes (changed source, locally edited draft, published version, source version change),
  including a grown/changed catalogue with mixed `unchanged`/`created`/`conflict` outcomes;
- `src/registry/import-identity.test.ts` — import key persistence, per-provider uniqueness at
  service and SQL level, cross-provider isolation, lookup scoping, invalid-key rejection and
  exclusion of the identity from a version snapshot;
- `src/registry/create-rulebook-refs.test.ts` — transactional creation of attestation
  schema references, duplicate-format and per-attestation fan-out rejection, rollback.

Run the suite with `bun run check`. These tests demonstrate the #30/#31 acceptance criteria;
they do not claim TS11 conformance, catalogue signature verification, automatic source
updates, full FR-005 synchronization or interoperability.

## 8. Related work

- Issues [#34](https://github.com/ForkbombEu/credimi-attestbook/issues/34) and
  [#35](https://github.com/ForkbombEu/credimi-attestbook/issues/35) — REST/OpenAPI surface
  and HTTP write security, which will expose the per-entry import result.
- Issues [#37](https://github.com/ForkbombEu/credimi-attestbook/issues/37) and
  [#41](https://github.com/ForkbombEu/credimi-attestbook/issues/41) — version history and
  the editor workflow that resolves a reported conflict.
- Issue [#52](https://github.com/ForkbombEu/credimi-attestbook/issues/52) — further remote
  import hardening.
