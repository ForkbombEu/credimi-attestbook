The [Validation playground](/playground) runs AttestBook's structural credential
validation against one immutable rulebook version and shows what the build
actually checked. Treat its result as evidence, not as a verdict: a credential
can be structurally valid and still fail in a real issuer, wallet or verifier.

**Playground evidence does not establish complete wallet or EUDI compliance.**
It covers structural and schema checks only. Signature validity, issuer trust,
revocation, protocol conformance and interoperability are not tested, so a
result here is never proof that a wallet or issuer will accept the credential.

## What structural validation checks

The engine can execute four of the eight validation dimensions in FR-010:

- **Credential parsing** — parses a real compact SD-JWT VC, verifies its
  disclosure digests, and rejects unreferenced or duplicate disclosures.
- **Credential format recognition** — identifies the credential format from the
  artifact, or from the credential format hint you choose.
- **Schema validation** — applies a pinned schema reference only when its
  document can be resolved and its integrity pin verified. The playground has no
  way to attach external schema documents, so an external reference stays not
  tested; a document hosted by this deployment is read from its immutable local
  store.
- **Attestation-specific constraints** — checks the rulebook-observable facts:
  whether the format is supported, the `attestationLoS` and `bindingType`
  vocabulary, and whether an issuer-signed `cnf` key-binding entry is present.

The other four dimensions are deliberately outside this run:

- **Cryptographic verification** (`NOT_TESTED`) — the issuer signature, the
  key-binding JWT proof and status-list checks.
- **Issuer and trust-policy validation** (`NOT_TESTED`) — trust anchors,
  certificate chains and issuer policy.
- **Protocol conformance** (`NOT_APPLICABLE`) — any OpenID4VCI, OpenID4VP or
  other exchange; a single artifact contains no protocol exchange.
- **End-to-end interoperability** (`NOT_APPLICABLE`) — a real wallet, issuer or
  verifier is never exercised.

A structural pass therefore says the artifact matches the pinned rulebook
constraints. It does not say the credential is authentic, trusted, unrevoked or
usable.

The playground lists the same eight dimensions under **What this playground
checks**, marked **Supported per credential**, **Not tested** or **Not
applicable**. These describe this build, not any rulebook: AttestBook records no
rulebook-level standards-compatibility result yet, so a rulebook's detail page
reports its compatibility as **Not tested**.

## Use synthetic credentials only

Build the artifact from synthetic claims and a throwaway signing key. **Never
paste a real PID, a production credential or any other personal data** into the
playground: it is a shared developer view, not a wallet, and the evidence does
not need real data.

The credential is sent only to this deployment's
`POST /api/v1/credentials/validate` for this run. It is not stored, not logged,
and never placed in a URL, browser storage or the exported result. The result
exposes claim paths and constraints, never claim values. The API bounds the
artifact at 512 KiB and the request body at 4 MiB.

## Supply the credential

Paste a compact SD-JWT VC into **Credential**, or use **Upload a credential
file** to read one from a local text file. A compact SD-JWT VC is an
issuer-signed JWT followed by one or more disclosure segments and an optional
key-binding JWT, joined by `~`.

- A pasted artifact is sent unchanged apart from removed leading and trailing
  whitespace.
- A selected file replaces the pasted text. It is read in the browser, and the
  page refuses a file larger than 512 KiB before reading it.
- Nothing is sent until you run the validation. Editing the request clears a
  previous result, so a report cannot be mistaken for the newly entered input.

## Choose the rulebook, version and attestation type

1. **Rulebook** — lists the public catalogue. The page loads at most 100
   entries and says so when the catalogue page is truncated.
2. **Rulebook version** — lists the versions of the selected rulebook with their
   publication status. Validation reads that exact frozen snapshot, not the
   current working copy.
3. **Attestation type** — lists the types for the selected rulebook and shows
   the level of assurance, binding type and supported formats of the selected
   one.
4. **Credential format hint** — optional. Leave it on **Detect automatically**
   for a real compact SD-JWT VC. The other pinned TS11 formats are recognised
   from the hint and reported without being parsed, so they can never look like
   a parsed credential.

## Run the validation

Select **Run validation**. The browser checks the required selections and the
credential size first; an incomplete request sends nothing. The real
`POST /api/v1/credentials/validate` request then runs against the pinned
version, and the page shows the returned report rather than a mock.

The page sends only the selected rulebook id, version, attestation type and the
credential:

```json
{
  "rulebookId": "<selected rulebook id>",
  "rulebookVersion": "<selected version>",
  "attestationType": "<selected attestation type>",
  "credential": "<the synthetic compact SD-JWT VC you supplied>"
}
```

