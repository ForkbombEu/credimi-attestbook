# Rulebook-driven issuer fixtures

**Status:** Phase 3 implementation of the issuer-fixture slice by
[issue #44](https://github.com/ForkbombEu/credimi-attestbook/issues/44) (specification FR-013).
It turns the JSON Schema attribute constraints referenced by one pinned rulebook version into
an unsigned credential claim payload, caller-selected attribute overrides and labelled,
verified negative cases. It never signs, issues or presents a credential.

**Authoritative spec:** [`docs/specification.md`](specification.md) §9 (FR-013) and §15
**Requirements:** [`docs/requirements.md`](requirements.md) FR-013 and AC-10
**Related:** [`docs/discovery.md`](discovery.md) (FR-006 issuer configurations),
[`docs/validation.md`](validation.md) (the pinned-version validation model this slice reuses),
[`docs/api.md`](api.md) (the HTTP contract) and [`docs/registry.md`](registry.md) (versions and
digests).

## 1. Scope and boundaries

Implemented by #44:

- selection of one rulebook, one published/historical/draft version and one attestation type
  from the registry, with the version digest recomputed and verified before generation;
- extraction of the effective attribute constraints from the JSON Schema 2020-12 documents
  that the selected attestation type references in that exact version;
- matching each caller-supplied document to a version schema reference by URI and verifying
  the reference's sha256 SRI value before the document can ground a payload;
- synthesis of a complete object payload that satisfies every applied document, with an
  attribute definition for each generated property (JSON Pointer, name, required flag,
  effective types and constraints, declaring reference URIs);
- caller-selected attribute overrides addressed by JSON Pointer, reported back with the
  resulting payload validation;
- deterministic negative cases derived from the effective constraints, each labelled and
  verified to fail the supplied documents before it is returned;
- the public `POST /api/v1/issuers/fixtures` route and its OpenAPI components.

Deliberately **not** in #44:

- signing, key management, credential issuance, OpenID4VCI protocol execution or a wallet
  exchange. The payload is unsigned claim data, not an SD-JWT VC compact serialization;
- fetching the referenced schema documents. As in credential validation, the caller supplies
  the exact bytes; no remote schema is retrieved by this slice;
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
const generator = new IssuerFixtureGenerator({ source: registry })
const fixture = await generator.generate({
  rulebookId: rulebook.id,
  rulebookVersion: '1.0',
  attestationType: 'PID',
  schemaDocuments: [{ uri: 'https://issuer.example/schema/pid.json', content: schemaText }],
  overrides: [{ path: '/given_name', value: 'Ada' }],
})
```

`generate` is asynchronous: the expensive schema work runs in a resource-bounded sandbox
child (see §2.4). It writes nothing. It throws a typed `RegistryError`:

- `not_found` when the rulebook, version or attestation type does not exist;
- `invalid_input` for a malformed request, a supplied document that does not belong to the
  selected attestation type or format, a document that does not match its sha256 SRI value,
  an override path that does not exist in the generated payload, constraints outside the
  supported synthesis subset, or a sandbox timeout/memory/output limit;
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
| `schemaReferences` | Per reference: URI, integrity pin, `integrityVerified`, document kind, `applied` and a safe diagnostic. |
| `attributes` | Effective attribute definitions, generated or omitted with a reason. |
| `payload` | The unsigned claim payload (a JSON object). |
| `payloadValidation` | `PASS`/`FAIL` of the payload against the applied schema documents, with non-sensitive findings. |
| `overrides` | Every applied override, its JSON Pointer and value. |
| `negativeCases` | Labelled, reproducible negative payloads, each verified to fail. |
| `diagnostics` | Safe, machine-readable findings about references and generation. |
| `limitations` | The explicit boundaries in §7. |

### 2.1 Grounding and integrity

AttestBook does not store schema bodies in a version snapshot. A fixture is therefore
grounded in a caller-supplied document only when all of the following hold:

1. the document URI is a schema reference of the selected attestation type in that exact
   version (and of the requested `format`, when one is given);
2. the reference carries a sha256 SRI value and the supplied bytes match it;
3. the document is a JSON Schema 2020-12 object inside the shared document, depth and
   unsupported-keyword bounds.

References without a verifiable sha256 pin, references whose document is not supplied and
SD-JWT VC Type Metadata references are reported in `schemaReferences` and `diagnostics` and
never silently used. If no reference survives these checks the request fails with
`invalid_input` instead of returning an ungrounded payload.

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

The parent process performs only the cheap, already-shared preparation: reference matching,
JSON parsing, sha256 SRI verification, depth and validation-unsafe keyword checks. The
untrusted schema documents are then compiled, evaluated and synthesized inside the same
resource-bounded sandbox runner used by credential validation, with a hard timeout, RSS
watchdog, output cap and a concurrency limit shared across both features. A hostile or merely
expensive pinned schema therefore cannot block the HTTP event loop, and `/health` stays
responsive during generation. Sandbox timeout, memory and output failures are reported as
`invalid_input` with the limit that was exceeded; a busy or unavailable sandbox is a `503`.

The fixture evaluator checks only own object properties, so an undeclared `__proto__` key in
an override value is evaluated as an ordinary own property (for example by
`additionalProperties`). The pinned Ajv 8.20.0 evaluator, however, does not evaluate a
`properties.__proto__` subschema. A schema document that declares any key named `__proto__`
is therefore refused rather than applied: the request fails with `400 invalid_request` when
no other document can ground the fixture, or reports that document as `applied: false` with a
`schema_not_usable` diagnostic when another one can.

Before reporting any result, the generator also self-checks the evaluator against the
constraints it synthesized: for every declared property it deletes a required claim, and it
sets a value that the property's declared `type`, `const` or `enum` forbids, confirming that
the evaluator rejects both. If the evaluator accepts a violating payload, generation fails
with `400 invalid_request` rather than returning `PASS`. This structural guard also covers
property names not known today. The known Ajv 8.20.0 gap is a `required` entry whose name is
the empty string `""`, which is never enforced.

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

`POST /api/v1/issuers/fixtures` is public (it reads only public rulebook data and computes
locally) and accepts:

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

`format` and `overrides` are optional; `schemaDocuments` must contain at least one document
that survives the grounding rules. The response is `{ "data": IssuerFixture }` and validates
against the `IssuerFixtureResponse` OpenAPI component. The route writes nothing and does not
perform a network request. A malformed request, unmatched/unpinnable document, unsupported
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
- validates only the supplied schema documents. Even a structurally valid payload says
  nothing about cryptography, issuer trust, protocol conformance or interoperability.

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
  (nested and top-level), the generic evaluator blind-spot guard, an unconstrained optional
  property and large-enum intersection;
- `src/api/fixtures.test.ts` — the Hono route, OpenAPI component validation, overrides,
  400/404/503 cases, the `fixture_unavailable` mapping, an HTTP `__proto__` schema refusal, an
  undeclared-`__proto__` override failure, an empty-string required-name refusal and a
  `/health` responsiveness race against a running fixture sandbox;
- `bun run openapi:check` — the generated document including the new operation and
  components;
- `bun run check` — formatting, lint, strict typecheck and the whole test suite.

Run them from the repository root:

```
bun test src/fixtures src/api/fixtures.test.ts
bun run openapi:check
bun run check
```

## 8. Limitations

- The generated payload is only as grounded as the caller-supplied, integrity-verified schema
  documents; AttestBook does not fetch, cache or re-publish them.
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
- The generator refuses a fixture when its evaluator self-check accepts a payload that breaks
  a synthesized property constraint. The known Ajv 8.20.0 case is a `required` entry named
  `""`; a schema document that declares it cannot ground a fixture in this slice.
- Compilation, synthesis, payload evaluation and negative-case verification run in the
  shared resource-bounded sandbox. The sandbox limits are configurable through the same
  `SCHEMA_SANDBOX_*` settings as credential validation and the concurrency cap is shared, so
  a busy sandbox can answer `503 fixture_unavailable` instead of queueing indefinitely.
- No fixture or schema document is persisted, so a response is only reproducible from the
  same pinned version, documents and overrides.
