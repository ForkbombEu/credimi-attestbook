# Validation performance and immutable-snapshot caching

**Status:** Phase 6 implementation for
[issue #53](https://github.com/ForkbombEu/credimi-attestbook/issues/53).
**Authoritative spec:** [`docs/specification.md`](specification.md) §17
(non-functional requirements) and Phase 6.
**Validation contract:** [`docs/validation.md`](validation.md).
**Pinned versions:** [`docs/registry.md`](registry.md).

This document records the representative validation performance baseline, the
resource budgets enforced by tests, the immutable-snapshot cache policy and the
reproducibility checks. It claims performance and reproducibility only for the
measured repeated structural-validation path; it makes no cryptographic, trust,
protocol, interoperability or standards-conformance claim.

## 1. What is measured

The representative fixture is a published rulebook at the registry's structural
bounds: 64 attestation types, 16 schema references per type, and reference URIs
close to the registry's 2,048-character limit. The frozen snapshot is **2,059,835
bytes (1.96 MiB)**. A real, genuinely signed SD-JWT VC is validated against its
`PID` attestation type with **no caller-supplied schema documents**, so the
measurement covers the pin/digest check, snapshot parse, credential parse and the
attestation-constraint dimensions without a schema-sandbox child dominating the
result.

Measurements alternate cache-miss and cache-hit validations in the same process,
20 pairs per round for 3 rounds, and use the best round median for each mode to
reject one noisy round on a shared runner. The harness is
`scripts/benchmark-validation.ts`; the
regression test is `src/validation/performance.test.ts`.

Reference environment (recorded 2026-11-09): Bun 1.3.1 on Linux 6.8.0 x64, Intel
Xeon (Skylake, IBRS). Other runtimes, architectures and machines are not claimed.

| Round | Cold median (cache miss) | Warm median (cache hit) |
| --- | --- | --- |
| 1 | 17.52 ms | 8.16 ms |
| 2 | 16.15 ms | 9.24 ms |
| 3 | 16.39 ms | 7.95 ms |
| **Best round median** | **16.15 ms** | **7.95 ms** |

Warm p95 across all 60 warm samples: **15.05 ms**. Warm/cold median ratio:
**0.492**. A cache hit avoids the SQLite BLOB read and the snapshot `JSON.parse`;
the engine still recomputes SHA-256 over the cached bytes, so the remaining cost
is dominated by digest verification.

## 2. Immutable-snapshot cache

`RulebookSnapshotCache` (`src/validation/snapshot-cache.ts`) is a process-local,
bounded, digest-keyed LRU cache of the parsed snapshot value. `CredentialValidator`
consults it only for versions whose status is `published` or `historical`:

- **Key:** the version's `contentDigest`, the SHA-256 over the exact stored
  snapshot bytes (D-6). Published and historical rows cannot change content, and
  a refresh of a draft produces a new digest, so a digest always identifies one
  exact snapshot.
- **Hit:** the engine re-reads the version row, **recomputes SHA-256 over the
  cached bytes**, rechecks `rulebookId`, `version` and `specVersion`, and only
  then reuses the parsed attestation types. Caching can skip the database read
  and JSON parse, never the integrity or version-identity check.
- **Draft versions are never cached.** `refreshDraftRulebookVersion` replaces a
  draft's content under the same version label; excluding drafts keeps the policy
  a simple "immutable snapshots only" and guarantees a refreshed draft is read
  again.
- **Eviction** is deterministic least-recently-used and bounded by both an entry
  count (default **64**) and total stored snapshot bytes (default **16 MiB**).
  A snapshot larger than the whole byte budget is skipped rather than evicting
  every other entry. Stored bytes are owned copies, so a caller's buffer cannot
  mutate a cached entry.
- **Scope:** the cache belongs to one validator instance and one process. It is
  not a shared cache, does not survive restart and does not affect persisted
  artifacts, which remain content-addressed in SQLite.

The defaults are configurable with `VALIDATION_CACHE_MAX_ENTRIES` and
`VALIDATION_CACHE_MAX_MB`; `CredentialValidator` accepts an explicit
`RulebookSnapshotCache` or `snapshotCache: false` for tests and embedding. The
upper bounds recorded below are the defaults used by the server.

## 3. Budgets

Budgets are deliberately generous CI ceilings; the measured baseline is far
lower. The warm-to-cold ratio is the meaningful regression check: without the
cache both paths perform the same work, the ratio approaches 1, and the test
fails.

| Check | Budget | Measured baseline |
| --- | --- | --- |
| Cold validation median at the representative snapshot size | ≤ 250 ms | 16.15 ms |
| Warm validation median at the representative snapshot size | ≤ 150 ms | 7.95 ms |
| Warm validation p95 | ≤ 250 ms | 15.05 ms |
| Warm/cold median ratio | ≤ 0.85 | 0.492 |
| Cached entries | ≤ 64 | 1 |
| Cached snapshot bytes | ≤ 16 MiB | 1.96 MiB |
| Snapshot content reads for 5 repeated validations of one immutable version | 1 | 1 |

The worst-case snapshot size follows from the registry bounds: 64 attestation
types × 16 schema references × a 2,048-character URI is approximately 2.1 MiB,
plus JSON field overhead. The 16 MiB byte budget therefore holds roughly seven
worst-case snapshots; the parsed JavaScript values add an approximate 2–3×
overhead over the stored bytes, so the cache's heap footprint is bounded in the
tens of MiB, not by registry size. This is a structural bound, not a measured RSS
guarantee; the rest of the request path keeps its own limits
([`docs/validation.md`](validation.md) §7).

## 4. Reproducibility

Repeated validation of the same pinned request must reproduce the same evidence.
The regression tests verify:

- six repeated validations with different run identifiers and timestamps produce
  one stable `resultReference` from `buildConformanceResult`, and a fresh
  validator with caching disabled reproduces the same reference;
- the first (cold) and second (warm) results are deep-equal after excluding only
  `validationId` and `validatedAt`; a cache hit cannot change statuses, evidence,
  findings or limitations;
- a cached historical version reports its **current** lifecycle status while
  serving the cached content, because version metadata is always read fresh;
- refreshing a draft version produces a new digest and the next validation
  reflects the refreshed content, because drafts bypass the cache.

The conformance reference contract itself is documented in
[`docs/conformance.md`](conformance.md); this work verifies that the cache is
transparent to it.

## 5. Verification

```sh
bun test src/validation/snapshot-cache.test.ts
bun test src/validation/performance.test.ts
bun run benchmark:validation
```

- `src/validation/snapshot-cache.test.ts` — unit tests for defaults, hit/miss
  accounting, byte ownership, LRU eviction by entries and bytes, oversized-entry
  skipping, clear semantics, invalid limits and the immutable-status predicate.
- `src/validation/performance.test.ts` — deterministic cache-policy tests
  (single content read, draft bypass, lifecycle freshness, bounded multi-version
  cache, cached/uncached equality, stable conformance reference) and the timed
  representative-snapshot budget check.
- `scripts/benchmark-validation.ts` — prints the table above and fails when a
  budget is exceeded.

The benchmark is development-only because it imports the throwaway test signer
from `src/validation/test-support.ts`; it is not part of the production bundle.

## 6. Limitations and non-claims

- The cache is per process and per validator instance. Multi-process deployments
  do not share it, and a restart starts cold; the immutable artifacts in SQLite
  remain the source of truth.
- The benchmark measures the no-schema-document path. When caller-supplied schema
  documents are evaluated, a separate Bun child process dominates the run and its
  own limits apply; this document does not claim a speedup there.
- Timings are hardware- and load-dependent. Budgets are ceilings, not promised
  latencies for every deployment.
- No semantic canonicalization is introduced: reproducibility rests on the
  exact stored bytes and their digest, as before.
- The cache does not make validation fully trusted or interoperable, and it does
  not change any validation dimension's meaning or non-claims
  ([`docs/validation.md`](validation.md) §9).
