Use the AttestBook browser editor to take a rulebook from a first draft to an
immutable published version. The editor is the UI-003 authoring view: it creates
and saves drafts, validates them against the real server, freezes versions,
checks publication readiness and publishes. This guide covers the workflow the
current build implements; the generated [API reference](/docs) remains the exact,
operation-by-operation contract.

## Before you start

Public reads need no account: the [rulebook catalog](/), rulebook details,
version history, version comparison, exports, the [validation playground](/playground)
and the [API reference](/docs).

The editor and its writes need the administrator session of the provider that
owns the rulebook. Signing in is required to:

- open the [new rulebook editor](/rulebooks/new) or an existing editor at
  `/rulebooks/<id>/edit`;
- use `Create draft`, `Save draft` and hosted schema registration;
- use `Freeze as draft version`, `Refresh` and `Publish` in the editor's
  lifecycle panel, and `Create new version` on a published rulebook.

The page footer shows `Log in` when anonymous, and the signed-in provider's name with
`Log out` when authenticated. The catalogue's `New rulebook` action appears for
any signed-in administrator; the new draft belongs to that administrator's
provider. The detail page's `Edit draft` and `Create new version` actions
appear only for the administrator bound to the provider that owns the rulebook.

## Sign in

1. Open the [administrator sign-in page](/login), or follow `Log in` in the
   page footer from the page you are on.
2. Enter the administrator username and password configured for this server. The
   page never asks for, stores or sends a provider bearer token.
3. After a successful sign-in the browser returns to the same-origin page you
   came from, or to the catalogue. The footer then shows the provider the
   administrator is bound to.

The server carries the session in an HttpOnly cookie, and the page restores it
with `GET /api/v1/auth/me`. No password, session material or bearer token is
kept in `localStorage` or `sessionStorage`. Every protected write is a
same-origin request that sends the cookie with the session-bound
`X-CSRF-Token` header; the page keeps that token in memory only, and it is not a
provider bearer token.

An anonymous deep link to an editor shows **Sign in to author rulebooks** and
returns to that editor after sign-in. If a write reports the session as expired
(`401`, or `403 csrf_failed` after a session rotation), the editor keeps the
unsaved fields and shows an inline **Sign in again** form. A `403 forbidden` is
different: it is an ownership refusal, not an expired session.

## Create a draft

1. Sign in, open the [rulebook catalog](/) and choose `New rulebook`. The action
   is hidden for anonymous readers; the editor opens at `/rulebooks/new`.
2. In **Rulebook metadata**, enter a required **Name** and **Applicable
   specification** (a new draft starts at `ts11@1.0.1`). **Description** and
   **Source URL** are optional. The source URL records provenance and is not
   injected into a standards-defined document.
3. In **Attestation types**, choose `+ Add new attestation` and fill in the
   inline form:
   - **Attestation name** is required;
   - **Level of assurance** is one of `iso_18045_high`, `iso_18045_moderate`,
     `iso_18045_enhanced-basic` or `iso_18045_basic`;
   - **Binding type** is `key` (the default), `claim`, `biometric` or `none`;
   - **Supported formats** is at least one of *SD-JWT VC (dc+sd-jwt)* or
     *mdoc (mso_mdoc)*.

   Choose `Save attestation`. The card shows the four fields with `Edit` and
   `Remove` actions; removing a format also removes that format's schema
   reference. The form edits the same document shape the API stores:

```json
{
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
  "schemaReferences": []
}
```

4. For each supported format in the card, choose `Add schema` and either paste
   or upload a JSON Schema 2020-12 document under
   `Upload/paste schema to AttestBook`, or record an absolute `https` URL under
   `Use existing external URL`. A hosted document is registered for the
   signed-in provider and referenced by its canonical hosted URL and SRI
   integrity; an external reference stores the URL and an optional SRI value.

   For a hosted schema, enter the **Credential type (vct)** (`dc+sd-jwt`) or
   **Document type (docType)** (`mso_mdoc`). It is optional while drafting and
   required before publication: the registration writes it into the schema as
   `properties.vct.const` / `properties.docType.const` and lists it in the
   root `required` array. A different existing `const` or `enum`, or an mdoc
   schema without a namespace (a top-level `properties` member other than
   `docType` whose subschema is an object schema), blocks the registration with
   a message. The form warns about unsupported CBOR `format` or
   `contentEncoding` values, and an external schema shows only a warning that
   AttestBook cannot verify its credential type. Either mode marks the form
   dirty.
