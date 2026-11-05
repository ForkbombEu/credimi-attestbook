# Safe URL and JSON rulebook import

**Status:** Phase 1 implementation of the initial import slice by
[issue #30](https://github.com/ForkbombEu/credimi-attestbook/issues/30). It provides a
bounded, unauthenticated **preview** and an authenticated **draft import** for supported
TS11/OWF rulebook documents and catalog envelopes. It is not a conformance claim and does
not implement re-import conflict handling, the HTTP API, remote schema resolution or
catalogue signature verification.

**Authoritative spec:** [`docs/specification.md`](specification.md) (FR-004, §15)
**Requirements and research:** [`docs/requirements.md`](requirements.md) §FR-004 and the
SR-1–SR-5 security controls; [`docs/catalog-research.md`](catalog-research.md) §5–§7
**Decisions:** [`docs/implementation-plan.md`](implementation-plan.md) D-11 (SRI and
reference controls) and D-12 (separate conformance/registration signals)
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
  attestation type and schema references, in one registry transaction per rulebook.

Deliberately **not** in #30:

- idempotent re-import, duplicate/version conflict diagnostics and safe updates — issue
  #31; #30 only creates the initial draft and never updates an existing rulebook;
- the HTTP API, OpenAPI contract, write authorization at the HTTP layer and rate limiting
  — issues #34/#35;
- fetching, resolving or verifying `rulebookURI` or `schemaURIs`; SRI verification over
  fetched schema bytes remains delegated to OWF with a caller-supplied resolver, and this
  slice reports unresolved references as `not_tested`;
- JWS-signed catalogue responses, JWS/JWKS verification, SIROS/FIDES/EUDI-specific
  adapters, Markdown rulebooks and periodic synchronization (FR-005);
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
  creates one draft rulebook per entry through `Registry.createRulebook`. Source URL and
  provenance are stored on the rulebook; provenance never enters a standards document.

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
| SSRF prevention | IP literals are checked; DNS names are resolved once and **every** answer must be public (loopback, private, link-local, CGNAT, multicast, reserved, documentation, 6to4/NAT64 ranges are blocked, including IPv4-mapped IPv6); a mixed public/private answer is rejected |
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

## 5. Provenance stored on import

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
  "importedAt": "2026-11-05T10:05:00.000Z"
}
```

The digest identifies the exact source bytes, compensating for the surveyed catalogs not
publishing a reliable per-entry digest. Provenance is product metadata and is never merged
into a TS11/OWF document. Publication authority is not inferred from the source URL (FR-003);
the importing provider owns the created draft.

## 6. Verification

Offline fixtures and injected transport/resolver keep the suite deterministic:

- `src/import/url.test.ts` — https-only/default-port/credential rules, private/link-local/
  metadata/mapped-IPv6 address blocking, mixed-answer rejection, DNS failure;
- `src/import/http.test.ts` — JSON content type, oversized body, public redirects, private
  and non-https redirect refusal, redirect limit, HTTP status, timeout, blocked initial URL
  never reaching the transport;
- `src/import/json.test.ts` — invalid JSON/UTF-8, byte/depth/node/string limits,
  `__proto__` rejection, UTF-8 BOM;
- `src/import/preview.test.ts` — valid TS11 and OWF documents, SIROS `data` / FIDES
  `content` / bare-array envelopes, invalid entries, source conformance downgrade,
  schema-reference count/scheme/length limits, invalid catalog and entry limits,
  provenance for URL and JSON sources;
- `src/import/importer.test.ts` — authenticated URL/OWF/catalog imports, retained source URL
  and digest, persisted attestation/schema references and OWF meta, all-or-nothing refusal
  and authentication before the network;
- `src/registry/create-rulebook-refs.test.ts` — transactional creation of attestation
  schema references, duplicate-format and per-attestation fan-out rejection, rollback.

Run the suite with `bun run check`. These tests demonstrate the #30 acceptance criteria;
they do not claim TS11 conformance, catalogue signature verification, full FR-005
synchronization or interoperability.

## 7. Related work

- Issue [#31](https://github.com/ForkbombEu/credimi-attestbook/issues/31) — idempotent
  re-import and conflict detection.
- Issues [#34](https://github.com/ForkbombEu/credimi-attestbook/issues/34) and
  [#35](https://github.com/ForkbombEu/credimi-attestbook/issues/35) — REST/OpenAPI surface
  and HTTP write security.
- Issue [#52](https://github.com/ForkbombEu/credimi-attestbook/issues/52) — further remote
  import hardening.
