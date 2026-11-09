// Bounded, non-executing JSON Schema inspection for verifier constraints
// (FR-014, issue #45).
//
// AttestBook never fetches a rulebook schema and never executes a caller
// document here: the caller supplies the exact bytes, the resolver verifies the
// pinned sha256 SRI value, and this module walks the parsed document under hard
// depth, node, attribute and word bounds. It extracts the effective attribute
// constraints a verifier can inspect and reports every construct it does not
// resolve. It does not validate a credential, evaluate a keyword, follow a
// reference or compile a schema.
//
// The extracted values are reported as data. Keywords such as `pattern` or
// `format` are reported verbatim and never executed by this slice.

import { isDeepStrictEqual } from 'node:util'

import { invalidInput } from '../registry/errors'

import type {
  VerifierAttributeConstraint,
  VerifierPolicyDiagnostic,
  VerifierUnsupportedConstraint,
} from './types'

/** Maximum nesting depth of one caller-supplied JSON Schema document. */
export const MAX_INSPECTED_DOCUMENT_DEPTH = 64

/** Maximum JSON nodes in one caller-supplied JSON Schema document. */
export const MAX_INSPECTED_DOCUMENT_NODES = 4_096

/** Maximum number of typed attributes returned for one format. */
export const MAX_VERIFIER_ATTRIBUTES = 256

/** Maximum nesting depth of inspected object properties. */
const MAX_ATTRIBUTE_DEPTH = 16

/** JSON types a schema `type` keyword may name. */
const JSON_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'string', 'integer'])

/**
 * Keywords whose effect on an instance this slice does not resolve. They are
 * reported on the attribute or object that declares them and never guessed.
 */
const UNRESOLVED_KEYWORDS: Readonly<Record<string, string>> = {
  $ref: 'References are not resolved because AttestBook does not fetch referenced schemas.',
  $dynamicRef: 'Dynamic references are not resolved in this slice.',
  $recursiveRef: 'Recursive references are not resolved in this slice.',
  $dynamicAnchor: 'Dynamic anchors are not resolved in this slice.',
  oneOf: 'Alternative schemas are not merged into one effective constraint set.',
  anyOf: 'Alternative schemas are not merged into one effective constraint set.',
  not: 'Negated schemas are not resolved into effective constraints.',
  if: 'Conditional schemas are not resolved into one effective constraint set.',
  then: 'Conditional schemas are not resolved into one effective constraint set.',
  else: 'Conditional schemas are not resolved into one effective constraint set.',
  dependentRequired: 'Dependent requirements are not resolved into effective constraints.',
  dependentSchemas: 'Dependent schemas are not resolved into effective constraints.',
  dependencies: 'Legacy dependencies are not resolved into effective constraints.',
  patternProperties: 'Pattern properties are not inspected as typed attributes.',
  propertyNames: 'Property-name constraints are not inspected as typed attributes.',
  prefixItems: 'Tuple item schemas are not inspected as typed attributes.',
  additionalItems: 'Legacy tuple items are not inspected as typed attributes.',
  contains: 'Array containment constraints are not inspected as typed attributes.',
  minContains: 'Array containment constraints are not inspected as typed attributes.',
  maxContains: 'Array containment constraints are not inspected as typed attributes.',
  unevaluatedItems: 'Unevaluated item schemas are not resolved in this slice.',
  unevaluatedProperties: 'Unevaluated property schemas are not resolved in this slice.',
  contentSchema: 'Content schemas are not inspected as typed attributes.',
}

/**
 * Keyword values extracted into a typed constraint. `pattern` and `format` are
 * reported as data and are never executed by this slice.
 */
