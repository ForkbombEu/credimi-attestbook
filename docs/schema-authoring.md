# Local schema authoring, publication and consumption

This walkthrough covers the complete local path for a credential schema that AttestBook
hosts: configure a trusted public origin, register the exact document, reference it from a
draft rulebook next to an external schema, freeze and publish an exact version, inspect the
hosted provenance, and consume the schema from the public URL and the API. It also states
what is persisted, how it is backed up, and where the TS11 standards boundary stays.

Authoritative requirements: [`docs/specification.md`](specification.md) FR-001,
FR-007–FR-008, UI-002–UI-003, §14, §15 and §17; AC-04–AC-06 and AC-09.
Related contracts: [`docs/api.md`](api.md) §3.13–3.14, §4; [`docs/registry.md`](registry.md)
§6.6–6.7; [`docs/security.md`](security.md); [`docs/ui.md`](ui.md) §3.4.

## 1. Configure the trusted public origin

A hosted schema URL is written into a rulebook and a frozen version, so it must remain stable
for the document's lifetime. The origin therefore comes from deployment configuration only:

```bash
export PUBLIC_BASE_URL='http://127.0.0.1:3000'   # loopback HTTP for local use only
export DATABASE_PATH="$PWD/dist/local/attestbook.sqlite"
```

`PUBLIC_BASE_URL` must be an absolute origin with no credentials, path, query or fragment.
Public deployments must use `https`; plain `http` is accepted only for `127.0.0.1`,
`localhost` and `[::1]`. An invalid value fails startup. Request `Host`, `Forwarded` and
`X-Forwarded-*` headers are never used to build a canonical URL.

If the variable is unset, the content route still serves already-stored bytes, but the
metadata and hosted-provenance reads cannot name a canonical URL and treat references as
external; prefer configuring it before the first registration. See
[`docs/api.md`](api.md) §3.13 and the configuration table in `README.md`.

## 2. Provision a local provider and administrator

Provider provisioning is an operator action outside the HTTP API. It creates the provider
and returns its raw bearer token once.

```bash
mkdir -p "$(dirname "$DATABASE_PATH")"
bun -e '
import { openDatabase } from "./src/db/database"
import { applyMigrations } from "./src/db/migrations"
import { provisionProvider } from "./src/registry/bootstrap"
const database = openDatabase(process.env.DATABASE_PATH)
applyMigrations(database)
const provisioned = provisionProvider(database, {
  name: "Local Issuer",
  publicationAuthority: "local-issuer",
})
console.log(JSON.stringify({
  providerId: provisioned.provider.id,
  token: provisioned.token.secret,
}))
database.close()
'
```

Keep the printed token out of the repository. To use the browser editor instead of the API,
also set the three administrator variables together, bound to the printed provider id:

```bash
export TOKEN='<printed token>'
export ADMIN_USERNAME='local-admin'
export ADMIN_PASSWORD='local-admin-password'
export ADMIN_PASSWORD_HASH="$(bun -e 'console.log(await Bun.password.hash(process.env.ADMIN_PASSWORD))')"
export ADMIN_PROVIDER_ID='<printed providerId>'
```

Start the application with the same environment:

```bash
bun run build
bun dist/server.js
```

The UI is served at `http://127.0.0.1:3000/`, the API at `/api/v1`, and the health check at
`/health`.

## 3. Author the schema document

Save the exact JSON Schema 2020-12 bytes in a local file. The registration API stores these
bytes verbatim; it never re-serializes them.

```bash
cat > /tmp/pid-schema.json <<'JSON'
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PID schema",
  "type": "object",
  "required": ["family_name"],
  "properties": {
    "family_name": { "type": "string", "minLength": 1, "maxLength": 40 }
  },
  "additionalProperties": false
}
JSON
```

The document must be a JSON Schema 2020-12 object or boolean, at most 256 KiB, strict UTF-8
without a byte-order mark, with no repeated member names and no keyword the validation engine
cannot evaluate safely. The exact error is returned by the API; the editor also previews the
parsed shape and byte size before registering.

## 4. Register it and obtain the immutable reference

Using the provider bearer token:

