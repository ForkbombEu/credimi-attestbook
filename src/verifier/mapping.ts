// OpenID4VP-aware mapping of rulebook constraints (FR-014, issue #45).
//
// The mapping is deliberately partial. A JSON Schema states attribute
// constraints; a DCQL credential query selects a credential format, type and
// claim paths. It cannot express a minimum length, an enumeration, a numeric
// bound or a required-claim rule, and it is only one member of an OpenID4VP
// authorization request. This module therefore emits a claim-query *fragment*
// and reports every mapping gap explicitly. It never fabricates a complete
// request, a proof, a trusted-authority result or protocol conformance.

import { AttestationFormatValues } from '@owf/eudi-attestation-schema'

import type { InspectedObjectLimitation } from './inspect'
import type {
  VerifierAttributeConstraint,
  VerifierDcqlMapping,
  VerifierPolicyInterface,
  VerifierUnsupportedMapping,
} from './types'

/**
 * Credential formats a DCQL query can select in this slice. The formats come
 * from the pinned `@owf/eudi-attestation-schema` package rather than a locally
 * invented list; the package stays the source of truth for TS11 formats.
 */
const DCQL_FORMATS = new Set<string>(AttestationFormatValues)

/** Constraint keywords DCQL cannot express on a claim. */
const VALUE_CONSTRAINT_KEYWORDS = new Set([
  'type',
  'const',
  'enum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
])

function unsupported(
  code: string,
  scope: VerifierUnsupportedMapping['scope'],
  reason: string,
  extra: { readonly path?: string; readonly keyword?: string } = {},
): VerifierUnsupportedMapping {
  return {
    code,
    scope,
    reason,
    ...(extra.path === undefined ? {} : { path: extra.path }),
    ...(extra.keyword === undefined ? {} : { keyword: extra.keyword }),
  }
}

interface ClaimQuery {
  readonly path: readonly (string | number | null)[]
}

function claimQueries(
  attributes: readonly VerifierAttributeConstraint[],
  mappingUnsupported: VerifierUnsupportedMapping[],
): ClaimQuery[] {
  const claims: ClaimQuery[] = []
  const seen = new Set<string>()
  for (const attribute of attributes) {
    if (attribute.name === '*') {
      // The array claim itself is requested; the item attribute only documents
      // the item constraint and would duplicate the claim path otherwise.
      continue
    }
    if (!attribute.claimPathSupported) {
      mappingUnsupported.push(
        unsupported(
          'claim_path_not_expressible',
          'claim',
          'The attribute pointer cannot be expressed as a DCQL claim path.',
          { path: attribute.pointer },
        ),
      )
      continue
    }
    const key = JSON.stringify(attribute.claimPath)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    claims.push({ path: attribute.claimPath })
  }
  return claims
}

/**
 * Builds the partial DCQL query fragment of one credential format. `index`
 * makes the generated query id deterministic across identical requests.
 */
