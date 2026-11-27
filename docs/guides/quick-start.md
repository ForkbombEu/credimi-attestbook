This walkthrough takes an anonymous reader from the [rulebook catalog](/) to
one rulebook's stored version and then to the [validation playground](/playground).
Nothing here needs an account: public reads and structural credential validation
are anonymous. Writing or publishing a rulebook is a separate, authenticated
workflow and is not covered here.

## Before you start

- The catalog at `/` is the product home. It lists rulebooks with their
  provider, version, status, attestation types, source, last update and
  compatibility label (specification §14 UI-001).
- A rulebook's detail page at `/rulebooks/<rulebookId>` shows its metadata,
  provider, attestation types, schema references, provenance and version history
  (UI-002).
- The playground at `/playground` validates a credential against one selected
  rulebook version (UI-005).
- Every page above is public. A sign-in prompt belongs to an authoring action,
  not to browsing or validation.

If a term is unfamiliar, the [Core concepts](/guide/concepts) page defines the
provider, rulebook, attestation type, schema reference, draft, published and
historical version, immutable snapshot, content digest and structural-validation
evidence.

## Step 1: Find a public rulebook

1. Open the [rulebook catalog](/).
2. Optionally type into the search field. Search is case-insensitive and every
   whitespace-separated term must match the rulebook's name, description,
   provider, profile, displayed version, attestation types, level of assurance,
   binding type or supported format.
3. Optionally choose a provider or a publication status in the filters. The
   provider filter lists every provider the API knows, and the status filter
   matches the rulebook's working-copy status (`draft`, `published` or
   `historical`).
4. Read the row before opening it. The **Version** column shows the latest
   published version, or the latest version of any status when nothing is
   published. The **Compatibility** column always says **Not tested**, because
   this build persists no rulebook-level compatibility result and does not infer
   one (see the limitations below).
5. Follow the rulebook's name to its detail page.

Search and filtering apply to the loaded page of at most 100 rulebooks, not to
the server's full total. When the catalog is truncated, a notice stays visible
and the result counter separates loaded rulebooks from the total; the no-match
panel says that only the loaded page was searched (`docs/ui.md` §3.1).

## Step 2: Read one exact version

On the detail page:

- **The page header** shows the name with its publication status, the
  description, the provider that owns the rulebook, the applicable
  specification, the last update and, for an imported rulebook, its source URL.
- **Attestation types** lists each type with its level of assurance, binding
  type, supported formats and schema references: the pin (`formatIdentifier`,
  `uri` and W3C SRI `integrity`), with references whose exact bytes AttestBook
  hosts marked and given a download link and digest. References bound to no
  attestation type follow as a rulebook-level group.
- **Standards compatibility** reports rulebook-level compatibility as **Not
  tested** and lists the eight validation dimensions with whether this build
  executes them. It never presents an untested dimension as a pass.
- **Version history** lists versions newest first, marks the latest one, and
  shows each version's status, profile, SHA-256 content digest, creation time and
  publication time.
- **Export** downloads the exact stored snapshot bytes of that version. The
  digest shown next to it identifies those bytes, and the response carries
  `Content-Digest` and `ETag` headers so a consumer can verify the download.
- **Inspect references** reads the same frozen snapshot without touching the
  rulebook's working copy.

A published or historical version is immutable, so its bytes and digest cannot
change. A draft version can still be refreshed to the current working copy. Use
the digest, not the version label alone, when you need to pin the content a
result or export refers to (`docs/registry.md` §6.2).

## Step 3: Validate a credential in the playground

1. Open the [validation playground](/playground).
2. Select a rulebook. The select lists the first page of up to 100 catalog
   entries; when the API page is truncated, the page says so and only the loaded
   rulebooks are selectable.
3. Select a version and an attestation type. The dependent selects load after
   the rulebook is chosen, and a failed related read offers a retry instead of
   hiding the page.
4. Optionally choose a credential format hint. Auto-detection recognises a real
   compact SD-JWT VC; other formats are reported without being parsed.
5. Paste a credential or read one from a local text file. The browser checks the
   required fields and the 512 KiB bound before sending anything, and removes
   only leading and trailing whitespace from the pasted artifact.
