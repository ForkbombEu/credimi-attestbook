# Agent instructions

## Project

AttestBook is an open-source, standalone, API-first platform for managing, validating and testing Attestation Rulebooks in the European Digital Identity Wallet ecosystem. It supports rulebook discovery, authoring, versioning, credential validation, conformance testing and integration with issuers, verifiers and interoperability testing platforms.

Read [docs/specification.md](docs/specification.md) before any task: it is the authoritative specification, and these instructions only add how work is done. Consult the relevant architecture, standards, requirements and integration documents in `docs/`.

Project constraints:

- AttestBook is independent of Credimi's runtime and must not require Temporal, StepCI, PocketBase, or any particular wallet, issuer or verifier. Integrations use stable APIs.
- Use the real `@owf/eudi-attestation-schema` package. Inspect its public exports, reuse its supported functionality, pin and test its version, and document gaps. Never replace supported OWF functionality with custom models.
- Follow EC TS11 v1.0.1 as the initial baseline; research ETSI EN 319 482-3 draft v0.0.6 and relevant EUDI ARF requirements. Maintain requirements-to-test traceability. Never claim unverified compliance.
- Distinguish structural/schema validity, cryptography, trust, protocol conformance and interoperability; report `NOT_TESTED` or `INCONCLUSIVE` when appropriate.
- Prefer strict TypeScript. Use Bun only when dependency compatibility is verified. Avoid speculative microservices.
- Treat imported catalogs, remote schemas, credentials and capture artifacts as untrusted. Enforce SSRF protection, resource limits, authorization, provenance and personal-data minimization.
- Design `capture-issuer` and `capture-verifier` integration contracts early, but do not claim either operational until actual integration is implemented and tested.
- Maintain reproducible rulebook versions, tests, OpenAPI contracts and documentation for implemented capabilities.

### Implementation phases

Follow specification section 18. Phase 0 delivers research, architecture, standards analysis, traceability and the five required documents. Phase 1 delivers a genuinely working standalone vertical slice, never placeholder success paths. Phases 2–6 proceed as their technical prerequisites are fulfilled.

Phase transitions are autonomous: the agent verifies prerequisites and resolves architecture questions through the issue workflow without requiring human approval. Phase labels alone do not block implementation. Issue dependencies still apply.

## How work happens

- Work starts from GitHub issues. An issue that mentions `@forkboteu` and is
  opened by an allowed person becomes a task for the dsh-superagent agent, which
  implements it on a branch and opens one pull request for it.
- Claude Code reviews every pull request the agent opens. The agent fixes the
  blocking findings until the review passes, then squash-merges the pull
  request itself once the required CI checks pass.
- No human approval is needed for any step. Issues run in the order their
  `Depends on` lines give, and independent issues run in parallel.
- A person stops or redirects work with a comment on the issue or pull request.

## Code and tests

- Every change comes with tests that exercise it, and the existing tests pass. Test the actual OWF package when its capabilities are involved; include negative security and standards tests where applicable.
- Keep documentation, OpenAPI contracts and requirements traceability current. Report tests actually run, limitations and unresolved questions.
- Keep changes within the scope of their issue; record anything else found on
  the way as a new issue instead of fixing it in the same pull request.
- Never commit secrets, credentials or personal data, and never deploy to
  production.

## Commits and pull requests

- Commit messages and pull request titles follow
  [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):
  `<type>(<optional scope>): <description>`, with type one of `feat`, `fix`,
  `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore` or
  `revert`; `!` and a `BREAKING CHANGE:` footer mark a breaking change. The
  squash merge uses the pull request title as the commit subject.
- One pull request per issue. Its description says `Closes #<n>` for the issue
  it completes, and `Refs #<n>` for an issue it only advances.

## Merging

The agent account `@forkboteu` squash-merges a pull request it opened, without
further human approval, once an independent Claude Code review of the pull
request's exact head commit passes and all required CI checks pass
(`gh pr merge --squash --match-head-commit <reviewed sha>`). It never merges
any other pull request, never uses `--admin` or bypasses branch protection, and
does not merge work whose issue or comment explicitly forbids merging. Every
other merge needs human approval.

## Writing issues

These rules are for anyone, person or agent, who opens issues for this
repository; an agent asked to plan a feature or a backlog opens the issues
following them.

Every issue:

- Is opened by a person's account that the deployment allows to request work,
  never by `@forkboteu`: the agent does not take requests from itself. An agent
  opening issues does so with that person's `gh`.
- Mentions `@forkboteu` in the description it is created with. A mention added
  later by editing the description is not seen; post a comment instead.
- Asks for exactly one pull request's worth of work: one module or feature
  slice, reviewable on its own, typically up to a few hundred lines. Split
  anything larger, such as a redesign across several modules.
- References relevant sections of `docs/specification.md` and applicable requirements.
- States the acceptance criteria as checks a reviewer can verify, including the
  tests to add.
- Lists its prerequisites on one line, `Depends on #<a>, #<b>`, naming only the
  issues whose merged code it needs. Omit the line when there are none. An
  issue starts once every listed issue is closed as completed; one closed as
  not planned blocks it.
- Never asks the agent to wait, not to begin, not to merge or to get approval:
  the agent obeys such a request and does not lift it by itself.

Opening a backlog:

1. Break the work into issues as above and order them so each one's
   prerequisites come before it; there must be no cycles.
2. Make the first issue set up the build, the test suite and a CI workflow,
   and make that workflow's checks required on the default branch, so every
   later merge has to pass them. If these already exist, verify them instead.
3. Create the issues in that order with
   `gh issue create --repo <owner>/<repo> --title "<title>" --body-file <file>`,
   so each `Depends on` line names issues that already exist.
4. Open them all at once: the agent starts every issue whose prerequisites are
   done, up to its concurrency limit, and the rest as their prerequisites merge.

Issue template:

```markdown
@forkboteu <one paragraph: what to build and why, referring to the relevant
sections and requirements of docs/specification.md>

## Acceptance criteria
- [ ] <verifiable behavior>
- [ ] <tests that cover it>

Depends on #<a>, #<b>
```

The title is a short imperative summary, such as
`Add the rulebook import endpoint`; the agent writes the conventional pull
request title from it.
