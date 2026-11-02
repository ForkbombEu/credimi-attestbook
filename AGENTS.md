# AttestBook agent instructions

Read [docs/specification.md](docs/specification.md) before any task. It is the product's authoritative implementation specification. The repository is **ForkbombEu/credimi-attestbook** (the spec's former repository name has been updated).

## Non-negotiable constraints
- AttestBook is standalone, API-first, standards-driven and independent of Credimi's runtime.
- Use the real `@owf/eudi-attestation-schema` package; inspect public exports and limitations before designing adapters, pin and test its version. Never substitute custom models for supported OWF functionality.
- Research authoritative EC TS11 v1.0.1 and ETSI EN 319 482-3 draft v0.0.6 before claiming conformance. Maintain requirements-to-test traceability.
- Distinguish structural/schema validity, cryptography, trust, protocol conformance and interoperability. Report NOT_TESTED or INCONCLUSIVE where applicable.
- Prefer strict TypeScript; Bun is conditional on dependency compatibility. Keep modules logical rather than speculative microservices.
- Include tests, security for untrusted remote schemas/imports, provenance, version pinning, OpenAPI and documentation when applicable.
- Capture-issuer / capture-verifier adapters must be designed early but not claimed operational before real integration.
- Do not deploy to production or merge without human approval. Only push branches or open PRs when explicitly authorized in the corresponding issue/comment.

## Execution gates
- **Phase 0**: research, architecture and the five documents in specification section 18. No Phase 1 implementation until architecture is reviewed and expressly approved.
- **Phase 1**: build a working standalone vertical slice only after that approval; avoid placeholder success paths.
- **Phases 2–6**: roadmap only until their prerequisites are approved.
- Treat issues marked or titled as blocked/planned as not authorized for implementation merely by their existence.
- For each completed task report findings, actual tests, limitations and unresolved questions. Prefer small draft PRs referencing their issue number.