Choosing a format hint sends the artifact as a two-member `credential` object
instead of a bare string:

```json
{
  "rulebookId": "<selected rulebook id>",
  "rulebookVersion": "<selected version>",
  "attestationType": "<selected attestation type>",
  "credential": {
    "format": "dc+sd-jwt",
    "value": "<the synthetic compact SD-JWT VC you supplied>"
  }
}
```

A safe error message is shown for an API error response such as `400`, `413` or
`503`, and editing or retrying never re-sends a stale result.

## Read the overall result and the dimensions

**Overall result** shows the aggregate status, its plain-language explanation,
the pinned rulebook version, the **Snapshot digest (SHA-256)**, and the
credential facts **Credential format**, **Credential type (vct)**,
**Disclosures** and **Key binding present**. No claim value is shown.
**Validation dimensions** lists all eight FR-010 dimensions in normative order,
each with:

- its **Status**;
- its **Execution** — whether an actual check ran;
- its **Applicability** — whether the dimension applies to a single credential
  artifact at all;
- its **Evidence** — the scope, the reason it did or did not run, and
  non-sensitive facts.

Then read the supporting sections:

- **Violations** — flattened error and warning findings with severity,
  dimension, stable code, JSON Pointer path, expected constraint and message. An
  empty list is not a pass: untested and not-applicable dimensions are listed
  above it and in the limitations.
- **Limitations of this result** — one entry for every dimension that did not
  reach a definitive pass or fail, naming the unverified signature, key-binding
  proof, status-list check, issuer trust, protocol conformance and
  interoperability where they apply.
- **Schema references** — the pinned version's references with their integrity
  pin, detected kind and whether this run applied them.

## What each status means

- **Passed** (`PASS`) — an applicable check executed and found no error. Only an
  executed check can pass.
- **Failed** (`FAIL`) — an executed check found an error. The credential does not
  match the pinned rulebook constraints.
- **Not tested** (`NOT_TESTED`) — the dimension applies, but no check executed.
  There is no evidence, so this is never a pass.
- **Not applicable** (`NOT_APPLICABLE`) — the dimension cannot apply to this
  request, for example protocol conformance for a single artifact. This is also
  never a pass.
- **Inconclusive** (`INCONCLUSIVE`) — a check executed but produced only a
  warning or an incomplete conclusion, for example a partially applied schema
  reference or unsupported type-metadata inheritance. It is not a pass either.

The overall status is conservative: `FAIL` wins, then `INCONCLUSIVE`, then
`NOT_TESTED`, and only every applicable dimension passing yields `PASS`. Because
cryptographic verification and issuer trust are applicable but not executed
here, a structurally valid credential returns **Not tested** overall. An overall
`PASS` is not reachable from a single credential artifact in this build.

That is the point of the separation, not a defect: a credential whose JSON
Schema matches but whose signature is invalid must never be reported as fully
valid, and a locally passing credential is not interoperable with real wallets.

## Export the evidence

Select **Export result (JSON)** to download the typed API result as a Blob named
from the run identity. The document contains the API result only: the credential
artifact and every claim value are absent.

Validation runs are not persisted. There is no run history, comparison or saved
result list, so export the evidence you need and keep it with the revision you
tested. A later validation of edited input is a new result.

## Call the same API directly

The playground is a client of the public product API. Headless clients can send
the same request without a login:

```bash
curl --fail --silent \
  -H 'content-type: application/json' \
  --data @request.json \
  'http://127.0.0.1:3000/api/v1/credentials/validate'
```

The request body uses the fields shown above, with the bare or two-member
`credential` form; optional `schemaDocuments` supply the exact bytes of external
schema references that the playground cannot attach.
Every operation and schema, including the response envelope and error codes, is
in the [API reference](/docs), generated from the canonical [OpenAPI
document](/openapi.json).

## What this evidence does not establish

- **Signature validity** — the issuer JWS and the key-binding proof are not
  verified.
- **Issuer trust** — no trust anchor, certificate chain or issuer policy is
  applied, and issuer identity is not established.
- **Revocation** — status-list and token-status checks are not executed.
- **Protocol conformance** — no OpenID4VCI, OpenID4VP or other exchange runs.
- **Interoperability** — no wallet, issuer or verifier is exercised.
- **Standards conformance** — the report is structural evidence for the pinned
  rulebook version, not a TS11, ETSI or EUDI conformance claim.
- **Completeness** — a dimension the build could not bound safely is reported
  not tested rather than guessed, so read the limitations before relying on the
  overall status.

Use the report to show what this build checked for this exact version. Do not
present it as a complete wallet or EUDI compliance result.
