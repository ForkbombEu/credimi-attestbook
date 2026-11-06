// CI entry point: validate the generated OpenAPI 3.1 document.
//
// Run with `bun run openapi:check`. The check fails when:
//   * the generated document does not validate against the official OpenAPI 3.1
//     JSON Schema;
//   * a generated component schema is not a valid JSON Schema 2020-12 document.
//
// The contract tests in `openapi.test.ts` additionally compare the document's
// operations with the routes Hono actually registered.

import Ajv2020 from 'ajv/dist/2020'

import { OAS_31_SCHEMA_SOURCE, loadOpenApi31Schema } from './oas-schema'
import { buildOpenApiDocument } from './openapi'

function main(): void {
  const document = buildOpenApiDocument()
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
  const validateDocument = ajv.compile(loadOpenApi31Schema())

  if (!validateDocument(document)) {
    console.error('generated OpenAPI document does not validate against the OpenAPI 3.1 schema')
    console.error(JSON.stringify(validateDocument.errors, null, 2))
    process.exit(1)
  }

  const components = document.components['schemas']
  if (typeof components !== 'object' || components === null || Array.isArray(components)) {
    console.error('generated OpenAPI document has no component schemas')
    process.exit(1)
  }

  for (const [name, schema] of Object.entries(components)) {
    try {
      ajv.compile(schema as Record<string, unknown>)
    } catch (error) {
      console.error(`component schema ${name} is not a valid JSON Schema 2020-12 document`)
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
  }

  const operations = Object.values(document.paths).reduce(
    (total, pathItem) => total + Object.keys(pathItem).length,
    0,
  )
  console.log(
    `OpenAPI ${document.openapi} document validated (${String(operations)} operations, ${String(Object.keys(components).length)} schemas) against ${OAS_31_SCHEMA_SOURCE}`,
  )
}

main()