const EXTRACTED_KEYWORDS = new Set([
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

/**
 * Root members that only make sense on a JSON Schema. A document that has both
 * `vct` and one of these is classified as JSON Schema rather than Type
 * Metadata, so its constraints are not silently skipped.
 */
const JSON_SCHEMA_ROOT_KEYWORDS = [
  '$anchor',
  '$defs',
  '$dynamicAnchor',
  '$dynamicRef',
  '$id',
  '$recursiveRef',
  '$ref',
  '$schema',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'definitions',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'else',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'if',
  'items',
  'maxContains',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minContains',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'not',
  'oneOf',
  'pattern',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'required',
  'then',
  'type',
  'unevaluatedItems',
  'unevaluatedProperties',
  'uniqueItems',
] as const

/** Object-level constructs that cannot be expressed as one typed attribute. */
export interface InspectedObjectLimitation {
  readonly pointer: string
  readonly keyword: string
  readonly reason: string
}

export interface SchemaInspection {
  readonly attributes: readonly VerifierAttributeConstraint[]
  readonly objectLimitations: readonly InspectedObjectLimitation[]
  readonly diagnostics: readonly VerifierPolicyDiagnostic[]
}

type JsonObject = Record<string, unknown>

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Classifies one supplied document. A JSON Schema document is inspected for
 * attribute constraints; SD-JWT VC Type Metadata declares claims and display
 * metadata but no value constraints, so it is reported unsupported instead of
 * being converted into guessed constraints.
 */
export function classifySchemaDocument(
  document: unknown,
): 'json_schema' | 'type_metadata' | 'unsupported' {
  if (!isRecord(document)) {
    return 'unsupported'
  }
  if (JSON_SCHEMA_ROOT_KEYWORDS.some((keyword) => keyword in document)) {
    return 'json_schema'
  }
  if (typeof document['vct'] === 'string') {
    return 'type_metadata'
  }
  // An empty object is a valid JSON Schema: every instance is accepted.
  return 'json_schema'
}

/**
 * Rejects a caller-supplied document that is deeper or larger than the
 * inspection bounds. This runs before any structural walk.
 */
export function assertBoundedDocument(document: unknown, field: string): void {
  const stack: { readonly value: unknown; readonly depth: number }[] = [
    { value: document, depth: 0 },
  ]
  let nodes = 0
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) {
      break
    }
    nodes += 1
    if (nodes > MAX_INSPECTED_DOCUMENT_NODES) {
      throw invalidInput(`${field} exceeds the JSON node bound for a schema document`)
    }
    if (current.depth > MAX_INSPECTED_DOCUMENT_DEPTH) {
      throw invalidInput(`${field} exceeds the JSON nesting bound for a schema document`)
    }
    if (Array.isArray(current.value)) {
      for (const entry of current.value) {
        stack.push({ value: entry, depth: current.depth + 1 })
      }
    } else if (isRecord(current.value)) {
      for (const entry of Object.values(current.value)) {
        stack.push({ value: entry, depth: current.depth + 1 })
      }
    }
  }
}

interface InspectionState {
  readonly source: string
  readonly attributes: VerifierAttributeConstraint[]
  readonly objectLimitations: InspectedObjectLimitation[]
  readonly diagnostics: VerifierPolicyDiagnostic[]
  nodes: number
}

interface ObjectShape {
  readonly properties: Map<string, unknown[]>
  readonly required: Set<string>
  additionalProperties: unknown
  /** Branch schemas that declare object members, for object-limitation reporting. */
  readonly branches: JsonObject[]
}

interface ConstraintSet {
  readonly values: Record<string, unknown>
  readonly unresolved: Map<string, string>
}

function pointerFromSegments(segments: readonly string[]): string {
  return `/${segments
    .map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1'))
    .join('/')}`
}

function claimPathFromSegments(segments: readonly string[]): readonly (string | number | null)[] {
  return segments.map((segment) => (segment === '*' ? null : segment))
}

function countNode(state: InspectionState): void {
  state.nodes += 1
  if (state.nodes > MAX_INSPECTED_DOCUMENT_NODES) {
    throw invalidInput(`${state.source} exceeds the schema inspection node bound`)
  }
}

function addDiagnostic(state: InspectionState, code: string, message: string, path?: string): void {
  state.diagnostics.push(path === undefined ? { code, message } : { code, message, path })
}

/**
 * Flattens a schema and its `allOf` branches. Only `allOf` composes constraints
 * in this slice; other combinators are reported as unresolved.
 */
