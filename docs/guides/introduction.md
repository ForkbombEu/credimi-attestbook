AttestBook is a standalone, API-first registry and validation platform for EUDI
attestation rulebooks. This guide is for developers who need to find a rulebook
version, validate a credential against it, or read the public product API. It is
a short product guide; the generated API reference remains the complete,
operation-by-operation contract.

## What AttestBook does

AttestBook makes rulebooks discoverable, authorable, versioned and testable. It
reports evidence for each validation dimension separately, so a result never
implies more than the build actually checked. Keep these questions apart:

- **Structural validity** — does the credential match the pinned rulebook and
  its schema references?
- **Cryptography** — are the signatures and key bindings valid?
- **Trust** — is the issuer trusted for this credential?
- **Protocol conformance and interoperability** — do the wallet flows work
  against real issuers and verifiers?

AttestBook reports `NOT_TESTED` or `INCONCLUSIVE` when it has no evidence for a
dimension. It does not claim standards conformance, trust or interoperability
from a structural pass.

## Browse the rulebook catalog

The [rulebook catalog](/), the Validation playground and the Capture explorer
are clients of the same public API. In the catalog you can search by name,
filter by provider and publication status, open a version history, and download
an exact immutable snapshot.

A public read returns published rulebook metadata without authentication:

```bash
curl --fail --silent \
  'http://127.0.0.1:3000/api/v1/rulebooks?limit=10' |
  jq '.data[].name'
```

## Validate a credential

1. Open the [Validation playground](/playground).
2. Choose a rulebook, one of its versions and an attestation type.
3. Paste or upload a credential artifact and submit it.

The report shows the overall status, the per-dimension evidence, the flattened
violations and the references of the pinned version. Exported results never
contain the credential artifact or any claim value.

## Explore capture evidence

The [Capture explorer](/captures) groups normalized capture artifacts with the
pinned rulebook version they were validated against. The current data source is
a deterministic local mock, and every capture is labelled `mock`; no live
capture-issuer or capture-verifier integration is shown.

## Read the API contract

The [API reference](/docs) renders the product API from the canonical OpenAPI
document served at `/openapi.json`. Both paths are public and require no login.
The reference documents the product API only, not the separate TS11 catalogue
API.
