// Reference-resolution boundary.
//
// Fetching and SRI verification are OWF capabilities: `resolveSchemaReferences`
// verifies W3C SRI over the transferred bytes, follows SD-JWT VC Type Metadata
// `extends` chains with a depth bound, and parses plain JSON Schema references.
// OWF supports sha256 SRI only (docs/standards.md §5.5), so other algorithms are
// reported as unsupported instead of being passed through and silently ignored.

import {
  resolveSchemaReferences,
  type AttestationFormat,
  type ResolveSchemaReferencesOptions,
  type ResolvedSchemaReference,
} from '@owf/eudi-attestation-schema'

import {
  fail,
  invalidInput,
  ok,
  unsupportedOperation,
  type AdapterDiagnostic,
  type AdapterResult,
} from './diagnostics'
import type { CanonicalSchemaMeta } from './model'
import { buildOwfSchemaMeta } from './owf'
import { OWF_FORMAT_VALUES } from './profiles'
import { parseSri } from './wire'

export interface ResolveSchemaMetaReferencesOptions {
  readonly schemaMeta: CanonicalSchemaMeta
  /** Formats to resolve; OWF accepts only `dc+sd-jwt` and `mso_mdoc`. */
  readonly selectedFormats?: readonly string[]
  readonly resolve: ResolveSchemaReferencesOptions['resolve']
  readonly verifyIntegrity?: boolean
  readonly maxExtendsDepth?: number
}

/**
 * Resolves the schema references of a canonical document through OWF. The
 * canonical document is first serialized to the OWF profile, so this operation
 * supports OWF-representable documents only; the reason is returned as a
 * diagnostic otherwise.
 */
export async function resolveSchemaMetaReferences(
  options: ResolveSchemaMetaReferencesOptions,
): Promise<AdapterResult<readonly ResolvedSchemaReference[]>> {
  const diagnostics: AdapterDiagnostic[] = []
  const verifyIntegrity = options.verifyIntegrity !== false

  for (const [index, format] of (options.selectedFormats ?? []).entries()) {
    if (!(OWF_FORMAT_VALUES as readonly string[]).includes(format)) {
      diagnostics.push(
        unsupportedOperation(
          'unsupported_format',
          `OWF 0.5.4 resolves only ${OWF_FORMAT_VALUES.join(', ')}; "${format}" is not supported`,
          `selectedFormats.${index}`,
        ),
      )
    }
  }

  if (verifyIntegrity) {
    for (const [index, reference] of options.schemaMeta.schemaURIs.entries()) {
      if (reference.integrity === undefined) {
        continue
      }
      const sri = parseSri(reference.integrity)
      if (sri === undefined) {
        diagnostics.push(
          invalidInput(
            'invalid_member_value',
            'expected a W3C SRI value such as sha256-<base64>',
            `schemaURIs.${index}.integrity`,
          ),
        )
      } else if (sri.algorithm !== 'sha256') {
        diagnostics.push(
          unsupportedOperation(
            'unsupported_sri_algorithm',
            `OWF 0.5.4 verifies sha256 SRI only; "${sri.algorithm}" cannot be verified`,
            `schemaURIs.${index}.integrity`,
          ),
        )
      }
    }
  }

  if (diagnostics.some((entry) => entry.kind !== 'preserved' && entry.kind !== 'not_tested')) {
    return fail(diagnostics)
  }

  const built = buildOwfSchemaMeta(options.schemaMeta)
  if (!built.ok) {
    return fail([...diagnostics, ...built.diagnostics])
  }
  diagnostics.push(...built.diagnostics)

  try {
    const resolved = await resolveSchemaReferences({
      schemaMeta: built.value,
      resolve: options.resolve,
      ...(options.selectedFormats !== undefined
        ? { selectedFormats: options.selectedFormats as AttestationFormat[] }
        : {}),
      ...(options.verifyIntegrity !== undefined
        ? { verifyIntegrity: options.verifyIntegrity }
        : {}),
      ...(options.maxExtendsDepth !== undefined
        ? { maxExtendsDepth: options.maxExtendsDepth }
        : {}),
    })
    return ok(resolved, diagnostics)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = /integrit/i.test(message) ? 'integrity_mismatch' : 'invalid_reference'
    return fail([...diagnostics, invalidInput(code, message, 'schemaURIs')])
  }
}