function flattenAllOf(
  schema: unknown,
  state: InspectionState,
  depth: number,
  output: JsonObject[],
): void {
  countNode(state)
  if (depth > MAX_ATTRIBUTE_DEPTH) {
    throw invalidInput(`${state.source} exceeds the schema attribute depth bound`)
  }
  if (!isRecord(schema)) {
    return
  }
  output.push(schema)
  const branches = schema['allOf']
  if (Array.isArray(branches)) {
    for (const branch of branches) {
      flattenAllOf(branch, state, depth + 1, output)
    }
  }
}

function mergeExtractedValue(
  values: Record<string, unknown>,
  unresolved: Map<string, string>,
  keyword: string,
  value: unknown,
): void {
  const existing = values[keyword]
  if (existing === undefined && !(keyword in values)) {
    values[keyword] = value
    return
  }
  const merged = mergeValue(keyword, existing, value)
  if (merged === CONFLICT) {
    unresolved.set(
      keyword,
      `The "allOf" branches constrain "${keyword}" incompatibly; only the first value is reported.`,
    )
    return
  }
  values[keyword] = merged
}

const CONFLICT = Symbol('conflict')

function intersectArrays(left: readonly unknown[], right: readonly unknown[]): unknown[] {
  return left.filter((entry) => right.some((other) => isDeepStrictEqual(entry, other)))
}

function mergeValue(keyword: string, left: unknown, right: unknown): unknown {
  if (isDeepStrictEqual(left, right)) {
    return left
  }
  switch (keyword) {
    case 'type': {
      const leftTypes = typeof left === 'string' ? [left] : Array.isArray(left) ? left : []
      const rightTypes = typeof right === 'string' ? [right] : Array.isArray(right) ? right : []
      const intersection = intersectArrays(leftTypes, rightTypes)
      return intersection.length === 0 ? CONFLICT : intersection
    }
    case 'enum': {
      if (!Array.isArray(left) || !Array.isArray(right)) {
        return CONFLICT
      }
      const intersection = intersectArrays(left, right)
      return intersection.length === 0 ? CONFLICT : intersection
    }
    case 'minimum':
    case 'exclusiveMinimum':
    case 'minLength':
    case 'minItems':
    case 'minProperties':
      if (typeof left === 'number' && typeof right === 'number') {
        return Math.max(left, right)
      }
      return CONFLICT
    case 'maximum':
    case 'exclusiveMaximum':
    case 'maxLength':
    case 'maxItems':
    case 'maxProperties':
      if (typeof left === 'number' && typeof right === 'number') {
        return Math.min(left, right)
      }
      return CONFLICT
    default:
      return CONFLICT
  }
}

function collectConstraintBranches(schema: unknown, state: InspectionState): JsonObject[] {
  const branches: JsonObject[] = []
  flattenAllOf(schema, state, 0, branches)
  return branches
}

function constraintSetFor(schema: unknown, state: InspectionState): ConstraintSet {
  return mergeConstraintSchemas([schema], state)
}

function mergeConstraintSchemas(
  schemas: readonly unknown[],
  state: InspectionState,
): ConstraintSet {
  const values: Record<string, unknown> = {}
  const unresolved = new Map<string, string>()
  for (const schema of schemas) {
    for (const branch of collectConstraintBranches(schema, state)) {
      for (const [keyword, value] of Object.entries(branch)) {
        if (EXTRACTED_KEYWORDS.has(keyword)) {
          mergeExtractedValue(values, unresolved, keyword, value)
        } else if (keyword in UNRESOLVED_KEYWORDS) {
          unresolved.set(keyword, UNRESOLVED_KEYWORDS[keyword] ?? 'This keyword is not resolved.')
        }
      }
      if (Array.isArray(branch['items'])) {
        unresolved.set('items', 'Legacy tuple item schemas are not inspected as typed attributes.')
      }
    }
  }
  return { values, unresolved }
}

