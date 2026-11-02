# External Catalog & Discovery/Import Interoperability — Phase 0 Research

**Status:** Draft (Phase 0 research only — no implementation, no merge)  
**Ticket:** [Issue #3 — Survey external catalogs and discovery/import interoperability](https://github.com/ForkbombEu/credimi-attestbook/issues/3)  
**Survey date:** 2026-11-02 (UTC)  
**Method:** Read-only inspection of public Git repositories (`gh`), public web pages and live machine-readable endpoints (`curl`). No external system was modified.

* * *

## 1. Purpose and scope

AttestBook must import rulebooks and credential metadata from external catalogs, and discover issuer metadata (specification [section 6, FR-004/FR-005/FR-006](specification.md)). This document records what the candidate catalogs and reference implementations **actually** expose — their URLs, availability, authentication, data structures, and version/provenance signals — so the Phase 1 importer can be built on verified facts rather than assumptions.

It covers the sources named in the issue: **SIROS**, **EUDIPLO**, **FIDES**, the **EUDI reference implementation** rulebooks catalog, and **Sphereon**. One closely related source (**WE BUILD consortium**) is noted because it feeds the SIROS registry.

Scope limits: this is research and a recommendation, not an implementation. Requirements derived from it are recorded in [`docs/requirements.md`](requirements.md). TS11/ETSI normative conformance itself is verified in the standards ticket ([#2](https://github.com/ForkbombEu/credimi-attestbook/issues/2)); this document only reports what each source *claims* and what was *observed*.

* * *

## 2. Summary

| Source | Kind | Machine-readable | TS11 claim (self/observed) | Auth | Integrity/signing |
|---|---|---|---|---|---|
| EUDI Wallet rulebooks catalog (`eu-digital-identity-wallet/eudi-doc-attestation-rulebooks-catalog`) | Official rulebook collection | No (Markdown only) | None made | Public | None |
| SIROS Credential Type Registry (`registry.siros.org`) | Community catalog | Yes (JSON API) | "read-only subset of ETSI TS11 §5" (observed: TS11-shaped SchemaMeta) | Public | JWS documented, **not enabled** (JWKS 404) |
| FIDES Community Credential Catalog (`fides.community`, `FIDEScommunity/fides-credential-catalog`) | Community catalog | Yes (JSON + signed API) | Self-reported **partial** conformance (observed) | Public | ES256 JWS on `schemas` endpoint + published JWKS |
| EUDIPLO (`EUDIPLO/eudiplo`, `openwallet-foundation/eudiplo`) | Reference EUDI Wallet implementation | Yes (OID4VCI issuer metadata) | Uses `@owf/eudi-attestation-schema`; marks TS11 "experimental" | Public | OAuth-protected metadata |
| Sphereon (`sphereon-opensource/oid4vc`) | OID4VC SDK (issuer/holder/RP) | Yes (OID4VCI metadata, library) | None (protocol library, not catalog) | Public | JWS-signed metadata support |
| WE BUILD consortium (`webuild-consortium/wp4-trust-group`) | Catalogue of attributes + schemes | Yes (Markdown + service spec) | TS11-aligned; feeds SIROS | Public | None |

Two of the five named sources are **not catalogs**: EUDIPLO and Sphereon are implementations/SDKs that AttestBook would interact with through **issuer metadata discovery** (FR-006), not through bulk catalog import. This distinction drives the recommended adapter split in section 5.

* * *

## 3. Per-source findings

### 3.1 EUDI Wallet Attestation Rulebooks Catalog (EUDI reference implementation)

- **Repository:** <https://github.com/eu-digital-identity-wallet/eudi-doc-attestation-rulebooks-catalog>
- **Description:** "Collection of EUDI Wallet rulebooks". Default branch `main`; last updated 2026-08-11.

**Actual structure (observed tree):**

```
README.md
template/attestation-rulebook-template.md
rulebooks/mdl/{README.md, mdl-rulebook.md}
rulebooks/pid/{README.md, pid-rulebook.md}
```

**Findings:**

- The official EUDI Wallet rulebooks are **Markdown documents**, not JSON and not TS11 SchemaMeta. There is no machine-readable index, no JSON export and no API.
- Only two rulebooks are published (PID and mDL); the `template/` directory carries the authoring template (currently at template version 1.5, dated 08-07-2026).
- Version and provenance signals are **human-authored Markdown tables** (a `Version | Date | Description` table and an author block). There is no stable machine-readable identifier, digest or signing. The template references ARF requirements (`ARB_xx`, `[Topic 12]`) and Implementing Regulation (EU) 2024/2977, and (as of template v1.5) requires URLs for Attestation Status Lists / Attestation Revocation Lists.
- **Authentication:** none (public GitHub).
- **TS11 conformance:** none claimed; the catalog is prose-first, and its rulebooks are the *policy* source that machine-readable catalogs (SIROS, FIDES) partially mirror.

**Import implication:** the EUDI rulebooks catalog is a **URL/Markdown import** target, not a schema import. AttestBook needs a Markdown→normalized-model importer (best-effort, clearly flagged as non-structural) or must treat this source as reference documentation rather than executable metadata. **Verified: not machine-readable.**

### 3.2 SIROS Credential Type Registry

- **Registry:** <https://registry.siros.org>
- **Foundation:** <https://siros.org> (SIROS Foundation, Stockholm). `info@siros.org`.
- **Publishing model:** "Built on GitHub and Markdown. Open to all." Contributors publish credential metadata via Git PRs; a `registry-cli` rebuilds the registry periodically (last build observed: 2026-11-02T12:08:06Z).

**Machine-readable API (base `https://registry.siros.org/api/v1`):**

| Endpoint | Purpose |
|---|---|
| `GET /schemas` → `schemas.json` | All TS11-compliant attestation schemas (SchemaMeta array) |
| `GET /schemas/{uuid}` → `schemas/{uuid}.json` | Single SchemaMeta |
| `GET /orgs` → `orgs.json` | Organization index (SIROS extension, **not TS11**) |
| `GET /orgs/{org}/schemas` | Org-scoped TS11-compliant schemas |
| `GET /attributes` → `attributes.json` | Catalogue of Attributes (TS11 §4.2); query `limit`, `offset`, `nameSpace`, `identifier` |
| `GET /attributes/{id}` | Single attribute |
| `GET /api/v1/openapi.yaml` | OpenAPI 3.1.0 ("Catalogue of Attestations API") |

**Observed data shape** (`schemas.json`, 32 entries at survey time; the registry home page reports 51 credentials across 7 organizations, of which 32 are marked TS11-compliant):

```json
{
  "data": [
    {
      "id": "2e5a14fb-3ddb-51a5-9efa-51806cb8ac5e",
      "version": "1.5",
      "attestationLoS": "iso_18045_high",
      "bindingType": "key",
      "supportedFormats": ["dc+sd-jwt"],
      "schemaURIs": [
        { "formatIdentifier": "dc+sd-jwt",
          "uri": "https://registry.siros.org/sirosfoundation/demo_pid_rb_1_5.vctm.json" }
      ],
      "rulebookURI": "https://registry.siros.org/sirosfoundation/demo_pid_rb_1_5/rulebook.html"
    }
  ]
}
```

Per-format payloads referenced by `schemaURIs`:

- **SD-JWT VC** — VCTM JSON (`*.vctm.json`): `{ "vct", "name", "description", "display": [ {locale, name, description, rendering: {simple: {logo: {uri: "data:image/png;base64,..."}}}} ] }`. Note: display logos are **embedded `data:` URIs**, a response-size/parse concern (see section 6).
- **mso_mdoc** — `{ "format": "mso_mdoc", "doctype", "display": [...], "claims": { "<namespace>": { "<element>": { "mandatory", "value_type", "display" } } } }`.
- **W3C VC** (`jwt_vc_json`) — JSON Schema.

`attributes.json` entries (Catalogue of Attributes): `{ "identifier": "urn:siros:attr:iss:33fd6b23", "name": [{value, lang}], "nameSpace", "distributions": [{accessURL, mediaType}], "x-usedBy": [{schemaId, org, slug, name}] }`.

**Availability / transport:** served via GitHub Pages (`server: GitHub.com`), `cache-control: max-age=600`, `etag`, `last-modified`, CORS `*`. Conditional fetching is supported (ETag / Last-Modified) — relevant to FR-005.

**Integrity:** the OpenAPI description states "GET responses are JWS compact serialization (RFC 7515) when signing is configured, or plain JSON otherwise", and the API reference advertises `.jwt` variants plus a JWKS at `.../api/v1/.well-known/jwks.json`. **Observed: signing is not currently enabled** — `schemas.json` returns plain JSON and the JWKS URL returns 404. This is a documented-but-not-observable feature; do not assume signed responses.

**Conformance:** self-described as "a read-only subset of the ETSI TS11 Catalogue of Attestations specification" (registry home page) and "TS11-compliant API … implementing the read-only subset of ETSI TS11 Section 5" (OpenAPI). Observed fields align with a TS11 SchemaMeta subset (`id`, `version`, `attestationLoS`, `bindingType`, `supportedFormats`, `schemaURIs`, `rulebookURI`). **Verified: TS11-shaped subset; not independently re-validated against TS11 §5 here** (see #2).

### 3.3 FIDES Community Credential Catalog

- **Website:** <https://fides.community/ecosystem-explorer/credential-catalog/> (WordPress; JSON-LD `schema.org` embedded; ~50 credentials listed).
- **Repository:** <https://github.com/FIDEScommunity/fides-credential-catalog> — "Searchable catalog of verifiable credential schemas with WordPress plugin UI, TypeScript crawler, and machine-readable JSON output." No license file in repo root (README states Apache-2.0; treat license as **unverified**).
- **Homepage / live API:** <https://fides-credential-catalog.vercel.app>

**Data model (per-authority `community-catalogs/<org>/credential-catalog.json`, `$schema` v1/v2):**

```json
{
  "$schema": "https://fides.community/schemas/credential-catalog/v2",
  "credentials": [ {
    "id": "cred:fides:brp",
    "aliasIds": ["cred:fides:brp:sd-jwt-vc"],
    "slug": "fides-brp",
    "displayName": "BRP Attestation",
    "authority": { "name": "FIDES Labs", "url": "https://fides.community" },
    "subjectType": "Person",
    "vcFormat": "sd_jwt_vc",
    "nativeIdentifier": "urn:org:fides:brp:1",
    "nativeIdentifierType": "vct",
    "schemaUrl": "https://raw.githubusercontent.com/FIDEScommunity/FIDES-credential-schemas/main/vct-schemas/brp/1/FIDES.brp.schema.json",
    "schemaType": "JSON Schema",
    "version": "1",
    "attestationTypeId": "cred:fides:brp",
    "formats": [ { "formatIdentifier": "sd_jwt_vc", "nativeIdentifier": "urn:org:fides:brp:1",
                   "nativeIdentifierType": "vct",
                   "schemaURIs": [ { "formatIdentifier": "sd_jwt_vc", "uri": "...", "schemaType": "JSON Schema" } ],
                   "credentialId": "cred:fides:brp:sd-jwt-vc" } ],
    "tags": ["brp"], "sectors": ["public_sector"], "ecosystems": ["eudi_wallet"],
    "themes": ["person_identity"], "category": "identity"
  } ]
}
```

Credential IDs follow `cred:<authorityCode>:<credentialKey>:<formatCode>` (e.g. `cred:fides:brp:sd-jwt-vc`); `nativeIdentifier` is the VCT URN. Schemas live in a separate repo (`FIDEScommunity/FIDES-credential-schemas`). A crawler enriches each entry with attributes flattened from the linked JSON Schema and writes `data/aggregated.json` (observed: 1.4 MB, `schemaVersion: "2.0.0"`, `catalogType: "credential"`, `lastUpdated` timestamp).

**Public API (Vercel serverless):**

| Endpoint | Response |
|---|---|
| `GET /api/public/credentialtype` | **Unsigned JSON** `{ content: [...], page: {...} }` — display/kind/format, with `attestationTypeId`, `hasIssuers`, `issuerCount` |
| `GET /api/public/schemas` | **JWS-signed (ES256, `kid: fides-cat-2026-v1`)** `{ content: [...] }` of TS11-shaped SchemaMeta |
| `GET /api/public/credentialcategory` | Categories |
| `GET /api/public/api-docs` | OpenAPI 3.1.0 |
| `GET /.well-known/jwks.json` | Public JWKS (P-256, `kid: fides-cat-2026-v1`) |

The signed `schemas` payload maps each credential to a TS11-shaped object with an **explicit self-reported conformance** block (decoded from the observed JWS):

```json
{ "id": "a4e48ddb-c5ee-591e-8237-7d620bab2bd4",
  "attestationType": "cred:eduwallet:academic-base",
  "title": "Academic Base Credential (ABC)",
  "description": "…", "version": "1.0.0",
  "supportedFormats": ["dc+sd-jwt"],
  "schemaURIs": [ { "formatIdentifier": "dc+sd-jwt", "uri": "https://raw.githubusercontent.com/…/academic-base-sd-jwt.schema.json" } ],
  "trustedAuthorities": [],
  "conformance": { "level": "partial",
                   "missing": ["rulebookURI", "attestationLoS", "bindingType", "trustedAuthorities"] },
  "fides": { "attestationTypeId": "cred:eduwallet:academic-base", "sectors": ["education"],
             "ecosystems": ["eudi_wallet"], "themes": ["education"], "category": "identity", "updatedAt": "…" }
}
```

**Key finding:** FIDES is the only surveyed source that **self-reports partial TS11 conformance** (`conformance.level: "partial"` and the missing fields are enumerated). Some `schemaURIs` point not at JSON Schemas but at a live OpenID4VCI issuer metadata URL (e.g. `https://agent.dev.eduwallet.nl/uvh/.well-known/openid-credential-issuer`), so the "schema" field is a heterogeneous reference. **Verified: signed API, published JWKS, and honest partial-conformance signaling — this is the strongest pattern to emulate.**

### 3.4 EUDIPLO

- **Repositories:** <https://github.com/EUDIPLO/eudiplo> (canonical) and <https://github.com/openwallet-foundation/eudiplo> (mirror). Apache-2.0.
- **Description:** "Your diplomatic layer for EUDI Wallet integration." A NestJS reference EUDI Wallet implementation (issuer + verifier backend).

**Relevance:** EUDIPLO is **not a catalog**; it is a reference implementation that AttestBook would target for **issuer metadata discovery** (FR-006) and as a compatibility reference for the mandatory OWF package.

Observed evidence (repository tree):

- `apps/backend/src/issuer/configuration/credentials/dto/schema-meta-config.dto.ts` **imports `SchemaURIMeta` from `@owf/eudi-attestation-schema`** — the same mandatory package AttestBook must use — and defines `SchemaUriEntry`, `TrustAuthorityEntry`, `AttestationLoS`, `SchemaMetaBindingType`, `SchemaMetaFrameworkType` for TS11 SchemaMeta generation. Its doc comment states the underlying TS11 spec is **"not yet finalized"** (`@experimental`).
- DB migrations `…-AddSchemaMetaToCredentialConfig` show SchemaMeta is stored per credential configuration.
- `apps/backend/src/issuer/issuance/oid4vci/` implements OpenID4VCI, including `application/build-issuer-metadata.ts` and `adapters/configured-issuer-metadata-sources.ts`, i.e. it **serves OpenID4VCI issuer metadata** for discovery.
- `apps/backend/src/auth/dto/oidc-discovery.dto.ts` (OIDC discovery) is separate from OID4VCI.

**Import/discovery implication:** issuer discovery against EUDIPLO follows standard OpenID4VCI: fetch `/.well-known/openid-credential-issuer` (OAuth-protected / signed metadata possible), extract `credential_configurations_supported` and their `credentialDefinition`/`format`/`vct`, and match to known rulebooks. EUDIPLO also demonstrates the intended TS11 SchemaMeta shape in practice, useful as a conformance cross-check for the OWF adapter (issue #1).

### 3.5 Sphereon

- **Repository:** <https://github.com/sphereon-opensource/oid4vc> — "OpenID for Verifiable Credentials - modules for issuers, holders and RPs". Apache-2.0, default branch `develop`, monorepo (`pnpm`/`lerna`/`turbo`).
- **Packages (observed):** `client`, `common`, `did-auth-siop-adapter`, `issuer-rest`, `issuer`, `jarm`, `oid4vci-common`, `siop-oid4vp`, `callback-example`.

**Relevance:** Sphereon is an **SDK / npm-package vendor**, not a hosted catalog. It is relevant to FR-006 as an issuer-side OID4VCI implementation and to the capture/adapter roadmap as a candidate library for wallets/issuers.

Observed evidence:

- `packages/client/lib/MetadataClient.ts` (+ `MetadataClientV1_0.ts`, `MetadataClientV1_0_15.ts`) — client-side **issuer metadata discovery** for OID4VCI draft versions.
- `packages/issuer/lib/builder/IssuerMetadataBuilderV1_0.ts` and `IssuerMetadataBuilderV1_15.ts` — server-side issuer metadata generation (two OID4VCI draft generations).
- `packages/oid4vci-common/lib/functions/SignedMetadataUtils.ts` — **JWS-signed / OAuth-protected metadata** support.
- `packages/issuer-rest/lib/OID4VCIServer.ts` — REST issuer exposing the OID4VCI flow.

**Import/discovery implication:** no catalog to bulk-import. Discovery against a Sphereon-based issuer is standard OID4VCI with possible signed metadata. Note the **two draft generations (v1.0 vs 1.15)** — AttestBook's issuer-discovery adapter must be version-aware and must not assume a single metadata shape.

### 3.6 Related: WE BUILD consortium catalogue (feeds SIROS)

- **Repository:** <https://github.com/webuild-consortium/wp4-trust-group>
  - `task2-trust-framework/credential-catalogue.md` — "Catalogue of Attributes and Catalogue of Attestation Schemes" (Markdown).
  - `task4-trust-infrastructure-api/credential-catalog-service.md` — a catalog *service* specification.

`webuild-consortium` is one of the SIROS registry contributor organizations (19 TS11-compliant schemas observed). It is documented here for completeness because its Markdown catalogue is a second example of a **GitHub+Markdown authoritative source** that is rendered into a machine-readable TS11 subset by a build step (the SIROS `registry-cli`).

* * *

## 4. Cross-source comparison

1. **Machine-readability varies from none to signed JSON.** The EUDI official catalog is Markdown-only; SIROS and FIDES publish machine-readable JSON (SIROS: plain JSON today, JWS "when configured"; FIDES: signed `schemas` + plain `credentialtype`).
2. **TS11 conformance is heterogeneous and must not be assumed.** SIROS implements a self-declared "read-only subset" of TS11 §5; FIDES self-reports `partial` and enumerates the missing fields; the EUDI official rulebooks make no TS11 claim; EUDIPLO marks TS11 "experimental/not finalized".
3. **Two distinct interaction models.** Catalogs (SIROS, FIDES, EUDI rulebooks) support **bulk import/sync**; implementations (EUDIPLO, Sphereon) are reached via **issuer metadata discovery** (OID4VCI). The importer design must keep these as separate adapters over a shared normalized model.
4. **Version/provenance signals are weak and inconsistent.** SIROS has a per-entry `version` string and a registry `last-built` timestamp; FIDES has `version`, `updatedAt` (git-derived) and `lastUpdated` on the aggregate; the EUDI rulebooks rely on Markdown version tables. None exposes a content digest; none guarantees immutability of a published entry across rebuilds. This is the main gap against FR-002's reproducibility goal and must be compensated by AttestBook's own provenance/digest layer.
5. **Integrity signaling exists but is uneven.** FIDES demonstrably signs (`ES256`, published JWKS). SIROS documents signing but does not currently enable it. The EUDI catalog has no integrity mechanism at all.

* * *

## 5. Recommended import & discovery approach

An **adapter-based importer** (specification FR-004) with two adapter families over one normalized internal model, as follows.

### 5.1 Logical contracts (Phase 1 target, names illustrative)

```
CatalogSource            # configured remote: URL, adapter kind, auth, sync policy
CatalogAdapter           # fetch + parse + normalize one source
  -> UrlCatalogAdapter       # a direct JSON document URL
  -> SirosCatalogAdapter     # registry.siros.org/api/v1
  -> FidesCatalogAdapter     # FIDES aggregated/API
  -> MarkdownRulebookAdapter # EUDI rulebooks catalog (best-effort, prose)
NormalizedRulebook       # internal, TS11-aligned model (use @owf/eudi-attestation-schema)
IssuerDiscoveryAdapter   # OID4VCI /.well-known/openid-credential-issuer -> credential configs
ImportReport             # per-source compatibility + provenance + conflicts
```

### 5.2 URL / JSON file import

- Support direct URL import and local JSON file upload (FR-004) as the fallback path, validated as untrusted input (section 6).
- Normalize into the TS11-aligned model. Where the source is already TS11-shaped (SIROS `schemas.json` entries, FIDES signed `schemas`), map fields directly. Where it is a JSON Schema (FIDES/Sphereon-linked schemas), wrap it as a schema reference and **do not** claim attestation semantics it does not carry.

### 5.3 Catalog discovery & sync (FR-005)

- **SIROS:** poll `schemas.json` using `ETag`/`Last-Modified` conditional requests (`max-age=600` observed). Prefer per-format `schemaURIs` for the actual schema payloads; follow `rulebookURI` for the human rulebook. Verify the JWS when/if signing is enabled (JWKS), but treat unsigned JSON as the current reality.
- **FIDES:** consume the **signed** `schemas` endpoint and verify with the published JWKS; use `credentialtype` (unsigned) only for display metadata. Honor the self-reported `conformance` block and surface it in AttestBook's compatibility report rather than silently importing partial entries as full TS11.
- **EUDI rulebooks:** ingest as URL/Markdown references only; record `conformance: not_verified` and treat them as documentation, not executable schemas.
- Change detection and idempotency must be AttestBook-side: none of the sources exposes a reliable per-entry digest, so compute and store AttestBook's own content digest (FR-002/FR-004) and compare across syncs.

### 5.4 Issuer metadata discovery (FR-006)

- Implement OpenID4VCI discovery against `/.well-known/openid-credential-issuer`, version-aware (Sphereon demonstrates v1.0 vs 1.15 divergence; EUDIPLO serves metadata too). Extract `credential_configurations_supported`, formats, type identifiers (`vct`/`doctype`) and any exposed schema references; attempt rulebook association; report unmatched/ambiguous configurations and allow manual mapping.
- Never treat issuer metadata as authoritative rulebook content (specification FR-006). Issuer metadata answers "what can this issuer issue", not "what must a conformant credential satisfy".

* * *

## 6. Security & robustness risks (mapped to specification section 15)

| Risk | Evidence / trigger | Required control |
|---|---|---|
| **SSRF** on URL import and sync | SIROS `schemaURIs`, FIDES `schemaUrl`/`schemaURIs` point at arbitrary remote URLs; EUDIPLO/Sphereon discovery fetches issuer-supplied URLs | Validate scheme (`https` only), resolve DNS, block private/link-local/loopback/metadata addresses, per-request timeouts |
| **Remote schema references** | FIDES/Sphereon schemas are JSON Schema with `$ref`; SIROS `x-usedBy` cross-links | Restrict `$ref` resolution (same-origin only, or block remote refs by default), bounded depth, no code execution |
| **Response size / parse limits** | FIDES `aggregated.json` is ~1.4 MB; SIROS VCTM embeds **`data:` URI logos** (large base64 blobs) | Max response size, max JSON depth/nodes, strip or reject oversized inline images, stream-parse |
| **Import conflicts** | Entries change across registry rebuilds; no digest guarantees; FIDES `schemaUrl` can move | AttestBook-side digest + version comparison; never silently overwrite local/published rulebooks (FR-005) |
| **Authenticity of catalog data** | SIROS currently unsigned; FIDES signs but keys rotate | Verify JWS where present; record `not_verified`/`unsigned` status honestly; pin/refresh JWKS with rotation |
| **Untrusted document execution** | JSON Schema + Markdown imports | No code execution; JSON Schema used only as data for validation, never `eval`/`Function` |
| **Privacy** | Display logos (SIROS `data:` URIs) and descriptions are low-sensitivity, but issuer discovery responses may embed endpoints/tokens | Do not log raw metadata responses or embedded URIs by default |

* * *

## 7. Offline & deterministic testing strategy

None of the live catalogs can be relied upon in CI (they rebuild on their own schedules; FIDES keys could rotate; SIROS signing could be enabled later). Therefore:

1. **Vendor fixtures locally:** snapshot representative, reduced payloads from each source (with explicit "captured on <timestamp>, from <URL>" provenance) into a test-fixtures directory during Phase 1. Do not call live endpoints in unit/CI tests.
2. **Mock the adapters** at the HTTP boundary (fixture files served in-process or via a stub HTTP client) so importer tests are deterministic and offline.
3. **Test both paths per adapter:** parse success + the concrete failure modes (oversized response, `data:` URI, private-address redirect, missing field, JWS with rotated/absent key, self-reported `partial` conformance).
4. Record, per fixture, which assertions are **structural** (parse) versus **trust** (signature verified) versus **conformance** (TS11 subset) — matching specification FR-010's dimension separation, and mark anything not executed `NOT_TESTED`.

* * *

## 8. Open questions & limitations

- **SIROS JWS signing** is documented but not observable today (JWKS 404). Verify again before Phase 1; do not build a hard dependency on it.
- **FIDES repository license** is asserted as Apache-2.0 in the README but no `LICENSE` file was observed at the repo root — confirm before depending on FIDES data or code.
- **TS11 normative shape** of SIROS `SchemaMeta` was not re-validated clause-by-clause here (owned by issue #2); the "subset" claim is taken as *observed shape*, not *proven conformance*.
- **EUDI rulebooks catalog** has no machine-readable layer; whether one is planned is unknown. Treat as prose until it changes.
- **Sphereon/EUDIPLO discovery endpoints** were inspected in source form, not exercised live against a running instance; live issuer metadata behavior is `NOT_TESTED`.
- The exact relationship between **EC TS11** and **ETSI TS11** naming (the SIROS/OpenAPI text says "ETSI TS11") is left to the standards ticket (#2); this document quotes sources verbatim without resolving the naming.

* * *

## 9. References

- EUDI Wallet Attestation Rulebooks Catalog — <https://github.com/eu-digital-identity-wallet/eudi-doc-attestation-rulebooks-catalog>
- SIROS registry — <https://registry.siros.org> · API — <https://registry.siros.org/api/v1/schemas.json> · OpenAPI — <https://registry.siros.org/api/v1/openapi.yaml> · Integration guide — <https://registry.siros.org/docs/integration.html> · API reference — <https://registry.siros.org/docs/api.html>
- SIROS Foundation — <https://siros.org>
- FIDES Community catalog — <https://fides.community/ecosystem-explorer/credential-catalog/> · repo — <https://github.com/FIDEScommunity/fides-credential-catalog> · API — <https://fides-credential-catalog.vercel.app>
- EUDIPLO — <https://github.com/EUDIPLO/eudiplo> · OWF mirror — <https://github.com/openwallet-foundation/eudiplo>
- Sphereon OID4VC — <https://github.com/sphereon-opensource/oid4vc>
- WE BUILD consortium — <https://github.com/webuild-consortium/wp4-trust-group>
