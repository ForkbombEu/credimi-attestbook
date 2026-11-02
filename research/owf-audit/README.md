# OWF dependency audit probe

Reproducible probes for the mandatory `@owf/eudi-attestation-schema` dependency
pinned at **0.5.4**. The findings are written up in
[`docs/standards.md`](../../docs/standards.md).

This directory is Phase 0 research, not AttestBook application code. It exists
so the audit claims can be re-run against the exact tested version.

## Run

```bash
cd research/owf-audit
npm ci
npm run probe
npm run typecheck
```

Bun equivalent:

```bash
bun install
bun run probe:bun
```

The probe exits non-zero if a check fails. It records both supported behaviour
and behaviours that AttestBook must not rely on (for example, `verifySchemaMeta`
accepting inconsistent JOSE headers). The assertions describe package **0.5.4**;
a later upstream version may legitimately fail them, in which case the audit
must be repeated and the findings updated.

## What is checked

- installed package version and runtime export inventory;
- builder output, SemVer/SRI/duplicate-format validation, and unknown-member
  handling;
- rejection of a TS11 v1.0.1-shaped `SchemaMeta` document;
- compact JWS creation and verification, tamper rejection, `iat` behaviour, and
  the JOSE-header checks that the package does not perform;
- SRI integrity resolution over transferred bytes, parsed-content rejection, and
  Type Metadata resolution;
- DCQL generation and trusted-authority mapping;
- OID4VCI issuer-metadata template and profile validation;
- the `verifyResolveAndBuildDcql` end-to-end helper;
- strict TypeScript compilation of the public types (`typecheck.ts`). The probe
  uses `skipLibCheck: true` because `@sd-jwt/sd-jwt-vc` 0.24.1 declarations are
  not compatible with `exactOptionalPropertyTypes`; application code is still
  checked with `strict` and `exactOptionalPropertyTypes`.

## Tested environment

- `@owf/eudi-attestation-schema` 0.5.4 (published 2026-10-30)
- `@owf/crypto` 0.6.2, `@owf/identity-common` 0.6.2, `@sd-jwt/sd-jwt-vc` 0.24.1,
  `zod` 4.6.7
- Node.js 20.20.2, 22.23.4 and 24.22.2; Bun 1.3.1 (Linux x64)