export function buildDcqlMapping(options: {
  readonly format: string
  readonly index: number
  readonly attributes: readonly VerifierAttributeConstraint[]
  readonly objectLimitations: readonly InspectedObjectLimitation[]
}): VerifierDcqlMapping {
  const mappingUnsupported: VerifierUnsupportedMapping[] = []
  const notes: readonly string[] = [
    'The credential query is a mapping fragment, not a complete OpenID4VP authorization request, and cannot be sent to a wallet as one.',
    'DCQL selects a credential format, credential type and claim paths; it cannot express JSON Schema value constraints.',
    'No nonce, client_id, response_uri, response_mode, presentation submission or holder proof is produced or verified here.',
  ]

  if (!DCQL_FORMATS.has(options.format)) {
    return {
      interfaceId: 'openid4vp.dcql@1',
      complete: false,
      credentialQuery: null,
      mapped: [],
      unsupported: [
        ...mappingUnsupported,
        unsupported(
          'format_not_expressible',
          'format',
          `The "${options.format}" format is not a credential format this slice maps to a DCQL query.`,
        ),
      ],
      notes,
    }
  }

  const claims = claimQueries(options.attributes, mappingUnsupported)
  const credentialQuery: Record<string, unknown> = {
    id: `credential-${options.index + 1}`,
    format: options.format,
    ...(claims.length === 0 ? {} : { claims }),
  }

  const constraintKeywords = new Set<string>()
  const unresolvedKeywords = new Set<string>()
  for (const attribute of options.attributes) {
    for (const keyword of Object.keys(attribute.constraints)) {
      if (VALUE_CONSTRAINT_KEYWORDS.has(keyword)) {
        constraintKeywords.add(keyword)
      }
    }
    for (const entry of attribute.unsupportedConstraints) {
      unresolvedKeywords.add(entry.keyword)
    }
  }
  for (const keyword of [...constraintKeywords].sort()) {
    mappingUnsupported.push(
      unsupported(
        'value_constraint_not_expressible',
        'constraint',
        `DCQL claim paths do not express the JSON Schema "${keyword}" constraint; the verifier must enforce it itself.`,
        { keyword },
      ),
    )
  }
  for (const keyword of [...unresolvedKeywords].sort()) {
    mappingUnsupported.push(
      unsupported(
        'constraint_not_resolved',
        'constraint',
        `The "${keyword}" keyword was not resolved into a typed constraint and cannot be mapped.`,
        { keyword },
      ),
    )
  }
  if (options.attributes.some((attribute) => attribute.required)) {
    mappingUnsupported.push(
      unsupported(
        'required_not_expressible',
        'constraint',
        'DCQL claim paths do not encode the rulebook required-claim rule; the verifier must enforce it itself.',
      ),
    )
  }

  mappingUnsupported.push(
    unsupported(
      'type_identifier_unavailable',
      'type_identifier',
      options.format === 'dc+sd-jwt'
        ? 'The pinned rulebook snapshot stores schema-reference URIs and integrity values, not a vct, so "meta.vct_values" is not produced without fabricating a credential type.'
        : 'The pinned rulebook snapshot stores schema-reference URIs and integrity values, not a doctype, so "meta.doctype_value" is not produced without fabricating a credential type.',
    ),
  )
  mappingUnsupported.push(
    unsupported(
      'trusted_authorities_unavailable',
      'trust',
      'The pinned rulebook snapshot carries no trusted authorities, so no DCQL "trusted_authorities" member is produced and no trust result is claimed.',
    ),
  )

  for (const limitation of options.objectLimitations) {
    mappingUnsupported.push(
      unsupported('object_constraint_not_expressible', 'constraint', limitation.reason, {
        path: limitation.pointer,
        keyword: limitation.keyword,
      }),
    )
  }

  mappingUnsupported.push(
    unsupported(
      'proof_and_protocol_not_built',
      'protocol',
      'Holder proof, signature algorithms, client metadata and OpenID4VP protocol parameters are out of scope for this slice; no proof or protocol-conformance result is produced.',
    ),
  )

  return {
    interfaceId: 'openid4vp.dcql@1',
    complete: false,
    credentialQuery,
    mapped: ['credential format', ...(claims.length === 0 ? [] : ['claim paths'])],
    unsupported: dedupeMappings(mappingUnsupported),
    notes,
  }
}

function dedupeMappings(
  mappings: readonly VerifierUnsupportedMapping[],
): VerifierUnsupportedMapping[] {
  const seen = new Set<string>()
  return mappings.filter((mapping) => {
    const key = `${mapping.code}\u0000${mapping.path ?? ''}\u0000${mapping.keyword ?? ''}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

/** The verifier-policy interfaces AttestBook knows about, with explicit gaps. */
export function buildPolicyInterfaces(): readonly VerifierPolicyInterface[] {
  return [
    {
      id: 'attestbook.attribute-constraints@1',
      status: 'supported',
      description:
        'Typed attribute constraints extracted from the pinned rulebook JSON Schema references.',
      supportedFeatures: [
        'attribute JSON Pointers and names',
        'required flag',
        'declared JSON types',
        'extracted JSON Schema value constraints',
        'per-reference provenance',
      ],
      unsupported: [],
    },
    {
      id: 'openid4vp.dcql@1',
      status: 'partial',
      description:
        'Partial DCQL credential-query mapping: format and claim paths only, with every unexpressible constraint reported.',
      supportedFeatures: ['credential format', 'claim paths'],
      unsupported: [
        unsupported(
          'type_identifier_unavailable',
          'type_identifier',
          'The pinned rulebook snapshot does not carry the vct/doctype value DCQL meta requires; it is reported rather than fabricated.',
        ),
        unsupported(
          'value_constraint_not_expressible',
          'constraint',
          'DCQL claim paths cannot express JSON Schema value constraints, the required-claim rule or object-level structural rules.',
        ),
        unsupported(
          'trusted_authorities_unavailable',
          'trust',
          'No trusted-authority mapping is produced from a snapshot that carries none, and no trust result is claimed.',
        ),
        unsupported(
          'proof_and_protocol_not_built',
          'protocol',
          'No OpenID4VP request proof, holder binding or protocol-conformance result is produced.',
        ),
      ],
    },
    {
      id: 'openid4vp.presentation-exchange@1',
      status: 'unsupported',
      description: 'Presentation Exchange presentation definitions are not mapped in this slice.',
      supportedFeatures: [],
      unsupported: [
        unsupported(
          'interface_not_implemented',
          'interface',
          'No Presentation Exchange mapping is implemented; AttestBook does not guess presentation-definition input descriptors or constraint mappings.',
        ),
      ],
    },
  ] satisfies readonly VerifierPolicyInterface[]
}
