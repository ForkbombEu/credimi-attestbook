# Rulebook-driven issuer fixtures

**Status:** Phase 3 implementation of the issuer-fixture slice by
[issue #44](https://github.com/ForkbombEu/credimi-attestbook/issues/44) (specification FR-013),
extended by [issue #102](https://github.com/ForkbombEu/credimi-attestbook/issues/102) to ground
a canonical AttestBook-hosted schema reference in the immutable local schema store. It turns
the JSON Schema attribute constraints referenced by one pinned rulebook version into an
unsigned credential claim payload, caller-selected attribute overrides and labelled, verified
negative cases. It never signs, issues or presents a credential.

**Authoritative spec:** [`docs/specification.md`](specification.md) §9 (FR-013) and §15
**Requirements:** [`docs/requirements.md`](requirements.md) FR-013 and AC-10
**Related:** [`docs/discovery.md`](discovery.md) (FR-006 issuer configurations),
[`docs/validation.md`](validation.md) (the pinned-version validation model this slice reuses),
[`docs/api.md`](api.md) (the HTTP contract) and [`docs/registry.md`](registry.md) (versions and
digests).

## 1. Scope and boundaries

Implemented by #44 and extended by #102:

- selection of one rulebook, one published/historical/draft version and one attestation type
  from the registry, with the version digest recomputed and verified before generation;
- extraction of the effective attribute constraints from the JSON Schema 2020-12 documents
  that the selected attestation type references in that exact version;
- resolution of a canonical AttestBook-hosted reference from the immutable local schema store
  (never over HTTP), requiring the stored bytes to match both their recorded SHA-256 digest and
  the pinned rulebook `sha256-...` SRI value before they can ground a payload;
- matching each caller-supplied document to an external version schema reference by URI and
  verifying the reference's sha256 SRI value before the document can ground a payload;
- synthesis of a complete object payload that satisfies every applied document, with an
  attribute definition for each generated property (JSON Pointer, name, required flag,
  effective types and constraints, declaring reference URIs);
- caller-selected attribute overrides addressed by JSON Pointer, reported back with the
  resulting payload validation;
- deterministic negative cases derived from the effective constraints, each labelled and
  verified to fail the applied documents before it is returned;
- the public `POST /api/v1/issuers/fixtures` route and its OpenAPI components.

Deliberately **not** implemented:

- signing, key management, credential issuance, OpenID4VCI protocol execution or a wallet
  exchange. The payload is unsigned claim data, not an SD-JWT VC compact serialization;
- fetching a referenced schema document over HTTP. A canonical AttestBook-hosted reference is
  read from the local immutable store; any other reference needs the exact caller-supplied
  bytes. An SSRF-safe fetch path is a separate issue and is not used here;
- synthesis from SD-JWT VC Type Metadata alone. Type Metadata describes claims and display
  values, but not attribute types or value constraints, so guessing a payload from it would
  not be grounded in the rulebook;
- persistence of generated fixtures, schema documents or generation history;
- an exhaustive conformance suite. The negative cases exercise the supported schema subset,
  not every possible issuer or verifier behavior;
- any cryptographic, trust, protocol-conformance or interoperability result.

## 2. Public service contract

`src/fixtures/` exposes `IssuerFixtureGenerator`:

```ts
// A canonical AttestBook-hosted reference is read from the immutable store.
const hosted = new IssuerFixtureGenerator({
  source: registry,
  hostedSchemas: { publicBaseUrl: 'https://attestbook.example', store: registry },
})
const hostedFixture = await hosted.generate({
  rulebookId: rulebook.id,
  rulebookVersion: '1.0',
  attestationType: 'PID',
  overrides: [{ path: '/given_name', value: 'Ada' }],
})

// An external reference keeps the exact caller-supplied document bytes.
const externalFixture = await generator.generate({
  rulebookId: rulebook.id,
  rulebookVersion: '1.0',
  attestationType: 'PID',
  schemaDocuments: [{ uri: 'https://issuer.example/schema/pid.json', content: schemaText }],
})
```

`schemaDocuments` is optional: it is needed only for external references. `hostedSchemas` is
absent when the deployment has no configured `PUBLIC_BASE_URL`, and then a canonical hosted
URL is an ordinary external reference that needs caller bytes.

`generate` is asynchronous: the expensive schema work runs in a resource-bounded sandbox
child (see §2.4). It writes nothing. It throws a typed `RegistryError`:

- `not_found` when the rulebook, version or attestation type does not exist;
- `invalid_input` for a malformed request, a supplied document that does not belong to the
  selected attestation type or format, a document that does not match its sha256 SRI value, a
  selected hosted reference that is missing, corrupt, unpinned or mismatched, an override path
  that does not exist in the generated payload, constraints outside the supported synthesis
  subset, or a sandbox timeout/memory/output limit;
- `IssuerFixtureUnavailableError` (API code `fixture_unavailable`, HTTP `503`) when the shared
  sandbox is at its concurrency limit or unavailable on the platform.

The result is an `IssuerFixtureResult`:

| Field | Meaning |
| --- | --- |
| `kind` | `attestbook.unsigned-issuer-fixture@1`; a format marker, not a credential media type. |
| `signed`, `issued` | Always `false`; the contract says AttestBook never signs or issues a fixture. |
| `rulebook` | Pinned rulebook id/name/version, recomputed digest, `digestVerified: true`, profile and status. |
| `attestation` | Selected attestation type, attestation LoS, binding type and supported formats. |
| `formats` | Distinct formats whose schema references grounded the payload. |
| `schemaReferences` | Per reference: URI, integrity pin, `integrityVerified`, `source` (`hosted`, `caller` or `null`), document kind, `applied` and a safe diagnostic. |
| `attributes` | Effective attribute definitions, generated or omitted with a reason. |
| `payload` | The unsigned claim payload (a JSON object). |
| `payloadValidation` | `PASS`/`FAIL` of the payload against the applied schema documents, with non-sensitive findings. |
| `overrides` | Every applied override, its JSON Pointer and value. |
| `negativeCases` | Labelled, reproducible negative payloads, each verified to fail. |
| `diagnostics` | Safe, machine-readable findings about references and generation. |
| `limitations` | The explicit boundaries in §8. |

### 2.1 Grounding and integrity

AttestBook does not store schema bodies in a version snapshot. A reference is resolved from
exactly one deterministic source:

1. **Canonical AttestBook-hosted reference (#102).** The URI must be exactly
   `${PUBLIC_BASE_URL}/api/v1/schema-documents/{documentId}/content` for this deployment's
   configured origin, with no credentials, query, fragment or extra path. The generator reads
   the document from the immutable local store — never over HTTP — recomputes SHA-256 over the
   stored bytes, requires it to equal the document's recorded `contentDigest`, and requires
   the reference `sha256-...` SRI to equal that digest. A look-alike origin, prefixed string or
   near-miss path is not hosted and stays external. A caller document for the same URI is
   ignored, so caller content cannot override a trusted pinned hosted schema.
2. **External reference.** The request carries `schemaDocuments` with the exact UTF-8 document
   text for that URI; the supplied bytes must match the reference sha256 SRI value.

A fixture is grounded only when all of the following hold for a selected reference:

1. it is one of the selected attestation type's references in that exact version (and of the
   requested `format`, when one is given);
2. the reference carries a verifiable sha256 SRI value and the resolved bytes match it;
3. the document is a JSON Schema 2020-12 object inside the shared document, depth,
   ambiguous-kind and unsupported-keyword bounds.

A selected hosted reference that is missing from the store, whose stored bytes no longer hash
to their recorded digest, whose SRI is absent or not sha256, or whose stored digest does not
match the pinned SRI aborts generation with an explicit `invalid_input` diagnostic: a trusted
pinned hosted reference never silently degrades into an ungrounded partial fixture. References
without a verifiable caller-supplied document and SD-JWT VC Type Metadata references are
reported in `schemaReferences` and `diagnostics` and never silently used; a missing external
document does not prevent a hosted document in the same selection from grounding the payload.
If no reference survives these checks the request fails with `invalid_input` instead of
returning an ungrounded payload.

### 2.2 Attribute definitions

An attribute is reported for every generated property, including nested object properties
and array item constraints. `pointer` is a JSON Pointer into the schema; array elements use
the `*` wildcard described in [`docs/validation.md`](validation.md) because JSON Pointer has
no array wildcard. `constraints` carries only the effective supported constraints, for
example:

```json
{
  "pointer": "/given_name",
  "name": "given_name",
  "required": true,
  "types": ["string"],
  "constraints": { "type": ["string"], "minLength": 1, "maxLength": 64 },
  "sources": ["https://issuer.example/schema/pid.json"],
  "generated": true
}
```

An optional attribute whose constraints cannot be synthesized is omitted from the payload and
reported with `generated: false` and a `reason`. A required attribute in that situation makes
the request fail: a payload that silently omits a required claim would not be a valid fixture.

### 2.3 Overrides

Overrides are an ordered list of `{ path, value }`, where `path` is a JSON Pointer into the
generated payload, for example `/address/locality`. Paths are limited to 64 entries and 512
characters each and must address an existing attribute; unknown paths are `invalid_input`.
The final payload is re-evaluated against every applied schema document. An override that
deliberately violates a constraint is allowed and reflected honestly as
`payloadValidation.status: "FAIL"` with findings; the unsigned markers are unchanged.

### 2.4 Sandboxed synthesis

The parent process performs only the cheap, already-shared preparation: hosted resolution and
stored-digest verification, reference matching, JSON parsing, sha256 SRI verification, depth
and validation-unsafe keyword checks. The untrusted schema documents are then compiled,
evaluated and synthesized inside the same resource-bounded sandbox runner used by credential
validation, with a hard timeout, RSS watchdog, output cap and a concurrency limit shared across
both features. A hostile or merely expensive pinned schema therefore cannot block the HTTP
event loop, and `/health` stays responsive during generation. Sandbox timeout, memory and output
failures are reported as `invalid_input` with the limit that was exceeded; a busy or unavailable
sandbox is a `503`.

The fixture evaluator checks only own object properties, so an undeclared `__proto__` key in
an override value is evaluated as an ordinary own property (for example by
`additionalProperties`). The pinned Ajv 8.20.0 evaluator, however, does not evaluate a
`properties.__proto__` subschema. A schema document that declares any key named `__proto__`
is therefore refused rather than applied: the request fails with `400 invalid_request` when
no other document can ground the fixture, or reports that document as `applied: false` with a
`schema_not_usable` diagnostic when another one can.

Every schema document is first checked by name across the whole document: each property name
it uses in `properties`, `required`, `dependentRequired` or `dependentSchemas`, at any depth,
must be one the pinned evaluator really enforces. That includes names inside
`additionalProperties` subschemas and optional properties outside the synthesis subset. The
known Ajv 8.20.0 gaps are `required` entries named `""`, `dependentRequired` entries named
`""` and `properties.__proto__`; a document using any unenforced name is not applied. If it
was the only usable document the request fails with `400 invalid_request`; otherwise it is
reported as `applied: false` with a `schema_not_usable` diagnostic while another document
grounds the fixture.

Before reporting any result, the generator also self-checks the evaluator against the
constraints it synthesized: for every declared property it deletes a required claim, and it
sets a value that the property's declared `type`, `const` or `enum` forbids, confirming that
the evaluator rejects both. If the evaluator accepts a violating payload, generation fails
with `400 invalid_request` rather than returning `PASS`. This structural guard also covers
property names not known today.

## 3. Supported synthesis subset

The synthesizer interprets a bounded, deterministic subset of JSON Schema 2020-12. It
supports:

| Keyword | Behavior |
| --- | --- |
| `type` | String, number, integer, boolean, object, array and null values; unions pick a deterministic satisfiable member. |
| `const`, `enum` | The exact constant or a value common to every enumeration. |
| `properties`, `required`, `additionalProperties` | Object members are generated in sorted order; every required member is present; no undeclared members are added. |
| `items`, `minItems`, `maxItems` | Between the effective item bounds, capped at 8 generated items. |
| `minLength`, `maxLength` | A deterministic ASCII string within the effective bounds. |
| `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` | A deterministic number/integer within the effective bounds and multiples. |
| `allOf` | Branches are flattened and their constraints intersected. |

Everything else that can affect a value is reported, not ignored. The reported set includes
`$ref`, `$dynamicRef`, `$recursiveRef`, `pattern`, `format`, `patternProperties`,
`uniqueItems`, `oneOf`, `anyOf`, `not`, `if`/`then`/`else`, `contains`, `minContains`,
`maxContains`, `propertyNames`, `dependentRequired`, `dependentSchemas`, `dependencies`,
`minProperties`, `maxProperties`, `prefixItems`, `additionalItems` and the
`unevaluated*`/`contentSchema` keywords.

Refs, patterns, formats, pattern properties and unique items are already refused by the
shared schema preparation used for validation; the remaining synthesis-only restrictions are
this slice's own boundary. A document that declares any `__proto__` key is also refused,
because the pinned Ajv 8.20.0 evaluator does not evaluate that property subschema. A document
that uses any of these may still be a valid rulebook reference, but this slice will not guess a
value for it.

## 4. Negative cases

Negative cases are derived from the same effective constraints and the same generated
payload, in deterministic order:

| Category | Derived from |
| --- | --- |
| `missing_required` | Removing one required object property. |
| `type` | Replacing a value with a value of a different JSON type. |
| `enum` | A value outside the effective enumeration. |
| `const` | A value other than the required constant. |
| `max_length`, `min_length` | A string just outside the effective length bounds. |
| `maximum`, `minimum` | A number just outside the effective numeric bounds (including exclusive bounds). |
| `multiple_of` | A value that is not a multiple of the effective factor. |
| `max_items`, `min_items` | An array just outside the effective item bounds. |
| `additional_properties` | Adding an undeclared property to an `additionalProperties: false` object. |

Each candidate is evaluated with the real Ajv 8.20.0 evaluator against every applied schema
document and is included only when it really fails. The candidate is also kept only when the
violation Ajv reported matches the intended constraint keyword, so a case never carries a
category that the payload does not actually exercise. `path` is the mutated instance location
(for example `/address/locality` for a missing required attribute, or
`/__fixture_extra_claim__` for an undeclared property), and the id is stable
(`<category>:<path>`). The payload is deterministic and the list is capped at 32 cases.
`expected` is always `FAIL`.

A negative case is a schema-invalid payload, not a judgment about a real issuer. It is a
reproducible starting point for an external issuer's own negative tests.

## 5. HTTP contract

`POST /api/v1/issuers/fixtures` is public (it reads only public rulebook data, the local
schema store and computes locally) and accepts:

```json
{
  "rulebookId": "…",
  "rulebookVersion": "1.0",
  "attestationType": "PID",
  "format": "dc+sd-jwt",
  "schemaDocuments": [
    { "uri": "https://issuer.example/schema/pid.json", "content": "{ … }" }
  ],
  "overrides": [{ "path": "/given_name", "value": "Ada" }]
}
```

`format`, `schemaDocuments` and `overrides` are optional. `schemaDocuments` is needed only for
external references; a canonical AttestBook-hosted reference is resolved from the store and a
request without `schemaDocuments` succeeds when at least one selected hosted JSON Schema
grounds the payload. The response is `{ "data": IssuerFixture }` and validates against the
`IssuerFixtureResponse` OpenAPI component; each `schemaReferences` entry names its `source`.
The route writes nothing and does not perform a network request. A malformed request,
unmatched/unpinnable external document, missing/corrupt/tampered hosted reference, unsupported
synthesis constraint or exceeded sandbox limit is `400 invalid_request`; a busy or unavailable
sandbox is `503 fixture_unavailable`; a missing rulebook, version or attestation type is
`404 not_found`. See [`docs/api.md`](api.md) §3.6 and §4 for the shared error envelope.

## 6. Fixture versus issued credential

AttestBook deliberately does not produce credentials. A returned payload:

- has no signature, no issuer key and no key-binding proof;
- is not an SD-JWT VC compact serialization and is not valid for the credential-validation
  route, which parses SD-JWT VCs;
- carries `kind`, `signed: false` and `issued: false`, plus an explicit limitation, so an
  external tool cannot confuse it with an issued credential;
- validates only the applied schema documents, whether resolved from the hosted store or
  supplied by the caller. Even a structurally valid payload says nothing about cryptography,
  issuer trust, protocol conformance or interoperability.

An external issuer that wants to test its real credential flow must sign and issue the
payload itself, with its own keys and protocols, and validate the resulting artifact through
its own issuer/verifier pipeline.

## 7. Verification and tests

- `src/fixtures/generate.test.ts` — real migrated registry, real published version snapshot,
  real schema preparation and the real sandbox child: grounding, determinism, attribute
  definitions, overrides (including deliberate violations), unsupported optional/required
  constraints, format selection, Type Metadata rejection, SRI mismatch, unknown resources,
  the sandbox time limit, unavailable-platform handling, refusal of schemas that declare
  `__proto__`, undeclared-`__proto__` override evaluation, empty-string required-name refusal
  (nested and top-level), document-level unenforced-name refusal in `additionalProperties`,
  skipped optional and `dependentRequired` positions, multi-document `applied: false`
  reporting, the generic evaluator blind-spot guard, the name-collection/probe helpers, an
  unconstrained optional property and large-enum intersection;
- `src/fixtures/hosted-schema.test.ts` — hosted resolution without caller documents, caller
  bytes not overriding a hosted reference, a missing hosted document, stored bytes that no
  longer match their digest, a mismatched SRI pin, an unpinned reference, an unsupported pin
  algorithm, hosted Type Metadata rejection, Type Metadata kept distinct from a hosted JSON
  Schema, mixed hosted/external selection with explicit missing-reference behavior, an
  external-only reference and an unconfigured public origin;
- `src/api/fixtures.test.ts` — the Hono route, OpenAPI component validation, overrides,
  400/404/503 cases, the `fixture_unavailable` mapping, an HTTP `__proto__` schema refusal, an
  undeclared-`__proto__` override failure, empty-name and nested-subschema unenforced-name
  refusals and a `/health` responsiveness race against a running fixture sandbox;
- `src/api/hosted-fixtures.test.ts` — the HTTP route wired with a configured public origin:
  valid hosted generation, missing/tampered/mismatched hosted references, Type-Metadata-only
  rejection, mixed hosted/external requests with and without the external document, and the
  no-origin fallback;
- `bun run openapi:check` — the generated document including the new operation and
  components;
- `bun run check` — formatting, lint, strict typecheck and the whole test suite.

Run them from the repository root:

```
bun test src/fixtures src/api/fixtures.test.ts src/api/hosted-fixtures.test.ts
bun run openapi:check
bun run check
```

## 8. Limitations

- The generated payload is only as grounded as the resolved, integrity-verified schema
  documents. A hosted document comes from this deployment's immutable store; an external one
  from the caller's exact bytes. AttestBook does not fetch, cache or re-publish a remote schema
  in this slice.
- A deployment without `PUBLIC_BASE_URL` cannot recognise a canonical hosted URL, so such a
  reference behaves as an external reference and needs caller bytes. The deployment that
  published the hosted reference is the one that can resolve it.
- A selected hosted reference that is missing, corrupt, unpinned or mismatched aborts the
  request. Partial grounding from other references would hide that a trusted, pinned document
  was unavailable.
- The synthesis subset is intentionally small. A rulebook whose constraints rely on patterns,
  formats, references or conditional schemas does not produce a fixture in this slice; the
  request names the unsupported keyword instead of fabricating a value.
- Multi-document synthesis intersects the constraints of every applied document. Conflicting
  types, constants or enumerations fail the request rather than choosing one document.
- Attribute pointers use the schema wildcard `*` for array elements; override paths use
  concrete instance indices. Neither establishes a full JSON Schema resolver.
- Negative cases cover the supported constraints only and are not a conformance test suite.
- A schema document that declares a key named `__proto__` cannot be applied, because the
  pinned Ajv 8.20.0 evaluator does not evaluate that property subschema. Undeclared
  `__proto__` keys in override values remain ordinary own properties and are evaluated.
- A schema document is refused when any property name it uses in
  `properties`/`required`/`dependentRequired`/`dependentSchemas` is one the pinned evaluator
  does not enforce. The known Ajv 8.20.0 cases are `required`/`dependentRequired` entries
  named `""` and `properties.__proto__`.
- The generator refuses a fixture when its evaluator self-check accepts a payload that breaks
  a synthesized property constraint. The known Ajv 8.20.0 case is a `required` entry named
  `""`; a schema document that declares it cannot ground a fixture in this slice.
- Compilation, synthesis, payload evaluation and negative-case verification run in the
  shared resource-bounded sandbox. The sandbox limits are configurable through the same
  `SCHEMA_SANDBOX_*` settings as credential validation and the concurrency cap is shared, so
  a busy sandbox can answer `503 fixture_unavailable` instead of queueing indefinitely.
- No fixture or generation history is persisted, so a response is only reproducible from the
  same pinned version, resolved schema documents and overrides.
