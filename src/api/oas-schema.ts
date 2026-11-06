// Loader for the vendored official OpenAPI 3.1 JSON Schema.
//
// The schema is read from disk rather than imported so a 34 KiB schema does not
// become a TypeScript type in every compilation, and so the check works the
// same way under Bun tests and the CI script.

import { readFileSync } from 'node:fs'

/** Canonical source of the vendored schema. */
export const OAS_31_SCHEMA_SOURCE = 'https://spec.openapis.org/oas/3.1/schema/2022-10-07'

/**
 * Returns the official OpenAPI 3.1 schema used to validate the generated
 * document.
 *
 * The vendored schema uses `$dynamicRef: "#meta"` in four places (the Schema
 * Object positions). Ajv 8.20.0 resolves that reference to the document root
 * instead of the local `$defs/schema` anchor, which rejects every valid Schema
 * Object. The target of the reference is unambiguous (`$defs/schema` is the
 * only `$dynamicAnchor` in the document), so the loader rewrites it to the
 * equivalent static `$ref`. The vendored file itself stays byte-for-byte the
 * published schema.
 */
export function loadOpenApi31Schema(): Record<string, unknown> {
  const text = readFileSync(new URL('./oas-3.1-schema.json', import.meta.url), 'utf8')
  const staticRefs = text.replaceAll('"$dynamicRef": "#meta"', '"$ref": "#/$defs/schema"')
  return JSON.parse(staticRefs) as Record<string, unknown>
}