6. Select **Run validation**. The playground sends one
   `POST /api/v1/credentials/validate` request and renders the real response; it
   is not a mock result screen.
7. Inspect the report. It shows the overall status, all eight dimensions in
   normative order with their status, applicability, execution, evidence scope
   and findings, the flattened violations with severity, dimension, code, JSON
   Pointer path, expected constraint and message, the explicit limitations, the
   pinned version and recomputed digest, the schema references and whether this
   run applied them, and the non-sensitive credential facts.
8. Select **Export result (JSON)** to download the typed result. It contains the
   API result only: no credential artifact and no claim values.

The form never puts the credential in a URL, browser storage or a log, and an
API error shows the safe error envelope message instead of echoing the
credential. Editing the form clears a stale result so a previous report cannot
be mistaken for the new input (`docs/ui.md` §3.3).

## Step 4: Read the result honestly

- **NOT_TESTED and NOT_APPLICABLE are not passes.** None of the statuses
  reuse the pass styling, and the page states how many applicable dimensions did
  not execute.
- **Overall PASS is not reachable in this build.** Cryptographic verification
  and issuer trust are always applicable and never executed, so a run can be
  `FAIL`, `INCONCLUSIVE` or `NOT_TESTED`, never `PASS`.
- **The playground supplies no schema documents of its own.** For a schema
  reference to an external URI, the schema validation dimension stays
  `NOT_TESTED`, because the form does not collect caller-supplied schema
  documents (the validation API accepts them). A reference whose URI is this
  deployment's canonical hosted URL (`/api/v1/schema-documents/<id>/content`
  under the configured `PUBLIC_BASE_URL`) is resolved from AttestBook's
  immutable store and applied, so schema validation can execute and report
  `PASS` or `FAIL`. The report's schema-reference list says whether each
  reference was applied (`docs/registry.md` §6.6–§6.7).
- **A structural result is not a compliance claim.** AttestBook does not claim
  cryptographic validity, issuer trust, protocol conformance, interoperability
  or ETSI conformance from a structural pass.

## Step 5: Follow the same chain to the API

The UI reads and writes the public product API, and the
[API reference](/docs) plus the canonical `/openapi.json` document are the
operation-by-operation contract. The two reads this walkthrough relies on are
`GET /api/v1/rulebooks?limit=100&offset=0` for the catalog page and
`GET /api/v1/rulebooks/<rulebookId>/versions/<version>/content` for a version's
exact snapshot bytes. The `/api/v1` contract is AttestBook's product API; it is
not the TS11 catalogue API (`docs/standards.md` §6).

## Limitations of this journey

- The catalog's compatibility label and the detail page's rulebook-level
  compatibility are **Not tested**. No rulebook-level compatibility result is
  persisted, and FR-010/FR-012 forbid inferring one.
- Only the four structural dimensions execute: credential parsing, format
  recognition, schema validation (when a hosted schema document is resolved, or
  when schema documents are supplied through the API) and attestation-specific
  constraints. Cryptographic verification, issuer trust,
  protocol conformance and interoperability are not executed by this build.
- The catalog list, search and filters operate on the loaded page, not on the
  whole server-side catalog.
- A rulebook's source URL is provenance, not publication authority, and the
  guide describes public reads only. Creating, editing, freezing or publishing a
  rulebook requires a provider credential.
- This build does not implement the TS11 catalogue API or claim standards
  conformance. Standards-facing checks are reported as adapter results and
  limitations.

## Where this is documented

- `docs/ui.md` §3, §3.1, §3.2 and §3.3 for the routes, data flow, catalog search
  and compatibility semantics, and the playground behaviour.
- `docs/specification.md` §14 UI-001, UI-002 and UI-005 for the catalog, detail
  and playground requirements, and §17 for reproducibility and portability
  expectations.
- `docs/registry.md` §6.1–§6.3 and §6.5 for the version lifecycle, snapshot,
  digest and export contract.
- `docs/standards.md` §6 for the TS11 baseline divergence and the explicit
  non-claims.
- `docs/api.md` for the public endpoint contracts behind these pages.

Continue with [Core concepts](/guide/concepts) for the vocabulary, or open the
[catalog](/) and the [playground](/playground) directly.