function typesFromConstraints(
  values: Record<string, unknown>,
  unresolved: Map<string, string>,
): string[] {
  const raw = values['type']
  const candidates = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []
  const types: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && JSON_TYPES.has(candidate)) {
      types.push(candidate)
      continue
    }
    unresolved.set('type', 'The "type" keyword names an unknown JSON type.')
  }
  return types.sort()
}

function toUnsupportedConstraints(
  unresolved: Map<string, string>,
): VerifierUnsupportedConstraint[] {
  return [...unresolved.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([keyword, reason]) => ({ keyword, reason }))
}

function collectObjectShape(schema: unknown, state: InspectionState, depth: number): ObjectShape {
  const shape: ObjectShape = {
    properties: new Map(),
    required: new Set(),
    additionalProperties: undefined,
    branches: [],
  }
  const branches: JsonObject[] = []
  flattenAllOf(schema, state, depth, branches)
  for (const branch of branches) {
    shape.branches.push(branch)
    const properties = branch['properties']
    if (isRecord(properties)) {
      for (const [name, propertySchema] of Object.entries(properties)) {
        const list = shape.properties.get(name) ?? []
        list.push(propertySchema)
        shape.properties.set(name, list)
      }
    } else if (properties !== undefined) {
      addDiagnostic(
        state,
        'invalid_schema_properties',
        'The "properties" keyword is not an object and was not inspected.',
        pointerFromSegments([]),
      )
    }
    const required = branch['required']
    if (Array.isArray(required)) {
      for (const name of required) {
        if (typeof name === 'string') {
          shape.required.add(name)
        }
      }
    } else if (required !== undefined) {
      addDiagnostic(
        state,
        'invalid_schema_required',
        'The "required" keyword is not an array and was not inspected.',
        pointerFromSegments([]),
      )
    }
    if (branch['additionalProperties'] !== undefined) {
      shape.additionalProperties = branch['additionalProperties']
    }
  }
  return shape
}

function collectObjectLimitations(
  shape: ObjectShape,
  state: InspectionState,
  baseSegments: readonly string[],
): void {
  const pointer = baseSegments.length === 0 ? '/' : pointerFromSegments(baseSegments)
  for (const branch of shape.branches) {
    for (const keyword of Object.keys(UNRESOLVED_KEYWORDS)) {
      if (!(keyword in branch)) {
        continue
      }
      state.objectLimitations.push({
        pointer,
        keyword,
        reason: UNRESOLVED_KEYWORDS[keyword] ?? 'This object constraint is not resolved.',
      })
    }
  }
}

function collectAdditionalPropertiesLimitation(
  shape: ObjectShape,
  state: InspectionState,
  baseSegments: readonly string[],
): void {
  const pointer = baseSegments.length === 0 ? '/' : pointerFromSegments(baseSegments)
  if (shape.additionalProperties === false) {
    state.objectLimitations.push({
      pointer,
      keyword: 'additionalProperties',
      reason:
        'The object forbids undeclared properties; DCQL claim paths cannot express this structural constraint.',
    })
  } else if (isRecord(shape.additionalProperties)) {
    state.objectLimitations.push({
      pointer,
      keyword: 'additionalProperties',
      reason:
        'Constraints on undeclared properties are not inspected as typed attributes in this slice.',
    })
  }
}

function inspectObject(
  schema: unknown,
  state: InspectionState,
  baseSegments: readonly string[],
  depth: number,
): void {
  countNode(state)
  if (depth > MAX_ATTRIBUTE_DEPTH) {
    throw invalidInput(`${state.source} exceeds the schema attribute depth bound`)
  }
  const shape = collectObjectShape(schema, state, depth)
  collectObjectLimitations(shape, state, baseSegments)
  collectAdditionalPropertiesLimitation(shape, state, baseSegments)

  const names = new Set<string>([...shape.properties.keys(), ...shape.required])
  for (const name of [...names].sort()) {
    const propertySchemas = shape.properties.get(name) ?? []
    const constraints = mergePropertyConstraints(propertySchemas, state)
    const types = typesFromConstraints(constraints.values, constraints.unresolved)
    const segments = [...baseSegments, name]
    const pointer = pointerFromSegments(segments)

    if (state.attributes.length >= MAX_VERIFIER_ATTRIBUTES) {
      throw invalidInput(`${state.source} exceeds the typed attribute bound`)
    }
    state.attributes.push({
      pointer,
      name,
      required: shape.required.has(name),
      types,
      constraints: constraints.values,
      unsupportedConstraints: toUnsupportedConstraints(constraints.unresolved),
      sources: [state.source],
      claimPath: claimPathFromSegments(segments),
      claimPathSupported: true,
    })

    // Nested object claims are recurse into so their properties are typed too.
    for (const propertySchema of propertySchemas) {
      inspectNestedObject(propertySchema, state, segments, depth + 1)
      inspectArrayItems(propertySchema, state, segments, depth + 1)
    }
  }
}