5. Follow **Live validation** below, then choose `Create draft`. The editor
   creates one draft for the signed-in provider and continues at
   `/rulebooks/<id>/edit`. There is no provider field in the request: ownership
   comes from the session.

## Edit metadata and attestations

Open the rulebook's detail page and choose `Edit draft`, or open
`/rulebooks/<id>/edit` directly while signed in to the owning provider. The
editor loads the draft working copy through `GET /api/v1/rulebooks/<id>/draft`.

Changing a metadata field, an attestation or a schema reference marks the form
dirty. The serialized draft document is parsed and validated before it is sent;
there is no raw JSON editor. `Save draft` replaces the whole working copy with
one `PUT /api/v1/rulebooks/<id>/draft` request; the same document produces the
same working copy.

Rulebook-level schema references (those that belong to no attestation type) are
listed read-only in the editor and kept unchanged in the saved document.

Saving a draft never changes a frozen or published version. A published or
historical rulebook opens read-only with an explanation, and the server also
refuses the mutation with `409 immutable`. On a published rulebook the editor's
`Create new version` panel starts the next-version flow described below.

## Interpret validation diagnostics

Live validation runs as you edit. It is a read-only `POST
/api/v1/rulebooks/validate-draft` request after a short debounce: it reports the
registry's structural checks and, where the applicable specification is the
TS11 v1.0.1 baseline, the findings of the real standards adapter. It writes
nothing.

The findings table has three columns:

- **Severity**, such as error or warning;
- **Location**, the path of the finding; `Document` means the root of the
  request document;
- **Finding**, the message plus the stable diagnostic code.

The result separates two kinds of problem:

- **Structural errors** block a save. The save button stays disabled until they
  are fixed and the draft attestations and required metadata are valid.
- **Standards findings** are reported but do not block saving a work-in-progress
  draft. The registry stores profile enumerations as extensible text, so an
  out-of-baseline value is a finding, not a failed save.

When the applicable specification is outside the implemented `ts11@1.0.1`
baseline, no standards checks run and the report says so; only structural checks
apply. The **Validation boundaries** list explains what the run did not check.
Live validation is not a conformance claim.

## Freeze a draft version

The **Draft lifecycle and publication** panel in the editor works on stored
versions, not on the unsaved text, so save the working copy first. Enter a
numeric `MAJOR.MINOR` or `MAJOR.MINOR.PATCH` label under **New version label**,
then choose `Freeze as draft version`. The server snapshots the current working
copy as a `draft` version and records its SHA-256 content digest. Freezing does
not publish anything, and an existing label is rejected as a conflict.

Choose `Refresh` on a draft version to re-snapshot it after the working copy
changes; refreshing identical content is a no-op. A draft becomes stale if the
working copy changes after it was frozen, and publishing a stale draft is
rejected with a conflict until it is refreshed.

Published and historical versions are immutable. The panel shows them with
`Immutable` instead of actions, and the server rejects a refresh with
`409 immutable`.

## Check readiness and publish

Choose `Check readiness` on a specific draft version. The panel lists every
check individually and names its boundaries; `Publish` for that version stays
disabled until the readiness result is ready. The checks cover:

- the version is still a draft and the rulebook working copy can move to
  `published`;
- the stored snapshot bytes still hash to the recorded digest;
- the draft snapshot still matches the current working copy;
- the snapshot content passes the structural and TS11 v1.0.1 checks the editor
  runs;
- the standards profile baseline actually ran (an unsupported profile is a
  warning, not a silent pass);
- the rulebook defines at least one attestation type.

