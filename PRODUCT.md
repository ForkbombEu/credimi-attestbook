# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing: Bun + Hono API serving a React 19 + Vite single-page UI from
`ui/`, tested with Vitest and Playwright. The toolchain is pinned in
`mise.toml`. No component library; the UI is plain React and CSS.

## Users

Developers, integrators and auditors who maintain or consume EUDI attestation
rulebooks. They work from a desktop browser with real credential artifacts and
rulebook snapshots, and need to read exact identifiers, statuses and evidence
rather than summaries.

## Product Purpose

AttestBook is a standalone, API-first registry and validation platform for
attestation rulebooks in the European Digital Identity Wallet ecosystem. It
makes rulebooks discoverable, authorable, versioned and testable against real
credentials, and reports validation evidence per dimension. Success means a
user can find the right rulebook version, run structural validation and see
exactly what was and was not tested.

## Positioning

Independent of Credimi's runtime: no Temporal, StepCI or PocketBase dependency.
It uses the real `@owf/eudi-attestation-schema` package and keeps structural
validity, cryptography, trust, protocol conformance and interoperability
distinct, reporting `NOT_TESTED` or `INCONCLUSIVE` instead of claiming
compliance.

## Operating Context

Users work through the public API and the web UI: a rulebook catalog, rulebook
details, a draft editor with live validation and publication, import flows, a
credential validation playground, and a mock-backed capture explorer. The UI is
served from the same origin as the versioned API. All web assets must load
locally; no external CDN or font tracking is allowed.

## Capabilities and Constraints

UI-001 to UI-006 from `docs/specification.md` §14 are the product surface:
rulebook catalog, details, editor, import, credential playground and capture
explorer. Existing functionality and copy are preserved by the restyle. The
runtime is pinned with `mise`; tests run with Bun, Vitest and Playwright.
Validation results are evidence-based and never softened.

## Brand Commitments

The UI adopts the Credimi Extras Template visual system: the canonical
`brand/style.css`, Inter and Source Code Pro (self-hosted variable fonts), the
Credimi logos, the semantic palette and the fixed Credimi Extras banner. The
binding reference is `DESIGN.md`; `DESIGN.md` wins over personal taste. The
product name stays AttestBook.

## Evidence on Hand

`docs/specification.md` §14, `docs/ui.md`, the seeded end-to-end fixture server
(`ui/e2e/server.ts`), committed UI test fixtures and the screenshots under
`docs/ui/` are the available evidence. There are no customer testimonials,
pricing or benchmarks.

## Product Principles

- Evidence over claims: show what ran and what did not.
- Exact domain language and identifiers, never paraphrased.
- One public API; the UI is a client, not a bypass.
- Preserve working flows; the restyle changes presentation, not behavior.
- Prefer deletion and the shortest working diff.

## Accessibility & Inclusion

WCAG 2.1 AA is the working bar: keyboard reachability, visible focus, semantic
landmarks and tables, reduced-motion support, and axe-core checks in component
and browser tests.