```bash
REGISTERED="$(curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $TOKEN" \
  --header "Content-Type: application/schema+json" \
  --data-binary @/tmp/pid-schema.json \
  "$PUBLIC_BASE_URL/api/v1/schema-documents?kind=json_schema_2020_12")"

SCHEMA_URI="$(printf '%s' "$REGISTERED" | jq -r '.data.url')"
SCHEMA_ID="$(printf '%s' "$REGISTERED" | jq -r '.data.id')"
SCHEMA_INTEGRITY="$(printf '%s' "$REGISTERED" | jq -r '.data.integrity')"
SCHEMA_DIGEST="$(printf '%s' "$REGISTERED" | jq -r '.data.contentDigest')"
```

The response carries the canonical URL, media type, lowercase hex SHA-256 digest and W3C SRI
pin (`sha256-<base64>`). Re-registering identical bytes for the same provider returns the same
document unchanged; different bytes create a different document. There is no replace or
delete route.

In the browser editor, the same operation is the **Upload/paste schema to AttestBook** option
in the **Schema references** card: paste the document or choose the `.json` file, preview it,
and select **Register and insert schema**. The editor inserts the returned URL and integrity
pin into the Draft JSON and reports the immutable document fields.

## 5. Create a draft with hosted and external references

The following draft places the hosted document on the `dc+sd-jwt` format and keeps an
external schema as an ordinary `https` reference on `mso_mdoc`:

```bash
MRDOC="$(curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $TOKEN" \
  --header "Content-Type: application/json" \
  --data @- \
  "$PUBLIC_BASE_URL/api/v1/rulebooks" <<JSON
{
  "name": "Local PID Rulebook",
  "description": "Local authoring example.",
  "sourceUrl": "https://issuer.example.org/rulebooks/local-pid",
  "applicableSpec": "ts11@1.0.1",
  "attestations": [
    {
      "name": "Person Identification Data",
      "attestationLoS": "iso_18045_high",
      "bindingType": "cryptographic",
      "supportedFormats": ["dc+sd-jwt", "mso_mdoc"],
      "schemaReferences": [
        {
          "formatIdentifier": "dc+sd-jwt",
          "uri": "$SCHEMA_URI",
          "integrity": "$SCHEMA_INTEGRITY"
        },
        {
          "formatIdentifier": "mso_mdoc",
          "uri": "https://issuer.example.org/schemas/pid-mdoc",
          "integrity": null
        }
      ]
    }
  ]
}
JSON
)"

RULEBOOK_ID="$(printf '%s' "$MRDOC" | jq -r '.data.id')"
```

The persisted Draft JSON contains only `formatIdentifier`, `uri` and `integrity`; the hosted
and external references are structurally identical there. The distinction is derived by the
public read projections from the stored-document association, never from the URL prefix, and
is not written into the draft or into a version snapshot.

In the browser editor, the same mixed rulebook shows one row marked **Hosted by AttestBook**
with the stored media type, SHA-256 digest and a download link, and one row marked
**External URL**. A near-miss URL, even on the same origin, stays external.

## 6. Freeze, publish and inspect the exact version

```bash
curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"version":"1.0"}' \
  "$PUBLIC_BASE_URL/api/v1/rulebooks/$RULEBOOK_ID/versions"

curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $TOKEN" \
  "$PUBLIC_BASE_URL/api/v1/rulebooks/$RULEBOOK_ID/versions/1.0/publish"
```

The freeze snapshots the working copy into the exact content-addressed bytes whose SHA-256 is
the version digest. Publishing marks that snapshot published; later working-copy edits do not
change it. The same flow is the **Freeze as draft version**, **Check readiness** and
**Publish** sequence in the editor's lifecycle panel; readiness is a pre-publication check,
not a conformance claim.

The detail view now shows the hosted and external rows, and the version history's **Inspect
references** action reads the frozen snapshot:

```bash
# Working-copy detail projection
curl --fail "$PUBLIC_BASE_URL/api/v1/rulebooks/$RULEBOOK_ID/schema-references" | jq .
curl --fail "$PUBLIC_BASE_URL/api/v1/rulebooks/$RULEBOOK_ID/attestations" | jq .

# Exact version projection: version label, content digest and frozen references
curl --fail "$PUBLIC_BASE_URL/api/v1/rulebooks/$RULEBOOK_ID/versions/1.0/schema-references" | jq .
```

The version response reports `version: "1.0"`, its `contentDigest`, status, publication time,
the references grouped by attestation type and the rulebook-level references. A hosted
reference carries a `hostedSchema` object with the document id, kind, media type, SHA-256
digest, SRI pin, permanent URL and creation time; an external reference carries
`hostedSchema: null`. No provider ownership, registration provenance or token is returned.