Readiness is advisory. `Publish` remains the authoritative transition and the
server rechecks the version and its snapshot, so a stale snapshot still answers
`409 conflict` and must be refreshed first.

Publishing makes that exact version `published`, demotes any previously
published version to `historical`, and sets the rulebook to `published`. The
published bytes and digest are immutable, and the editor becomes read-only.
AttestBook does not sign the published snapshot: integrity is the SHA-256
content digest, and the publication export manifest reports the signature
status as unsupported. None of these steps makes a standards-conformance claim.

## Inspect immutable versions

The rulebook's detail page at `/rulebooks/<id>` shows the **Version history**
newest first, with each version's label, status, specification, SHA-256 content
digest, creation and publication dates. The most recent published version (or
the newest version when nothing is published) is marked **Latest**.

`Inspect references` reads the exact frozen snapshot and shows its schema
references grouped by attestation type plus rulebook-level references, with the
hosted or external provenance of each one. `Export` downloads the exact
immutable snapshot bytes for that version; the download carries `Content-Digest`
and `ETag` headers so you can verify the SHA-256 digest shown in the table.
Later drafts and later supersessions do not change those bytes.

A `historical` version was published once and then superseded by a newer
publication. Supersession never changes its digest, publication metadata or
exported bytes. Draft versions are not immutable: refreshing them is how a
working draft is updated before publication.

## Compare version history

The detail page's **Compare versions** panel compares two stored snapshots. It
appears once the rulebook has at least two versions: choose a **Baseline
version** and a **Compared version**, then choose `Compare`.

If the authored content is the same, the panel says so even when the labels
differ: the snapshot identity fields (format marker, rulebook id and version
label) are excluded from the comparison. Otherwise the table lists each change
by JSON Pointer path with its change kind and the baseline and compared values,
sorted by path. This is a structural comparison of the authored content, not a
byte diff.

## Start the next version

After publication, open the detail page and choose `Create new version` as the
owning provider's administrator. The editor opens in the next-version flow, and
the form stays read-only until you create the version. The published artifact is
not changed by this flow.

Enter a new label and choose `Create new version`. The working copy reopens as a
`draft` in place, keeping its metadata, attestations and schema references,
while the published version keeps its bytes and digest. You can then edit and
save the working copy, freeze or refresh a new draft version, check readiness
and publish it. Publishing the newer version demotes the earlier one to
`historical`.

## Ownership, session and limits

The administrator account is bound to one existing provider, and every rulebook
belongs to the provider recorded on the stored resource. A new draft takes its
provider from the session; the editor has no provider field. Every write checks
ownership on that stored rulebook, so an administrator of another provider gets
a `403 forbidden` ownership refusal, not a sign-in prompt. Provider identity and
publication authority are never inferred from a source URL or a display name.

The session boundary is small on purpose:

- the browser session is the server's HttpOnly cookie, restored with
  `GET /api/v1/auth/me`;
- protected writes send the same-origin cookie and the session-bound
  `X-CSRF-Token` header, with no bearer token and no browser storage;
- `Log out` revokes the session through `POST /api/v1/auth/logout` with the same
  CSRF token, and the cookie then resolves to the anonymous state;
- an expired session keeps unsaved editor state and asks for the administrator
  credentials again.

Keep the validation dimensions apart. Structural/schema validity and the TS11
v1.0.1 adapter checks do not test cryptography, issuer trust, protocol
conformance or interoperability, and readiness does not fetch remote schema
documents or verify them. Where there is no evidence, AttestBook reports
`NOT_TESTED` or `INCONCLUSIVE` rather than a pass. This guide also does not
cover operator provisioning, deployment configuration or credentials; those are
set outside the browser workflow.

## Related documentation

- [Introduction to AttestBook](/guide/introduction): what the platform does and
  how to find and validate rulebooks.
- [API reference](/docs): the generated operations, schemas and authentication
  schemes for the public product API, including provider bearer authentication
  for headless clients.
- [Validation playground](/playground): run the structural validation outside
  the authoring workflow.
