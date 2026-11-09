# Interoperability fixture provenance

These fixtures are frozen evidence for [`docs/etsi-interoperability.md`](../../../../docs/etsi-interoperability.md)
and [`src/standards/interoperability.test.ts`](../interoperability.test.ts). They are captured
data, not live inputs: the tests never call the network, so CI results stay reproducible when
the upstream catalogs change or disappear.

All captures were made on **2026-11-09 (UTC)**. A fixture that cannot be reproduced from the
recorded URL and digest is not valid evidence.

## ETSI EN 319 482-3 draft v0.0.7 (2026-11)

- **Source:** <https://docbox.etsi.org/esi/open/Latest_Drafts/ETSI%20DRAFT%20EN_319_482-3v0.0.7-public.pdf>
- **Title:** Electronic Signatures and Trust Infrastructures (ESI); Additional wallet
  interfaces; Part 3: Interfaces and formats for the catalogue of Attestation Rulebooks and
  attributes.
- **Reference:** DEN/ESI-0019482-3; **draft** v0.0.7 (2026-11), 64 pages, public enquiry and
  vote phase; call for comments closes 6 December 2026.
- **PDF SHA-256:** `496ee139330b5fe47a2e1a3ba5d8be5f066416166d7cbd58affe5e0969629604`
- `etsi-482-3-v0.0.7-annex-e.schema.json` is Annex E.2 "JSON Schema" reproduced for
  executable verification. Annex E.1 is the data model. The schema is draft material: ETSI
  states that the PDF is a working document and must not be cited other than as work in
  progress, so every use here is labelled as a draft comparison, not a conformance claim.
- The issue that requested this assessment names **v0.0.6 (27 October 2026)**. That revision
  was never retrievable from the public ETSI draft directory (see
  [`docs/standards.md`](../../../../docs/standards.md) Part II §6). v0.0.7 is the public draft
  available at capture time; no v0.0.6/v0.0.7 delta is claimed.

## SIROS Credential Type Registry

- **Source:** <https://registry.siros.org/api/v1/schemas.json>
- **Response:** HTTP 200, `content-type: application/json; charset=utf-8`,
  `last-modified: Mon, 09 Nov 2026 12:08:53 GMT`, `etag: "6af1b7d5-3df8"`,
  `cache-control: max-age=600`.
- **Capture SHA-256:** `865fa84de7fa1ca6b4e9da7010dcaff55afa2dd643c76884737ac9b0d1fb7a5b`
- `siros-schemas-2026-11-09.json` is the response verbatim: 32 entries, `total` 32. SIROS
  self-describes the endpoint as a "read-only subset" of the TS11 catalogue API; the fixture
  records what it actually served, not a conformance claim.

## FIDES Community Credential Catalog

- **Schemas source:** <https://fides-credential-catalog.vercel.app/api/public/schemas>
- **Response:** HTTP 200, `content-type: application/jwt; charset=utf-8`,
  `etag: W/"24f22-9d1Ncvona495Ai+nAmcPKiyjnMo"`.
- **JWKS source:** <https://fides-credential-catalog.vercel.app/.well-known/jwks.json>
- **JWT SHA-256:** `3f7386fd70448b018d46b59021ea6143945af8a34c849d961bd98b7f97be76f5`
- **JWKS SHA-256:** `179a682d5a7c42ae0db6a462f9d77e18ce2841dd06cbd1f428c5e0da5e2fc871`
- `fides-schemas-2026-11-09.jwt` is the compact JWS verbatim: header
  `{ "alg": "ES256", "kid": "fides-cat-2026-v1", "typ": "JWT" }`, payload with 121 entries.
  `fides-jwks-2026-11-09.json` is the JWKS used to verify that captured signature. The test
  verifies the signature of the frozen bytes with the frozen key; it makes no statement about
  FIDES' authority, key rotation or future responses.

## What is deliberately not captured

The official EUDI Wallet attestation rulebooks catalog
(<https://github.com/eu-digital-identity-wallet/eudi-doc-attestation-rulebooks-catalog>) is
Markdown only and publishes no machine-readable SchemaMeta document, so there is no fixture to
parse. EUDIPLO, Sphereon and Credimi are implementations reached through issuer-metadata
discovery, not bulk catalog documents; they were not exercised live for this ticket.
