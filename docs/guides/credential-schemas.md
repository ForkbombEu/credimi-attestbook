A credential schema reference tells AttestBook where a schema document lives and, optionally,
which exact bytes a reader must expect. There are two ways to supply one: attach a schema that
is already hosted at an **external URL**, or register the document with AttestBook and
reference the immutable public URL of a schema it **hosts**.

Neither route makes the schema trusted, signed or EUDI-compliant. A reference records a
location and an optional integrity pin; it is not a conformance claim, and AttestBook does not
fetch or trust a remote schema merely because a rulebook references it.

## External URLs and schemas hosted by AttestBook

An **external URL** is an absolute `http(s)` URI that already serves the schema; prefer `https`.
Record it in the draft's `schemaReferences`, on an attestation format or at rulebook level,
together with an optional W3C Subresource Integrity (SRI) pin. AttestBook stores the URI and the
pin as supplied: it does not upload, convert or fetch the document just to render the detail
view. External content can therefore change without AttestBook noticing, and a look-alike URL,
an extra path segment or a query on the same host stays external.

A schema **hosted by AttestBook** is registered from its exact bytes. An authorized provider,
or an administrator using the rulebook editor, sends `POST
/api/v1/schema-documents?kind=json_schema_2020_12` with the document as the request body.
Registration needs a provider bearer token or the administrator session with its CSRF token,
and anonymous registration is refused. Registration returns a permanent public URL, the
lowercase hex SHA-256 digest of the bytes and a `sha256-<base64>` SRI pin. The same endpoint
registers SD-JWT VC type metadata with `kind=sd_jwt_vc_type_metadata`; this guide covers the
JSON Schema profile. In the editor, **Upload/paste schema to AttestBook** performs this
registration and inserts the returned values; **Use existing external URL** records an external
reference without uploading anything.

Both options produce the same draft members: a `formatIdentifier`, a `uri` and an optional
`integrity` pin. The hosted or external label is derived from the stored-document association
when a read projection is produced. It is never guessed from the URL prefix, and it is not
written into the Draft JSON or a version snapshot.

## Immutable public schema URLs

A hosted document's content URL has the form
`<public-base-url>/api/v1/schema-documents/<document-id>/content`. It is public and needs no
login, so an issuer, verifier or documentation page can retrieve the exact bytes. The response
is byte-identical to what was registered and is never re-serialized. Its `Content-Digest`,
`ETag` and metadata `integrity` all carry SHA-256 evidence for those bytes, and
`Cache-Control: public, max-age=31536000, immutable` tells caches that the content never
changes. A matching `If-None-Match` answers `304`; an unknown document answers `404`. The
public metadata routes `GET /api/v1/schema-documents/{id}` and
`GET /api/v1/schema-documents?limit=50&offset=0` report the same URL, media type, digest and
pin without naming the provider.

Registration is idempotent in the useful direction: registering the same bytes again for the
same provider returns the existing document and URL unchanged, while different bytes create a
different document. There is no route that replaces, updates or deletes a stored document. To
change a schema, register the new bytes, reference the new URL in a new draft and publish a new
version; do not rewrite an old published snapshot.

The deployment's public base URL (`PUBLIC_BASE_URL`) determines the content URL, so keep it
stable after publishing. A version snapshot embeds the URL that existed when it was frozen. If
the origin must move, update and republish the affected rulebooks rather than silently
rewriting history.

## SHA-256 digests and SRI pins

The SHA-256 digest is computed over the exact registered bytes. The SRI `integrity` value is
the W3C spelling of the same digest, `sha256-<base64>`, suitable for a `schemaReferences`
entry. The digest identifies the bytes; it says nothing about who authored them, whether they
are correct, or whether they comply with EUDI or TS11 requirements.

On a hosted reference, rulebook detail compares the recorded pin with the stored document's
pin and reports **Pin matches stored digest**, **No pin recorded** or **Pin does not match
stored digest**. A missing or mismatched pin is shown as such and is never presented as
verified. On an external reference, AttestBook can show the recorded pin but cannot compare it
with bytes it does not store. When a validation flow uses a reference, an unpinned, unavailable
or mismatched document is reported as not tested, failing or inconclusive as appropriate,
never as a pass.

## JSON Schema 2020-12 constraints

Registration with `kind=json_schema_2020_12` accepts a JSON Schema 2020-12 object or boolean
schema. If `$schema` is present it must name the 2020-12 dialect
(`https://json-schema.org/draft/2020-12/schema`, with or without the trailing `#`). Other
dialects are refused.

The document must be strict UTF-8 without a byte-order mark, at most 256 KiB (262,144 bytes),
with no repeated member names, a nesting depth of at most 64 and at most 32,768 JSON values.
The shared request body limit is 4 MiB, but schema documents are bounded to the smaller 256 KiB
limit before they are stored.

The document is compiled in a bounded schema sandbox. AttestBook refuses constructs it cannot
apply safely instead of storing them and ignoring them later: `$ref`, `$dynamicRef`,
`$recursiveRef`, `dependencies`, `format`, `pattern`, `patternProperties` and `uniqueItems` are
unsupported, and unknown keywords are rejected instead of skipped. Remote references are never
resolved. An unsupported or malformed document answers `400 invalid_request` and nothing is
stored.

The following small schema is valid for registration. It uses only supported keywords and
contains no personal data:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Example membership credential",
  "type": "object",
  "required": ["member_id"],
  "properties": {
    "member_id": { "type": "string", "minLength": 1, "maxLength": 64 },
    "tier": { "enum": ["basic", "premium"] }
  },
  "additionalProperties": false
}
```

## What a reader can inspect in rulebook detail

The **Schema references** section of a rulebook's detail page lists every reference with its
attestation type, format identifier, source and URI:

- **Hosted by AttestBook** rows show the document kind, stored media type, SHA-256 digest, the
  integrity pin and its comparison state, and a **Download** link to the exact bytes. The URI
  links to the public content route.
- **External URL** rows show the recorded URI as an external link and the recorded pin, if any.
  They show no stored media type, digest or download because AttestBook holds no copy of the
  document.

The source badge is the distinction: a reference is **Hosted by AttestBook** only when its
exact URI equals the canonical content URL of a stored document on this deployment. Every
other `http(s)` value remains an external link.

A frozen published version exposes the same distinction through its version projection: a
hosted reference carries a `hostedSchema` object with the public document fields, and an
external reference carries `hostedSchema: null`. The version response also names the version
label, content digest, status and publication time, so a reader can identify the exact snapshot
that pins the reference. The version history's **Inspect references** action reads that frozen
snapshot; neither the Draft JSON nor the snapshot gains a proprietary member.

## Where to go next

Open the [rulebook catalog](/) to find a rulebook and inspect its schema references, or use the
[Validation playground](/playground) to validate a credential against a pinned version. The
[API reference](/docs) documents the schema registration, metadata and content operations in
full, including authentication and every error response.