The UI flags the integrity pin explicitly: **Pin matches stored digest** when the persisted
SRI value identifies the stored bytes, **No pin recorded** when it is absent, and **Pin does
not match stored digest** when it does not. The digest itself is always the stored document's
digest, never a client-supplied claim.

## 7. Consume the schema

The content URL is public and unauthenticated, so an issuer, verifier or documentation page
can retrieve the exact bytes without a login:

```bash
curl --fail --silent --show-error --dump-header /tmp/schema-headers \
  "$SCHEMA_URI" --output /tmp/registered-schema.json

sha256sum /tmp/registered-schema.json
cat /tmp/schema-headers
```

The response body is byte-identical to the registered file (never re-serialized). Its
`Content-Digest` (RFC 9530), `ETag` and the metadata `integrity` field carry the same SHA-256,
`Cache-Control: public, max-age=31536000, immutable` permits permanent caching, and
`X-Content-Type-Options: nosniff` prevents browser reinterpretation. A matching
`If-None-Match` answers `304`; an unknown id answers `404`.

The public metadata routes let a consumer discover the document without the rulebook:

```bash
curl --fail "$PUBLIC_BASE_URL/api/v1/schema-documents/$SCHEMA_ID" | jq .
curl --fail "$PUBLIC_BASE_URL/api/v1/schema-documents?limit=50&offset=0" | jq .
```

Credential validation against the published version resolves this exact canonical URL from
the immutable local store, never by fetching it over HTTP, re-verifies the stored digest and
the pinned SRI, and applies the bytes in the bounded schema sandbox. A missing document,
changed bytes, a mismatched pin or a look-alike URI is reported as an explicit
`NOT_TESTED`/`FAIL`/`INCONCLUSIVE` result, never as a pass. See [`docs/validation.md`](validation.md).

The playground and the API can also consume the version without any schema at all, because a
schema reference is a URI plus optional pin, not an embedded body.

## 8. Immutability and persistence

- The exact bytes are stored once in the content-addressed `artifacts` table. A
  `credential_schema_documents` row adds the provider-owned association, its kind/media type,
  creation provenance and creation time. Both are immutable: the database rejects `UPDATE`
  and `DELETE`, and there is no replacing route.
- A version snapshot and its artifact are frozen at freeze time and never change after
  publication. A working-copy edit after publication cannot alter a published or historical
  snapshot, its digest or its referenced schema URIs.
- The canonical URL depends on `PUBLIC_BASE_URL`. Keep that value stable after publishing: an
  existing reference embeds the old URL even if a later deployment configures a different
  origin. If the origin must move, update and republish the affected rulebooks rather than
  silently rewriting history.
- Everything lives in the configured SQLite database, including the `artifacts` bytes. Back
  it up as one consistent database file with SQLite's online backup or by stopping the server
  and copying the database file (and its WAL/SHM files when present), for example:

  ```bash
  sqlite3 "$DATABASE_PATH" ".backup '$PWD/dist/local/attestbook-backup.sqlite'"
  ```

  Restore by starting the same application version with `DATABASE_PATH` pointing at the
  restored file. The content-addressed schema bytes, the document associations and every
  published snapshot come back with it; no external object storage is involved.
- The schema sandbox and the HTTP limits remain bounded by configuration
  (`SCHEMA_SANDBOX_*`, the 256 KiB document bound and the shared 4 MiB request bound).

## 9. Externally referenced schemas

An external reference keeps working exactly as before: an absolute `https` URI and an
optional W3C SRI value are stored in the same `schemaReferences` array, with no upload or
conversion. AttestBook does not fetch the URL to render the detail, draft or version view; it
shows the URI as an external link and, when present, the recorded pin. It therefore makes no
availability, freshness or integrity claim about an external document unless a validation
flow explicitly fetched or was supplied those bytes.

If a schema is later registered locally, write the returned URL and pin as the reference for
the affected attestation format and publish a new version. Do not rewrite an old published
snapshot; its external reference is part of its immutable content.

## 10. Standards boundary

TS11 `SchemaMeta` and the version snapshot carry schema **URIs** and optional integrity pins,
not embedded schema bodies. The hosted/external distinction is an AttestBook read projection
and UI presentation over the same persisted reference shape; it adds no proprietary member to
a TS11 document, a draft document or a published snapshot. The stored body is retrieved from
AttestBook's own content route, and remote fetching is not used merely to render an external
URL.