function mergePropertyConstraints(
  schemas: readonly unknown[],
  state: InspectionState,
): ConstraintSet {
  return mergeConstraintSchemas(schemas, state)
}

function inspectNestedObject(
  schema: unknown,
  state: InspectionState,
  segments: readonly string[],
  depth: number,
): void {
  if (!isRecord(schema)) {
    return
  }
  // Inspecting the original schema once lets the object-shape collector merge
  // properties and `required` from every `allOf` branch.
  for (const branch of collectConstraintBranches(schema, state)) {
    if (isRecord(branch['properties'])) {
      inspectObject(schema, state, segments, depth)
      return
    }
  }
}

function inspectArrayItems(
  schema: unknown,
  state: InspectionState,
  segments: readonly string[],
  depth: number,
): void {
  if (!isRecord(schema)) {
    return
  }
  for (const branch of collectConstraintBranches(schema, state)) {
    const items = branch['items']
    if (items === undefined || typeof items === 'boolean' || Array.isArray(items)) {
      continue
    }
    if (!isRecord(items)) {
      continue
    }
    const itemSegments = [...segments, '*']
    for (const itemBranch of collectConstraintBranches(items, state)) {
      if (isRecord(itemBranch['properties'])) {
        inspectObject(items, state, itemSegments, depth)
        return
      }
    }
    const constraints = constraintSetFor(items, state)
    if (Object.keys(constraints.values).length === 0 && constraints.unresolved.size === 0) {
      continue
    }
    if (state.attributes.length >= MAX_VERIFIER_ATTRIBUTES) {
      throw invalidInput(`${state.source} exceeds the typed attribute bound`)
    }
    state.attributes.push({
      pointer: pointerFromSegments(itemSegments),
      name: '*',
      required: false,
      types: typesFromConstraints(constraints.values, constraints.unresolved),
      constraints: constraints.values,
      unsupportedConstraints: toUnsupportedConstraints(constraints.unresolved),
      sources: [state.source],
      claimPath: claimPathFromSegments(itemSegments),
      claimPathSupported: true,
    })
  }
}

/**
 * Inspects one JSON Schema 2020-12 document and returns its typed attributes.
 * The document must already be bounded by `assertBoundedDocument`.
 */
export function inspectJsonSchema(document: unknown, source: string): SchemaInspection {
  if (!isRecord(document)) {
    throw invalidInput('A supplied schema document must be a JSON Schema object')
  }
  const state: InspectionState = {
    source,
    attributes: [],
    objectLimitations: [],
    diagnostics: [],
    nodes: 0,
  }
  inspectObject(document, state, [], 0)
  state.attributes.sort((left, right) => {
    const pointer = left.pointer.localeCompare(right.pointer)
    return pointer !== 0 ? pointer : left.sources.join().localeCompare(right.sources.join())
  })
  const seenLimitations = new Set<string>()
  const objectLimitations = state.objectLimitations.filter((limitation) => {
    const key = `${limitation.pointer}\u0000${limitation.keyword}`
    if (seenLimitations.has(key)) {
      return false
    }
    seenLimitations.add(key)
    return true
  })
  return {
    attributes: state.attributes,
    objectLimitations,
    diagnostics: state.diagnostics,
  }
}
