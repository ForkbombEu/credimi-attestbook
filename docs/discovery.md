# Bounded issuer metadata discovery

**Status:** Phase 3 implementation of the issuer discovery slice by
[issue #43](https://github.com/ForkbombEu/credimi-attestbook/issues/43). It retrieves an
OpenID4VCI Credential Issuer's well-known metadata under the same untrusted-input controls as
rulebook import, validates the members it uses, extracts supported credential configurations
and reports candidate associations with exact published or historical rulebook versions. It is
a read-only observation of what an issuer declared at retrieval time, **not** a rulebook, a
conformance claim or a trust decision.

**Authoritative spec:** [`docs/specification.md`](specification.md) FR-006 and §15
**Requirements and research:** [`docs/requirements.md`](requirements.md) §FR-006 and the
SR-1–SR-5 controls; [`docs/catalog-research.md`](catalog-research.md) §5.4
**Related:** [`docs/api.md`](api.md) (HTTP contract), [`docs/import.md`](import.md) (shared
bounded transfer controls), [`docs/security.md`](security.md) (write/read authorization),
[`docs/registry.md`](registry.md) (version and digest model)

## 1. Scope and boundaries

Implemented by #43:

- derivation and bounded retrieval of `/.well-known/openid-credential-issuer` from a
  Credential Issuer Identifier;
- the untrusted-import transfer controls: https only, public-address pinning, redirect
  re-validation, total deadline, per-request timeout, response-size cap, restrictive
  content-type policy and bounded JSON depth/node/string parsing;
- validation of `credential_issuer`, `credential_endpoint`, `authorization_servers` and each
  supported credential configuration;
- extraction of the credential format, type identifiers (`vct`, `doctype`, legacy `type`
  values) and exposed schema references;
- version-aware reading of the OpenID4VCI 1.0 `credential_configurations_supported` object and
  the earlier `credentials_supported` shape (array or object);
- candidate association with exact published or historical rulebook versions, with explicit
  `matched`, `ambiguous` and `unmatched` reporting and a per-configuration reason when no
  candidate exists;
- the authenticated `POST /api/v1/issuers/discover` route and its OpenAPI components.

The pinned OWF package's FR-006 helpers (`buildCredentialConfigurationTemplate` and
`validateIssuerMetadataAgainstProfile`) are issuer-side catalogue-to-metadata helpers that
operate on a `SchemaMeta`; they are not metadata discovery and are not used here. Discovery
makes no OWF-profile or TS11 conformance claim.

Deliberately **not** in #43 (spec FR-006 items 7 and beyond, and later integrations):

- persistence of discovered issuers, snapshots of issuer metadata or an explicit manual
  mapping store. The result is returned to the caller and nothing is written;
- authenticating or verifying signed/JWT-secured issuer metadata, issuer trust, key material
  or authorization-server metadata;
- fetching or resolving the exposed schema references, `vct` type metadata or `schema_uri`
  documents;
