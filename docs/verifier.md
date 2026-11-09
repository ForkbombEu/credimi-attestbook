# Rulebook-driven verifier constraints

**Status:** Phase 3 implementation of the verifier-constraint slice by
[issue #45](https://github.com/ForkbombEu/credimi-attestbook/issues/45) (specification FR-014).
It exposes the typed attribute and format constraints of one pinned rulebook version, and the
verifier-policy interfaces AttestBook can map them to. It produces no presentation request,
proof or protocol result.

**Authoritative spec:** [`docs/specification.md`](specification.md) §10 (FR-014) and §15
**Requirements:** [`docs/requirements.md`](requirements.md) FR-014 and AC-11
**Related:** [`docs/fixtures.md`](fixtures.md) (FR-013 issuer fixtures),
[`docs/validation.md`](validation.md) (the pinned-version schema model this slice reuses),
[`docs/api.md`](api.md) (the HTTP contract) and [`docs/registry.md`](registry.md) (versions and
digests).

## 1. Scope and boundaries

Implemented by #45:

- selection of one rulebook, one version and one attestation type from the registry, with the
  version digest recomputed and verified before any constraint is read;
- matching each caller-supplied document to an attestation schema reference by URI and
  verifying the reference's sha256 SRI value before the document can ground constraints;
- extraction of typed attribute constraints from the supported JSON Schema 2020-12 subset, with
  every unresolved keyword reported on the attribute that declares it;
- per-format constraint grounding for every supported format of the attestation type (or one
  selected format), including an explicit `not_supplied`/`not_grounded` state;
- an explicit list of verifier-policy interfaces and their status;
- a partial, deterministic OpenID4VP DCQL credential-query fragment with every unexpressible
  constraint reported;
- the public `POST /api/v1/verifiers/constraints` route and its OpenAPI components.

Deliberately **not** in #45:

- generating an OpenID4VP authorization request, a Presentation Exchange presentation
  definition, a wallet-ready DCQL query or a presentation submission;
- producing or verifying holder proof, signatures, key binding, nonces, client metadata,
  response modes or any protocol parameter;
- cryptographic verification, trust evaluation (including trusted-authority resolution),
  protocol conformance or interoperability testing;
- fetching referenced schema documents. As in credential validation and issuer fixtures, the
  caller supplies the exact bytes and no remote schema is retrieved;
- converting SD-JWT VC Type Metadata into guessed JSON Schema value constraints;
- persisting verifier policies, generated fragments or schema documents;
- an exhaustive conformance suite. The extracted subset is bounded by the keywords listed in
  §4 and does not execute any keyword.

## 2. Public service contract

`src/verifier/` exposes `VerifierPolicyResolver`:

```ts
const resolver = new VerifierPolicyResolver({ source: registry })
const result = resolver.resolve({
  rulebookId: rulebook.id,
  rulebookVersion: '1.0',
  attestationType: 'PID',
  format: 'dc+sd-jwt',
  schemaDocuments: [{ uri: 'https://issuer.example/schema/pid.json', content: schemaText }],
})
```

`resolve` is synchronous: the inspection is a bounded, non-executing structural walk (see §5),
so no sandbox child is required. It writes nothing and performs no network request. It throws a
typed `RegistryError`:

- `not_found` when the rulebook, version or attestation type does not exist;
- `invalid_input` for a malformed request, a supplied document that does not belong to the
  selected attestation type or format, a document that does not match its sha256 SRI value, an
  invalid or unbounded document, a format the attestation type does not support, or more than
  the attribute bound.

The result is a `VerifierConstraintsResult`:

| Field | Meaning |
| --- | --- |
| `kind` | `attestbook.verifier-constraints@1`; a format marker, not a request media type. |
| `rulebook` | Pinned rulebook id/name/version, recomputed digest, `digestVerified: true`, profile and status. |
| `attestation` | Selected attestation type, attestation LoS, binding type and supported formats. |
| `formats` | One policy per resolved format: grounding, schema references, typed attributes, DCQL fragment and diagnostics. |
| `policyInterfaces` | Every verifier-policy interface this slice knows, its status and its explicit gaps. |
| `diagnostics` | Safe, machine-readable findings about resolution. |
| `nonClaims` | Explicit `false` request/proof markers and `NOT_TESTED` dimension results. |
| `limitations` | The explicit boundaries in §8. |

### 2.1 Grounding and integrity

AttestBook does not store schema bodies in a version snapshot. A document therefore grounds
constraints only when all of the following hold:

1. its URI is a schema reference of the selected attestation type in that exact version (and of
   the requested `format`, when one is given);
2. the reference carries a sha256 SRI value and the supplied bytes match it;
3. the parsed document is a JSON Schema 2020-12 object inside the shared depth and node bounds;
   a document that declares another dialect is reported and not inspected.

References without a verifiable sha256 pin, references whose document is not supplied and
SD-JWT VC Type Metadata references are reported in `schemaReferences` and `diagnostics` and
never silently used. A document whose SRI value does not match is a caller input error
(`400 invalid_request`), not an ignored document.

`grounding` is per format: `verified` when every reference of the format was inspected,
`partially_verified` when some were, `not_supplied` when no document was supplied and
`not_grounded` when documents were supplied but none could be inspected. A format with no
instrumentable attribute is still returned, with an explicit diagnostic and an empty
`attributes` list.

## 3. Typed constraints

Each attribute reports:

| Field | Meaning |
| --- | --- |
| `pointer` | JSON Pointer into the schema; array elements use `*` because JSON Pointer has no array wildcard (the same convention as validation and fixtures). |
| `name` | Last pointer segment (`*` for an array item constraint). |
| `required` | Whether the declaring object lists the property in `required`. |
| `types` | Effective JSON types from `type`, sorted. |
| `constraints` | Extracted JSON Schema keyword values, such as `type`, `enum`, `minLength`, `minimum`, `maxItems`, `pattern` or `format`. |
| `unsupportedConstraints` | Keywords present on the attribute but not resolved into typed constraints, each with a reason. |
| `sources` | Schema-reference URIs that declare the attribute. |
| `claimPath` | The DCQL claim path when derivable; array elements are `null`, not a JSON Pointer. |
| `claimPathSupported` | Whether the path can be used as a DCQL claim path. |

Nested object properties and array item constraints are included, so a pointer such as
`/address/locality` has claim path `['address', 'locality']` and `/nationalities/*` has claim
path `['nationalities', null]`. `claimPathSupported` is format-aware: `dc+sd-jwt` accepts a
non-empty path with `null` array wildcards, while `mso_mdoc` accepts only a two-element
`[namespace, data_element_identifier]` path and no wildcard; a format that DCQL cannot select
is never marked mappable. An attribute that is only reachable through `required` without a
declared `properties` entry is reported with an empty type list rather than omitted.

## 4. Supported extraction subset

The inspector is a bounded structural walk over JSON Schema 2020-12. It extracts:

| Keyword | Behavior |
| --- | --- |
| `type` | String or union; unknown type names are reported unresolved. |
| `const`, `enum` | Values are reported as data. |
| `minLength`, `maxLength`, `pattern`, `format` | Reported as data; `pattern`/`format` are never executed. |
| `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` | Reported as data. |
| `minItems`, `maxItems`, `uniqueItems` | Reported as data. |
| `minProperties`, `maxProperties` | Reported as data on the object attribute. |
| `properties`, `required`, `items`, `additionalProperties` | Walked to produce nested attributes and object limitations. |
| `allOf` | Branches are flattened and compatible constraints are intersected at every nesting level. |

Property schemas from sibling `allOf` branches are merged before their children are inspected,
so a `required` flag, nested `properties` or nested `items` declared in one branch is combined
with the constraints of the other branches into one attribute. Array items are followed
recursively, including items of items; a constraint on an item's item is never dropped
silently.

Everything else that can change an instance is reported, not ignored. The reported set
includes `$ref`, `$dynamicRef`, `$recursiveRef`, `oneOf`, `anyOf`, `not`, `if`/`then`/`else`,
`dependentRequired`, `dependentSchemas`, `dependencies`, `patternProperties`,
`propertyNames`, `contains`, `minContains`, `maxContains`, `prefixItems`, `additionalItems`
and the `unevaluated*`/`contentSchema` keywords. `additionalProperties: false` and schema
objects under `additionalProperties` are reported as object-level limitations because they
cannot be expressed as one typed attribute. A conflicting `allOf` intersection is reported,
keeping the first extracted value instead of inventing a merged one.

## 5. Bounds and non-execution

The parsed document is bounded before inspection: depth 64 and 4,096 inspection node visits
overall (a schema node reached again through repeated `allOf` flattening is counted each
time), at most 16 nested attribute levels and at most 256 typed attributes per format. A document that exceeds
these bounds, a duplicate document URI or a malformed document is `400 invalid_request`.

The inspector only reads object members and reports values. It does not compile Ajv, evaluate
`pattern`/`format`, resolve a reference, fetch a document or execute an imported expression.
Every verification of integrity is sha256 over the exact caller-supplied UTF-8 text.

## 6. Verifier-policy interfaces and the OpenID4VP mapping

`policyInterfaces` enumerates the interfaces AttestBook knows:

| Interface | Status | Meaning |
| --- | --- | --- |
| `attestbook.attribute-constraints@1` | `supported` | The typed attribute constraints of §3. |
| `openid4vp.dcql@1` | `partial` | A DCQL credential-query fragment for the format and claim paths, with every unexpressible constraint reported. |
| `openid4vp.presentation-exchange@1` | `unsupported` | No Presentation Exchange mapping is implemented; AttestBook does not guess input descriptors. |

The DCQL fragment has `complete: false` and is **not** an OpenID4VP authorization request:

```json
{
  "interfaceId": "openid4vp.dcql@1",
  "complete": false,
  "credentialQuery": {
    "id": "credential-1",
    "format": "dc+sd-jwt",
    "claims": [{ "path": ["given_name"] }]
  },
  "mapped": ["credential format", "claim paths"],
  "unsupported": [
    {
      "code": "type_identifier_unavailable",
      "scope": "type_identifier",
      "reason": "The pinned rulebook snapshot stores schema-reference URIs and integrity values, not a vct, so \"meta.vct_values\" is not produced without fabricating a credential type."
    }
  ],
  "notes": ["The credential query is a mapping fragment, not a complete OpenID4VP authorization request, and cannot be sent to a wallet as one."]
}
```

What maps:

- `format` for `dc+sd-jwt` and `mso_mdoc`; every other rulebook format is reported
  `format_not_expressible` with `credentialQuery: null`;
- claim paths from the typed attributes (array elements become `null`) for `dc+sd-jwt`; both a
  container path such as `['address']` and its leaf path `['address', 'locality']` are emitted,
  so the verifier can choose the granularity it needs. For
  `mso_mdoc`, only a path of exactly `[namespace, data_element_identifier]` with no wildcard is
  emitted, and any other path is reported `claim_path_not_expressible`.

What is explicitly reported as unsupported, never fabricated:

- the `vct`/`doctype` type identifier that DCQL `meta` requires, because the pinned snapshot
  stores only schema-reference URIs and integrity values;
- every extracted value constraint (`type`, `const`, `enum`, length, numeric, item and
  `pattern`/`format` bounds) and unresolved keyword;
- the rulebook `required`-claim rule and object-level structural rules such as
  `additionalProperties: false`;
- trusted authorities, because the pinned snapshot carries none;
- every OpenID4VP protocol member and any holder proof or signature.

The mapping reuses the pinned `@owf/eudi-attestation-schema` format set
(`AttestationFormatValues`) instead of a locally invented list. It deliberately does not call
the package's `buildDcqlFromSchemaMeta`: that builder requires a `SchemaMeta` whose schema URIs
carry `meta.vct`/`meta.doctype_value`, which the AttestBook version snapshot does not store.
Constructing those values from the reference URI or the rulebook id would fabricate a
credential type, so the gap is reported per format instead.

The interface-level `unsupported` list repeats the cross-format gaps so a client reading only
`policyInterfaces` still sees them. `nonClaims` states `presentationRequest: false`,
`proof: false` and `cryptographicVerification`/`protocolConformance`/`interoperability` as
`NOT_TESTED`; the limitations repeat that no such result is produced.

## 7. HTTP contract

`POST /api/v1/verifiers/constraints` is public (it reads only public rulebook data and computes
locally) and accepts:

```json
{
  "rulebookId": "…",
  "rulebookVersion": "1.0",
  "attestationType": "PID",
  "format": "dc+sd-jwt",
  "schemaDocuments": [
    { "uri": "https://issuer.example/schema/pid.json", "content": "{ … }" }
  ]
}
```

`format` and `schemaDocuments` are optional. Without `format`, every supported format of the
attestation type is resolved. Without `schemaDocuments`, the response still carries the
format-level constraints and reports each reference `schema_document_not_supplied`; attribute
constraints require the exact documents. The response is `{ "data": VerifierConstraints }`
and validates against the `VerifierConstraintsResponse` OpenAPI component. The route writes
nothing and performs no network request. A malformed request, foreign/unpinned document,
integrity mismatch, invalid JSON, exceeded bound or unsupported format is `400
invalid_request`; a missing rulebook, version or attestation type is `404 not_found`. See
[`docs/api.md`](api.md) §3.7 and §4.

## 8. Limitations

- Constraints are only as grounded as the caller-supplied, integrity-verified schema documents;
  AttestBook does not fetch, cache or re-publish them, so a URI without a verified sha256 pin
  cannot ground any attribute.
- Only schema references attached to the selected attestation type are inspected; rulebook-level
  references are not applied to one attestation type in this slice.
- A document that declares a JSON Schema dialect other than 2020-12 is reported and not
  inspected, so draft-specific semantics are never interpreted as 2020-12.
- The extraction subset is intentionally small. A rulebook whose constraints rely on
  references, patterns, formats, conditionals or alternative schemas still exposes the
  attributes and reports the unresolved keywords, but cannot promise a complete constraint
  set. `pattern`/`format` values are reported, not evaluated.
- Multiple documents may declare the same pointer. Their attributes are returned separately
  with per-document `sources`; this slice does not compute a normative intersection across
  documents.
- Type Metadata references are reported and not converted into guessed constraints, because
  Type Metadata declares claims and display data but not value constraints.
- The DCQL fragment omits `meta` for `dc+sd-jwt`/`mso_mdoc` because the pinned snapshot has no
  `vct`/`doctype` value; a verifier must supply and validate that policy input itself.
- No OpenID4VP request, presentation submission, holder proof, trust decision or conformance
  result is produced. A structural constraint result says nothing about cryptography, trust,
  protocol or interoperability.
- No request, schema document or verifier policy is persisted, so a response is only
  reproducible from the same pinned version and document bytes.

## 9. Verification and tests

- `src/verifier/constraints.test.ts` — real migrated registry, real published version snapshot
  and the real inspector: typed and nested attributes, array item constraints, claim paths,
  `allOf` merging and conflicts, pattern/format reporting, unresolved keywords, partial DCQL
  fragments, interface enumeration, missing/unpinned/Type Metadata documents, multi-format
  selection, non-DCQL formats, non-claims and negative bounds/inputs;
- `src/api/verifier.test.ts` — the Hono route, OpenAPI component validation, typed constraints,
  partial DCQL mapping, unsupported mappings, format selection, 400/404/503 cases;
- `bun run openapi:check` — the generated document including the new operation and components;
- `bun run check` — formatting, lint, strict typecheck and the whole test suite.

Run them from the repository root:

```
bun test src/verifier src/api/verifier.test.ts
bun run openapi:check
bun run check
```