- issuer test fixtures, credential generation or protocol execution (FR-013, #44);
- treating an association as a conformance, authorization or interoperability result.

## 2. Public service contract

`src/discovery/` exposes `IssuerDiscovery`:

```ts
const discovery = new IssuerDiscovery({ rulebooks: registry })
const result = await discovery.discover('https://issuer.example')
```

The service writes nothing. `discover` takes the untrusted issuer identifier, returns
`IssuerDiscoveryResult`, and throws a typed `ImportError` when the URL is unsafe, the fetch
fails or the metadata document is not a supported OpenID4VCI object. Per-configuration
problems are diagnostics, so one malformed entry does not hide the valid ones.

`IssuerDiscoveryResult` contains:

| Field | Meaning |
| --- | --- |
| `source.issuerIdentifier` | Normalized issuer identifier used for the `credential_issuer` comparison. |
| `source.metadataUrl`, `requestedUrl`, `finalUrl` | Derived well-known URL, requested URL and the final URL after redirects. |
| `source.retrievedAt`, `contentType`, `status`, `byteLength` | Retrieval provenance. |
| `source.contentDigest` | Lowercase hex SHA-256 of the exact retrieved bytes. |
| `source.redirects` | Every redirect target followed, in order. |
| `source.metadataShape` | `oid4vci_1_0` or `oid4vci_legacy`. |
| `issuer` | Bounded projection: `credentialIssuer`, `credentialEndpoint`, `authorizationServers`. |
| `configurations[]` | Extracted format, display name, type identifiers, schema references and `mapping`. |
| `summary` | Total/valid/invalid configuration counts and matched/ambiguous/unmatched counts. |
| `diagnostics[]` | Safe findings for invalid configurations, bounded members and unusable stored versions. |
| `limitations[]` | The boundaries in §8. |

## 3. Metadata URL and supported shapes

The Credential Issuer Identifier is validated as an absolute `https` URL without embedded
credentials, a query component or a fragment, under the import URL policy. OpenID4VCI 1.0
§12.2.2 inserts `/.well-known/openid-credential-issuer` between the host and the path, so
`https://issuer.example/tenant` is served at
`https://issuer.example/.well-known/openid-credential-issuer/tenant`. A URL that already names
that 1.0-form document is accepted as-is. The earlier appended-path form
(`https://issuer.example/tenant/.well-known/openid-credential-issuer`) is still accepted for
older deployments; a legacy issuer that only serves that form must be given its explicit
metadata URL. In both explicit cases the path prefix becomes the issuer identifier.

The retrieved document must declare `credential_issuer`, which must normalize to the derived
issuer identifier. A mismatch is an invalid metadata document rather than a silent association.
The supported configuration members are:

- OpenID4VCI 1.0: `credential_configurations_supported` as an object keyed by configuration id;
- earlier drafts: `credentials_supported` as an array or object.

Any other metadata shape is reported as invalid. Membership is bounded: at most 200
configurations, 32 type identifiers and 16 schema references per configuration, and at most 16
authorization servers. These are product safety bounds, not OpenID4VCI limits.

## 4. Extraction rules

- `format` is required and retained as text.
- **Type identifiers.** `vct` (SD-JWT VC, a case-sensitive StringOrURI such as
  `urn:eudi:pid:1` or an `https` URL), `doctype` or `doctype_value` (mdoc), and the legacy
  `types` / `credential_definition.type` string array. A `vct` is kept verbatim: only an empty,
  control-containing or over-length value is invalid, and a non-string member is reported at
  `${configuration}.vct`. A configuration that declares no type identifier is reported invalid.
- **Schema references.** An `https` `vct` is exposed as a schema/type-metadata reference; a
  non-URL StringOrURI `vct` (for example the EUDI PID `urn:eudi:pid:1`) is a valid type
  identifier with no fetchable reference and therefore adds none. The optional extension
  members `schema`, `schema_uri`, `schemaUri`, `schema_url`, `schemaUrl` and `schemaURI` are
  also accepted when they are absolute `https` URLs; they are profile extensions, not
  OpenID4VCI 1.0 core members. Unknown members are ignored.
- **Display name.** The first entry of `display` with a bounded `name` is retained for humans
  and is never used for matching.
- No member is executed, resolved or fetched, and the raw document is never echoed.

## 5. Association and pinning policy

Association is heuristic and conservative:

1. Only **published or historical** versions are candidates. Drafts are mutable working copies
   and are never mapping targets.
2. A candidate must support the configuration's format and record a schema-reference URI equal
   to one of the configuration's type identifier values **for the same format**. For an `https`
   `vct`, the normalized value from its schema-reference projection is also compared, so URL
   case normalization cannot hide a match. The snapshot's schema-reference URIs are the frozen
   identifiers available to a version; a rulebook that records a type identifier only in
   mutable internal metadata cannot be matched.
3. Several matching versions of the **same rulebook** collapse to its current version: a
   published version is preferred over a historical one, then the latest `publishedAt`.
4. If exactly one rulebook remains, the mapping is `matched`; if several remain, it is
   `ambiguous` and every candidate is listed; if none remain, it is `unmatched` with a reason.
5. Every candidate is an exact pin: `rulebookId`, `rulebookName`, `version`, `contentDigest`
   (the SHA-256 of the stored snapshot bytes) and `specVersion`. A later working-copy edit
   cannot change what a pinned version means.

The result is ordered deterministically (configurations in metadata order, candidates by
rulebook name then id), so the same registry state and metadata bytes produce the same
association.

## 6. Security controls

Discovery reuses the import pipeline's §15 controls rather than a second fetch implementation:

| Control | Behaviour |
| --- | --- |
| URL policy | Absolute `https`, no credentials, default port, no query/fragment, bounded length. |
| SSRF / DNS rebinding | Every resolved address must be public; the transport connects to the pinned address with the original hostname as TLS SNI. |
| Redirects | Followed manually and re-validated; private, non-https and over-limit targets are refused. |
| Time and size | Per-request timeout, total wall-clock deadline and a response-size cap. |
| Parsing | Bounded JSON depth, node count and string length; no evaluation. |
| Content type | `application/json`, `application/*+json`, `text/json`, `text/plain`, `application/octet-stream` and a missing content type are accepted; HTML and other declared binary types are refused. |
| Privacy | Only the bounded result projection is returned: retrieval provenance, redirect entries, bounded issuer fields and extracted references. Raw metadata bytes are not logged or returned, and references are never fetched. |

The outbound fetch is gated by a provider bearer token on the HTTP route, like the import
preview.

## 7. HTTP API

`POST /api/v1/issuers/discover` requires a provider bearer token and a JSON body:

```json
{ "credentialIssuer": "https://issuer.example" }
```

The response is `{ "data": <IssuerDiscoveryResult> }`. Failures use the normal error envelope:
`400 invalid_request` for an unsafe/invalid issuer URL or body, `401 unauthorized` without a
token, `422 import_rejected` for invalid issuer metadata or a bound breach, `502
import_fetch_failed` for a failed retrieval, and `503 registry_unavailable` when the service is
not configured. The generated OpenAPI document exposes the same contract.

## 8. Verification

Run from the repository root:

```
bun test src/discovery src/api/discovery.test.ts
bun run typecheck
bun run openapi:check
```

- `src/discovery/metadata.test.ts` covers well-known URL derivation, identifier normalization,
  both metadata shapes, type-identifier and schema-reference extraction, display names,
  invalid/malformed configurations, member bounds and `credential_issuer` mismatch.
- `src/discovery/mapping.test.ts` covers pinned candidates, draft exclusion, current-version
  preference, ambiguous/unmatched reporting and corrupt-snapshot handling.
- `src/discovery/discover.test.ts` runs the service against a real temporary SQLite registry
  and an offline transport: pinned association, ambiguity, legacy shape, the 1.0 tenant URL
  derivation, URN `vct` handling, non-https refusal, size and content-type bounds, invalid JSON,
  redirect re-validation and private-target blocking.
- `src/api/discovery.test.ts` exercises the real Hono application, bearer middleware and error
  mapping, and validates the response against the generated OpenAPI component.

## 9. Limitations and next slices

- Association is heuristic: it can only use the identifiers frozen in a version snapshot. The
  registry requires schema-reference URIs to be absolute `http(s)` URLs, so a bare mdoc
  `doctype` that is recorded only as internal metadata cannot be matched; such configurations
  are reported `unmatched`.
- Only the OpenID4VCI 1.0 and earlier `credentials_supported` shapes are understood. Other
  drafts, name-spaced extensions and JWT-secured metadata are not supported and are reported
  as invalid or unmatched rather than guessed.
- The mapping index is rebuilt for each discovery call and parses every published or historical
  snapshot in memory, with no size cap or cache. A store-level version query or a cache keyed by
  `contentDigest` is a later optimisation; it is not needed for the bounded request itself but
  should be revisited before large registries.
- Manual mapping and discovered-issuer persistence require a storage and API decision and are
  left to a follow-up slice; this slice reports candidates only.
- There is no HTTP rate limiting, so an authenticated provider can repeat a bounded outbound
  fetch. The transfer limits still apply to every call; rate limiting remains the shared
  hardening tracked in [`docs/security.md`](security.md) §8.
- No reference is fetched or verified, no signature is checked and no trust or conformance
  claim is derived from issuer metadata.
