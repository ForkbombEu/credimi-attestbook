// Pure, sandboxed synthesis core for rulebook-driven issuer fixtures (FR-013).
//
// This module never reads a registry, a clock or a network. The parent prepares
// the pinned rulebook references, verifies each document's sha256 SRI value and
// sends only verified JSON Schema documents here; the sandbox child compiles
// and evaluates them under the shared timeout, RSS, output and concurrency
// bounds. A schema constraint the synthesizer cannot satisfy deterministically
// is reported, never guessed.
//
// Fixtures are unsigned claim payloads. They are not SD-JWT VCs, are not
// signed, and are not issued credentials.

import { isDeepStrictEqual } from 'node:util'

import Ajv2020 from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'

import { toJsonPointer, type PendingSchemaDocument } from '../validation/schema'
import type { SnapshotSchemaReference } from '../validation/types'

import {
  FIXTURE_SANDBOX_REASONS,
  type FixtureSandboxDocumentResult,
  type FixtureSandboxRequest,
  type FixtureSandboxResult,
} from './sandbox'
import type {
  IssuerFixtureAttribute,
  IssuerFixtureFinding,
  IssuerFixtureNegativeCase,
  IssuerFixtureNegativeCategory,
  IssuerFixtureOverride,
  IssuerFixturePayloadValidation,
} from './types'

/** JSON Schema dialects the shared validator supports; anything else is not applied. */
const SUPPORTED_SCHEMA_DIALECTS = new Set([
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/schema#',
])

/**
 * Keywords the synthesizer cannot turn into a deterministic value. Validation
 * may still evaluate several of them, but generating a fixture would mean
 * guessing, so they are reported instead. `$ref`, `pattern`, `format`,
 * `patternProperties` and `uniqueItems` already fail the shared preparation
 * step before this list is consulted.
 */
const SYNTHESIS_UNSUPPORTED_KEYWORDS = [
  '$dynamicRef',
  '$recursiveRef',
  '$ref',
  'additionalItems',
  'anyOf',
  'contains',
  'contentSchema',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'else',
  'format',
  'if',
  'maxContains',
  'maxProperties',
  'minContains',
  'minProperties',
  'not',
  'oneOf',
  'pattern',
  'patternProperties',
  'prefixItems',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
  'uniqueItems',
] as const

/** Maximum nesting depth of a synthesized payload. */
const MAX_SYNTHESIS_DEPTH = 12
/** Maximum number of object properties in one payload. */
const MAX_SYNTHESIS_PROPERTIES = 128
/** Maximum number of generated array items per array. */
const MAX_SYNTHESIS_ARRAY_ITEMS = 8
/** Default and maximum length of a synthesized string. */
const SYNTHESIS_STRING = 'fixture'
const MAX_SYNTHESIS_STRING_LENGTH = 256
/** Overall node budget for one payload. */
const MAX_SYNTHESIS_NODES = 4_096
/** Structural node bound before a caller-supplied schema is compiled in-process. */
const MAX_SCHEMA_NODES = 4_096
/** Maximum number of negative cases returned in one response. */
const MAX_NEGATIVE_CASES = 32
/** Hard cap when a negative string case has to be longer than the payload value. */
const MAX_NEGATIVE_STRING_LENGTH = 512
/** Name of the extra property used for an `additionalProperties: false` case. */
const EXTRA_PROPERTY_NAME = '__fixture_extra_claim__'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A schema node together with the reference URI that declared it. */
interface SourcedSchema {
  readonly schema: Record<string, unknown>
  readonly source: string
}

type SynthesisKind = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

/** A deterministic failure that can be reported as invalid input. */
export class SynthesisError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'SynthesisError'
    this.reason = reason
  }
}

interface SynthesisBudget {
  nodes: number
  properties: number
}

interface SynthProperty {
  readonly name: string
  readonly required: boolean
  readonly node: SynthEntity
}

interface SynthEntity {
  readonly kind: SynthesisKind
  readonly value: unknown
  readonly types: readonly string[]
  readonly constraints: Readonly<Record<string, unknown>>
  readonly sources: readonly string[]
  /** Concrete instance location, used to mutate the payload for negative cases. */
  readonly instanceSegments: readonly (string | number)[]
  readonly properties: readonly SynthProperty[]
  readonly items: SynthEntity | null
}

interface CompiledJsonSchema {
  readonly pending: PendingSchemaDocument
  readonly reference: SnapshotSchemaReference
  readonly validate: ValidateFunction
}

function jsonTypeOf(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  return typeof value
}

function matchesType(value: unknown, type: string): boolean {
  const actual = jsonTypeOf(value)
  if (type === 'integer') {
    return actual === 'number' && Number.isInteger(value)
  }
  if (type === 'number') {
    return actual === 'number'
  }
  return type === actual
}

function matchesAnyType(value: unknown, types: readonly string[]): boolean {
  if (types.length === 0) {
    return true
  }
  return types.some((candidate) => matchesType(value, candidate))
}

function typeSetOf(schema: Record<string, unknown>, path: string): string[] | null {
  const type = schema.type
  if (type === undefined) {
    return null
  }
  if (typeof type === 'string') {
    return [type]
  }
  if (Array.isArray(type) && type.every((entry): entry is string => typeof entry === 'string')) {
    return type
  }
  throw new SynthesisError(`invalid_type_keyword:${path}`)
}

/** Intersects two JSON Schema type sets, treating integer as a subtype of number. */
function intersectTypeSets(left: readonly string[], right: readonly string[]): string[] {
  const result = new Set<string>()
  for (const a of left) {
    for (const b of right) {
      if (a === b) {
        result.add(a)
      } else if ((a === 'number' && b === 'integer') || (a === 'integer' && b === 'number')) {
        result.add('integer')
      }
    }
  }
  return [...result]
}

function inferTypes(schemas: readonly SourcedSchema[]): string[] {
  for (const { schema } of schemas) {
    if ('const' in schema) {
      return [jsonKindOf(schema.const)]
    }
  }
  const enumKinds = new Set<string>()
  for (const { schema } of schemas) {
    const values = schema.enum
    if (Array.isArray(values)) {
      for (const value of values) {
        enumKinds.add(jsonKindOf(value))
      }
    }
  }
  if (enumKinds.size > 0) {
    return [...enumKinds]
  }
  const keywords = (names: readonly string[]): boolean =>
    schemas.some(({ schema }) => names.some((name) => name in schema))
  if (
    keywords([
      'additionalProperties',
      'dependentRequired',
      'maxProperties',
      'minProperties',
      'properties',
      'required',
    ])
  ) {
    return ['object']
  }
  if (keywords(['contains', 'items', 'maxItems', 'minItems', 'prefixItems'])) {
    return ['array']
  }
  if (keywords(['maxLength', 'minLength', 'pattern'])) {
    return ['string']
  }
  if (keywords(['exclusiveMaximum', 'exclusiveMinimum', 'maximum', 'minimum', 'multipleOf'])) {
    return ['number']
  }
  return ['null']
}

function effectiveTypes(schemas: readonly SourcedSchema[]): string[] {
  let intersection: string[] | null = null
  for (const { schema } of schemas) {
    const declared = typeSetOf(schema, '/')
    if (declared === null) {
      continue
    }
    intersection = intersection === null ? declared : intersectTypeSets(intersection, declared)
  }
  if (intersection === null) {
    return inferTypes(schemas)
  }
  if (intersection.length === 0) {
    throw new SynthesisError('incompatible_types')
  }
  return intersection
}

function chooseKind(types: readonly string[]): SynthesisKind {
  const priority: readonly SynthesisKind[] = [
    'object',
    'array',
    'string',
    'integer',
    'number',
    'boolean',
    'null',
  ]
  for (const candidate of priority) {
    if (types.includes(candidate)) {
      return candidate
    }
  }
  throw new SynthesisError('incompatible_types')
}

function flattenAllOf(sources: readonly SourcedSchema[], depth: number): SourcedSchema[] {
  if (depth > MAX_SYNTHESIS_DEPTH) {
    throw new SynthesisError('payload_too_deep')
  }
  const flattened: SourcedSchema[] = []
  for (const sourced of sources) {
    for (const keyword of SYNTHESIS_UNSUPPORTED_KEYWORDS) {
      if (keyword in sourced.schema) {
        throw new SynthesisError(`unsupported_keyword:${keyword}`)
      }
    }
    const allOf = sourced.schema.allOf
    if (allOf !== undefined) {
      if (!Array.isArray(allOf)) {
        throw new SynthesisError('invalid_allOf_keyword')
      }
      const branches: SourcedSchema[] = []
      for (const branch of allOf) {
        if (branch === true) {
          continue
        }
        if (branch === false || !isRecord(branch)) {
          throw new SynthesisError('unsupported_boolean_schema')
        }
        branches.push({ schema: branch, source: sourced.source })
      }
      flattened.push(...flattenAllOf(branches, depth + 1))
    }
    flattened.push(sourced)
  }
  return flattened
}

function collectConst(schemas: readonly SourcedSchema[]): { present: boolean; value: unknown } {
  let present = false
  let value: unknown
  for (const { schema } of schemas) {
    if (!('const' in schema)) {
      continue
    }
    if (!present) {
      present = true
      value = schema.const
    } else if (!isDeepStrictEqual(value, schema.const)) {
      throw new SynthesisError('conflicting_const')
    }
  }
  return { present, value }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Intersects every declared enumeration in O(total entries), keeping the first
 * document's order. Canonical keys make object member order irrelevant.
 */
function collectEnums(schemas: readonly SourcedSchema[]): unknown[] | null {
  const lists: unknown[][] = []
  for (const { schema } of schemas) {
    const entries = schema.enum
    if (entries === undefined) {
      continue
    }
    if (!Array.isArray(entries)) {
      throw new SynthesisError('invalid_enum_keyword')
    }
    if (entries.length === 0) {
      throw new SynthesisError('incompatible_enum')
    }
    lists.push(entries)
  }
  if (lists.length === 0) {
    return null
  }
  const sets = lists.map((list) => new Set(list.map((entry) => canonicalJson(entry))))
  const first = lists[0] ?? []
  const common = first.filter((candidate) => sets.every((set) => set.has(canonicalJson(candidate))))
  if (common.length === 0) {
    throw new SynthesisError('incompatible_enum')
  }
  return common
}

function chooseEnumValue(values: readonly unknown[], types: readonly string[]): unknown {
  const chosen = values.find((value) => matchesAnyType(value, types))
  if (chosen === undefined) {
    throw new SynthesisError('incompatible_enum')
  }
  return chosen
}

function readNumberKeyword(
  schemas: readonly SourcedSchema[],
  keyword: string,
  path: string,
): number[] {
  const values: number[] = []
  for (const { schema } of schemas) {
    const value = schema[keyword]
    if (value === undefined) {
      continue
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SynthesisError(`invalid_${keyword}_keyword:${path}`)
    }
    values.push(value)
  }
  return values
}

function effectiveBounds(schemas: readonly SourcedSchema[]): {
  readonly lower: number
  readonly upper: number
  readonly lowerExclusive: boolean
  readonly upperExclusive: boolean
  readonly multiples: readonly number[]
} {
  let lower = Number.NEGATIVE_INFINITY
  let upper = Number.POSITIVE_INFINITY
  let lowerExclusive = false
  let upperExclusive = false

  for (const minimum of readNumberKeyword(schemas, 'minimum', '/')) {
    if (minimum > lower) {
      lower = minimum
      lowerExclusive = false
    } else if (minimum === lower) {
      lowerExclusive = false
    }
  }
  for (const exclusiveMinimum of readNumberKeyword(schemas, 'exclusiveMinimum', '/')) {
    if (exclusiveMinimum > lower) {
      lower = exclusiveMinimum
      lowerExclusive = true
    } else if (exclusiveMinimum === lower) {
      lowerExclusive = true
    }
  }
  for (const maximum of readNumberKeyword(schemas, 'maximum', '/')) {
    if (maximum < upper) {
      upper = maximum
      upperExclusive = false
    } else if (maximum === upper) {
      upperExclusive = false
    }
  }
  for (const exclusiveMaximum of readNumberKeyword(schemas, 'exclusiveMaximum', '/')) {
    if (exclusiveMaximum < upper) {
      upper = exclusiveMaximum
      upperExclusive = true
    } else if (exclusiveMaximum === upper) {
      upperExclusive = true
    }
  }
  const multiples = readNumberKeyword(schemas, 'multipleOf', '/')
  for (const multiple of multiples) {
    if (multiple <= 0) {
      throw new SynthesisError('invalid_multipleOf_keyword')
    }
  }
  return { lower, upper, lowerExclusive, upperExclusive, multiples }
}

function isMultipleOf(value: number, multiple: number): boolean {
  const quotient = value / multiple
  return Math.abs(quotient - Math.round(quotient)) < 1e-9
}

function roundUpToMultiples(value: number, multiples: readonly number[], integer: boolean): number {
  let candidate = value
  for (let pass = 0; pass < 8; pass += 1) {
    let adjusted = candidate
    for (const multiple of multiples) {
      const steps = Math.ceil(adjusted / multiple - 1e-12)
      adjusted = steps * multiple
    }
    if (integer) {
      adjusted = Math.ceil(adjusted)
    }
    if (adjusted === candidate) {
      return adjusted
    }
    candidate = adjusted
  }
  return candidate
}

function synthesizeNumber(kind: 'number' | 'integer', schemas: readonly SourcedSchema[]): number {
  const { lower, upper, lowerExclusive, upperExclusive, multiples } = effectiveBounds(schemas)
  const integer = kind === 'integer'
  const step = integer ? 1 : multiples.length > 0 ? Math.min(...multiples) : 1
  let start: number
  if (Number.isFinite(lower)) {
    start = lowerExclusive ? lower + step : lower
  } else if (Number.isFinite(upper)) {
    start = upperExclusive ? upper - step : upper
  } else {
    start = 0
  }
  if (integer) {
    start = Math.ceil(start)
  }

  for (let attempt = 0; attempt < 64; attempt += 1) {
    let candidate = start + (integer ? attempt : attempt * step)
    if (multiples.length > 0) {
      candidate = roundUpToMultiples(candidate, multiples, integer)
    }
    const aboveLower = candidate > lower || (!lowerExclusive && candidate === lower)
    const belowUpper = candidate < upper || (!upperExclusive && candidate === upper)
    const multiplesValid = multiples.every((multiple) => isMultipleOf(candidate, multiple))
    if (aboveLower && belowUpper && multiplesValid && Number.isFinite(candidate)) {
      return candidate
    }
    if (Number.isFinite(upper) && candidate > upper) {
      break
    }
  }
  throw new SynthesisError('unsatisfiable_numeric_constraints')
}

function synthesizeString(schemas: readonly SourcedSchema[]): string {
  let minLength = 0
  let maxLength = MAX_SYNTHESIS_STRING_LENGTH
  for (const value of readNumberKeyword(schemas, 'minLength', '/')) {
    if (!Number.isInteger(value) || value < 0) {
      throw new SynthesisError('invalid_minLength_keyword')
    }
    minLength = Math.max(minLength, value)
  }
  for (const value of readNumberKeyword(schemas, 'maxLength', '/')) {
    if (!Number.isInteger(value) || value < 0) {
      throw new SynthesisError('invalid_maxLength_keyword')
    }
    maxLength = Math.min(maxLength, value)
  }
  if (minLength > maxLength) {
    throw new SynthesisError('unsatisfiable_string_length')
  }
  if (minLength > MAX_SYNTHESIS_STRING_LENGTH) {
    throw new SynthesisError('string_too_large')
  }
  const length = Math.max(minLength, Math.min(SYNTHESIS_STRING.length, maxLength))
  return SYNTHESIS_STRING.slice(0, length).padEnd(length, 'x')
}

function summarizeConstraints(
  schemas: readonly SourcedSchema[],
  types: readonly string[],
  constant: { readonly present: boolean; readonly value: unknown },
  enumerations: readonly unknown[] | null,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {}
  if (types.length > 0) {
    summary.type = [...types]
  }

  if (constant.present) {
    summary.const = constant.value
  }
  if (enumerations !== null) {
    summary.enum = enumerations
  }

  const minLength = readNumberKeyword(schemas, 'minLength', '/')
  if (minLength.length > 0) {
    summary.minLength = Math.max(...minLength)
  }
  const maxLength = readNumberKeyword(schemas, 'maxLength', '/')
  if (maxLength.length > 0) {
    summary.maxLength = Math.min(...maxLength)
  }
  const minimum = readNumberKeyword(schemas, 'minimum', '/')
  if (minimum.length > 0) {
    summary.minimum = Math.max(...minimum)
  }
  const exclusiveMinimum = readNumberKeyword(schemas, 'exclusiveMinimum', '/')
  if (exclusiveMinimum.length > 0) {
    summary.exclusiveMinimum = Math.max(...exclusiveMinimum)
  }
  const maximum = readNumberKeyword(schemas, 'maximum', '/')
  if (maximum.length > 0) {
    summary.maximum = Math.min(...maximum)
  }
  const exclusiveMaximum = readNumberKeyword(schemas, 'exclusiveMaximum', '/')
  if (exclusiveMaximum.length > 0) {
    summary.exclusiveMaximum = Math.min(...exclusiveMaximum)
  }
  const multiples = readNumberKeyword(schemas, 'multipleOf', '/')
  if (multiples.length === 1) {
    summary.multipleOf = multiples[0]
  } else if (multiples.length > 1) {
    summary.multipleOf = multiples
  }
  const minItems = readNumberKeyword(schemas, 'minItems', '/')
  if (minItems.length > 0) {
    summary.minItems = Math.max(...minItems)
  }
  const maxItems = readNumberKeyword(schemas, 'maxItems', '/')
  if (maxItems.length > 0) {
    summary.maxItems = Math.min(...maxItems)
  }
  if (schemas.some(({ schema }) => schema.additionalProperties === false)) {
    summary.additionalProperties = false
  }
  return summary
}

function sourcesOf(schemas: readonly SourcedSchema[]): string[] {
  return [...new Set(schemas.map(({ source }) => source))].sort()
}

function attributeFor(
  name: string,
  required: boolean,
  pointerSegments: readonly (string | number | null)[],
  entity: SynthEntity,
): IssuerFixtureAttribute {
  return {
    pointer: toJsonPointer(pointerSegments),
    name,
    required,
    types: entity.types,
    constraints: entity.constraints,
    sources: entity.sources,
    generated: true,
  }
}

function unsupportedAttribute(
  name: string,
  required: boolean,
  pointerSegments: readonly (string | number | null)[],
  schemas: readonly SourcedSchema[],
  reason: string,
): IssuerFixtureAttribute {
  return {
    pointer: toJsonPointer(pointerSegments),
    name,
    required,
    types: [],
    constraints: {},
    sources: sourcesOf(schemas),
    generated: false,
    reason,
  }
}

function synthesizeObject(
  schemas: readonly SourcedSchema[],
  pointerSegments: readonly (string | number | null)[],
  instanceSegments: readonly (string | number)[],
  depth: number,
  types: readonly string[],
  summary: Readonly<Record<string, unknown>>,
  budget: SynthesisBudget,
  attributes: IssuerFixtureAttribute[],
): SynthEntity {
  const names = new Set<string>()
  const required = new Set<string>()

  for (const { schema } of schemas) {
    const properties = schema.properties
    if (properties !== undefined) {
      if (!isRecord(properties)) {
        throw new SynthesisError('invalid_properties_keyword')
      }
      for (const name of Object.keys(properties)) {
        names.add(name)
      }
    }
    const requiredNames = schema.required
    if (requiredNames !== undefined) {
      if (
        !Array.isArray(requiredNames) ||
        !requiredNames.every((entry): entry is string => typeof entry === 'string')
      ) {
        throw new SynthesisError('invalid_required_keyword')
      }
      for (const name of requiredNames) {
        required.add(name)
        names.add(name)
      }
    }
  }

  const sortedNames = [...names].sort()
  const payload: Record<string, unknown> = {}
  const properties: SynthProperty[] = []

  for (const name of sortedNames) {
    budget.properties += 1
    if (budget.properties > MAX_SYNTHESIS_PROPERTIES) {
      throw new SynthesisError('too_many_properties')
    }
    const isRequired = required.has(name)
    const childPointer = [...pointerSegments, name]
    const propertySources: SourcedSchema[] = []
    try {
      for (const sourced of schemas) {
        const declared = sourced.schema.properties
        if (isRecord(declared) && Object.prototype.hasOwnProperty.call(declared, name)) {
          const child = declared[name]
          if (typeof child !== 'boolean' && !isRecord(child)) {
            throw new SynthesisError('invalid_property_schema')
          }
          if (child === false) {
            throw new SynthesisError('unsupported_boolean_schema')
          }
          propertySources.push({ schema: child === true ? {} : child, source: sourced.source })
        }
      }
      const node = synthesizeNode(
        propertySources,
        childPointer,
        [...instanceSegments, name],
        depth + 1,
        isRequired,
        name,
        budget,
        attributes,
      )
      properties.push({ name, required: isRequired, node })
      Object.defineProperty(payload, name, {
        value: node.value,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    } catch (error) {
      if (!(error instanceof SynthesisError) || isRequired) {
        throw error
      }
      attributes.push(
        unsupportedAttribute(name, isRequired, childPointer, propertySources, error.reason),
      )
    }
  }

  return {
    kind: 'object',
    value: payload,
    types,
    constraints: summary,
    sources: sourcesOf(schemas),
    instanceSegments,
    properties,
    items: null,
  }
}

function synthesizeArray(
  schemas: readonly SourcedSchema[],
  pointerSegments: readonly (string | number | null)[],
  instanceSegments: readonly (string | number)[],
  depth: number,
  types: readonly string[],
  summary: Readonly<Record<string, unknown>>,
  budget: SynthesisBudget,
  attributes: IssuerFixtureAttribute[],
): SynthEntity {
  let minItems = 0
  let maxItems = Number.POSITIVE_INFINITY
  const itemSources: SourcedSchema[] = []
  let itemsForbidden = false

  for (const { schema, source } of schemas) {
    const min = schema.minItems
    if (min !== undefined) {
      if (typeof min !== 'number' || !Number.isInteger(min) || min < 0) {
        throw new SynthesisError('invalid_minItems_keyword')
      }
      minItems = Math.max(minItems, min)
    }
    const max = schema.maxItems
    if (max !== undefined) {
      if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
        throw new SynthesisError('invalid_maxItems_keyword')
      }
      maxItems = Math.min(maxItems, max)
    }
    const items = schema.items
    if (items === undefined) {
      continue
    }
    if (items === false) {
      itemsForbidden = true
      continue
    }
    if (items === true) {
      itemSources.push({ schema: {}, source })
      continue
    }
    if (!isRecord(items)) {
      throw new SynthesisError('unsupported_items_keyword')
    }
    itemSources.push({ schema: items, source })
  }

  if (itemsForbidden) {
    maxItems = 0
  }
  if (minItems > maxItems) {
    throw new SynthesisError('unsatisfiable_item_count')
  }
  if (minItems > MAX_SYNTHESIS_ARRAY_ITEMS) {
    throw new SynthesisError('array_too_large')
  }
  const length = Math.min(Math.max(minItems, maxItems === 0 ? 0 : 1), MAX_SYNTHESIS_ARRAY_ITEMS)

  const values: unknown[] = []
  let firstItem: SynthEntity | null = null
  for (let index = 0; index < length; index += 1) {
    const node = synthesizeNode(
      itemSources,
      [...pointerSegments, null],
      [...instanceSegments, index],
      depth + 1,
      false,
      '*',
      budget,
      attributes,
    )
    values.push(node.value)
    firstItem ??= node
  }

  return {
    kind: 'array',
    value: values,
    types,
    constraints: summary,
    sources: sourcesOf(schemas),
    instanceSegments,
    properties: [],
    items: firstItem,
  }
}

function synthesizeNode(
  sources: readonly SourcedSchema[],
  pointerSegments: readonly (string | number | null)[],
  instanceSegments: readonly (string | number)[],
  depth: number,
  required: boolean,
  name: string,
  budget: SynthesisBudget,
  attributes: IssuerFixtureAttribute[],
): SynthEntity {
  budget.nodes += 1
  if (budget.nodes > MAX_SYNTHESIS_NODES) {
    throw new SynthesisError('payload_too_large')
  }
  if (depth > MAX_SYNTHESIS_DEPTH) {
    throw new SynthesisError('payload_too_deep')
  }

  const schemas = flattenAllOf(sources, depth)
  const localAttributes: IssuerFixtureAttribute[] = []
  const types = effectiveTypes(schemas)
  const constant = collectConst(schemas)
  const enumerations = collectEnums(schemas)
  const summary = summarizeConstraints(schemas, types, constant, enumerations)
  if (constant.present) {
    if (!matchesAnyType(constant.value, types)) {
      throw new SynthesisError('const_type_conflict')
    }
    if (
      enumerations !== null &&
      !enumerations.some((entry) => isDeepStrictEqual(entry, constant.value))
    ) {
      throw new SynthesisError('const_enum_conflict')
    }
    const entity: SynthEntity = {
      kind: jsonKindOf(constant.value),
      value: constant.value,
      types,
      constraints: summary,
      sources: sourcesOf(schemas),
      instanceSegments,
      properties: [],
      items: null,
    }
    if (name !== '') {
      localAttributes.push(attributeFor(name, required, pointerSegments, entity))
    }
    attributes.push(...localAttributes)
    return entity
  }
  if (enumerations !== null) {
    const value = chooseEnumValue(enumerations, types)
    const entity: SynthEntity = {
      kind: jsonKindOf(value),
      value,
      types,
      constraints: summary,
      sources: sourcesOf(schemas),
      instanceSegments,
      properties: [],
      items: null,
    }
    if (name !== '') {
      localAttributes.push(attributeFor(name, required, pointerSegments, entity))
    }
    attributes.push(...localAttributes)
    return entity
  }

  const kind = chooseKind(types)
  let entity: SynthEntity
  switch (kind) {
    case 'object':
      entity = synthesizeObject(
        schemas,
        pointerSegments,
        instanceSegments,
        depth,
        types,
        summary,
        budget,
        localAttributes,
      )
      break
    case 'array':
      entity = synthesizeArray(
        schemas,
        pointerSegments,
        instanceSegments,
        depth,
        types,
        summary,
        budget,
        localAttributes,
      )
      break
    case 'string':
      entity = {
        kind,
        value: synthesizeString(schemas),
        types,
        constraints: summary,
        sources: sourcesOf(schemas),
        instanceSegments,
        properties: [],
        items: null,
      }
      break
    case 'integer':
    case 'number':
      entity = {
        kind,
        value: synthesizeNumber(kind, schemas),
        types,
        constraints: summary,
        sources: sourcesOf(schemas),
        instanceSegments,
        properties: [],
        items: null,
      }
      break
    case 'boolean':
      entity = {
        kind,
        value: false,
        types,
        constraints: summary,
        sources: sourcesOf(schemas),
        instanceSegments,
        properties: [],
        items: null,
      }
      break
    case 'null':
      entity = {
        kind,
        value: null,
        types,
        constraints: summary,
        sources: sourcesOf(schemas),
        instanceSegments,
        properties: [],
        items: null,
      }
      break
  }

  if (name !== '') {
    localAttributes.push(attributeFor(name, required, pointerSegments, entity))
  }
  attributes.push(...localAttributes)
  return entity
}

function jsonKindOf(value: unknown): SynthesisKind {
  const type = jsonTypeOf(value)
  if (type === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number'
  }
  if (
    type === 'object' ||
    type === 'array' ||
    type === 'string' ||
    type === 'boolean' ||
    type === 'null'
  ) {
    return type
  }
  throw new SynthesisError('unsupported_override_value')
}

function dedupeAttributes(attributes: readonly IssuerFixtureAttribute[]): IssuerFixtureAttribute[] {
  const byPointer = new Map<string, IssuerFixtureAttribute>()
  for (const attribute of attributes) {
    if (!byPointer.has(attribute.pointer)) {
      byPointer.set(attribute.pointer, attribute)
    }
  }
  return [...byPointer.values()].sort((left, right) =>
    left.pointer < right.pointer ? -1 : left.pointer > right.pointer ? 1 : 0,
  )
}

function schemaNodeCount(value: unknown, limit: number): number {
  let count = 0
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const current = stack.pop()
    count += 1
    if (count > limit) {
      return count
    }
    if (Array.isArray(current)) {
      for (const entry of current as unknown[]) {
        stack.push(entry)
      }
    } else if (isRecord(current)) {
      stack.push(...Object.values(current))
    }
  }
  return count
}

function compileJsonSchema(pending: PendingSchemaDocument):
  | { readonly ok: true; readonly compiled: CompiledJsonSchema }
  | {
      readonly ok: false
      readonly diagnostic: string
    } {
  const document = pending.document
  if (!isRecord(document)) {
    return { ok: false, diagnostic: 'The supplied JSON Schema document is not an object.' }
  }
  if ('$schema' in document) {
    const dialect = document.$schema
    if (typeof dialect !== 'string' || !SUPPORTED_SCHEMA_DIALECTS.has(dialect)) {
      return {
        ok: false,
        diagnostic:
          'The supplied JSON Schema declares a dialect other than JSON Schema 2020-12 and was not applied.',
      }
    }
  }
  if (schemaNodeCount(document, MAX_SCHEMA_NODES) > MAX_SCHEMA_NODES) {
    return {
      ok: false,
      diagnostic: `The supplied JSON Schema exceeds the ${MAX_SCHEMA_NODES}-node fixture evaluation bound and was not applied.`,
    }
  }
  try {
    const validate = new Ajv2020({
      allErrors: false,
      strict: false,
      strictSchema: true,
      validateFormats: false,
      allowUnionTypes: true,
      // Treat only own properties as claims. Without this a plain object always
      // "has" __proto__ through its prototype, so a payload missing that own
      // claim would still be reported as valid.
      ownProperties: true,
    }).compile(document)
    return {
      ok: true,
      compiled: { pending, reference: pending.reference, validate },
    }
  } catch {
    return {
      ok: false,
      diagnostic: 'The supplied JSON Schema document could not be compiled and was not applied.',
    }
  }
}

function findingFor(error: ErrorObject): IssuerFixtureFinding {
  const path = error.instancePath === '' ? '/' : error.instancePath
  const keyword = error.keyword
  return {
    code: 'schema_violation',
    message: `The fixture payload violates the JSON Schema "${keyword}" constraint.`,
    path,
    keyword,
  }
}

function evaluatePayload(
  compiled: readonly CompiledJsonSchema[],
  payload: Record<string, unknown>,
): IssuerFixturePayloadValidation {
  const findings: IssuerFixtureFinding[] = []
  for (const document of compiled) {
    if (document.validate(payload)) {
      continue
    }
    const first = document.validate.errors?.[0]
    if (first !== undefined) {
      findings.push(findingFor(first))
    }
  }
  return { status: findings.length === 0 ? 'PASS' : 'FAIL', findings }
}

function getAtPath(
  root: unknown,
  segments: readonly string[],
): {
  readonly found: boolean
  readonly value: unknown
} {
  let current = root
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined }
      }
      current = current[index]
      continue
    }
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined }
    }
    current = current[segment]
  }
  return { found: true, value: current }
}

function setAtPath(
  root: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): boolean {
  if (segments.length === 0) {
    return false
  }
  const parent = getAtPath(root, segments.slice(0, -1))
  const last = segments[segments.length - 1]
  if (last === undefined || !parent.found) {
    return false
  }
  if (Array.isArray(parent.value)) {
    const index = Number(last)
    if (!Number.isInteger(index) || index < 0 || index >= parent.value.length) {
      return false
    }
    parent.value[index] = value
    return true
  }
  if (!isRecord(parent.value) || !Object.prototype.hasOwnProperty.call(parent.value, last)) {
    return false
  }
  Object.defineProperty(parent.value, last, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
  return true
}

function deleteAtPath(root: Record<string, unknown>, segments: readonly string[]): boolean {
  if (segments.length === 0) {
    return false
  }
  const parent = getAtPath(root, segments.slice(0, -1))
  const last = segments[segments.length - 1]
  if (last === undefined || !parent.found) {
    return false
  }
  if (Array.isArray(parent.value)) {
    const index = Number(last)
    if (!Number.isInteger(index) || index < 0 || index >= parent.value.length) {
      return false
    }
    parent.value.splice(index, 1)
    return true
  }
  if (!isRecord(parent.value) || !Object.prototype.hasOwnProperty.call(parent.value, last)) {
    return false
  }
  delete parent.value[last]
  return true
}

function pathSegmentsOf(pointer: string): string[] {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function differentTypeValue(kind: SynthesisKind): unknown {
  switch (kind) {
    case 'string':
      return 0
    case 'number':
    case 'integer':
      return 'fixture-not-a-number'
    case 'boolean':
      return 'fixture-not-a-boolean'
    case 'array':
      return 'fixture-not-an-array'
    case 'object':
      return 'fixture-not-an-object'
    case 'null':
      return 'fixture-not-null'
  }
}

function differentValue(value: unknown): unknown {
  if (value === null) {
    return 'fixture-not-null'
  }
  if (typeof value === 'string') {
    return 0
  }
  if (typeof value === 'number') {
    return 'fixture-not-a-number'
  }
  if (typeof value === 'boolean') {
    return !value
  }
  return null
}

function outsideEnum(values: readonly unknown[], kind: SynthesisKind): unknown {
  const candidates: unknown[] = []
  if (kind === 'string') {
    for (let index = 0; index < 8; index += 1) {
      candidates.push(`fixture_not_in_enum_${index}`)
    }
  } else if (kind === 'number' || kind === 'integer') {
    for (let index = 0; index < 16; index += 1) {
      candidates.push(index)
    }
  } else if (kind === 'boolean') {
    candidates.push(true, false)
  } else {
    candidates.push(null, 'fixture-not-in-enum')
  }
  for (const candidate of candidates) {
    if (!values.some((entry) => isDeepStrictEqual(entry, candidate))) {
      return candidate
    }
  }
  return candidates[0]
}

function numberConstraint(node: SynthEntity, keyword: string): number | null {
  const value = node.constraints[keyword]
  return typeof value === 'number' ? value : null
}

interface NegativeCaseState {
  readonly cases: IssuerFixtureNegativeCase[]
  readonly seen: Set<string>
  readonly compiled: readonly CompiledJsonSchema[]
  readonly baseline: Record<string, unknown>
}

function expectedKeywords(category: IssuerFixtureNegativeCategory): readonly string[] {
  switch (category) {
    case 'missing_required':
      return ['required']
    case 'type':
      return ['type']
    case 'enum':
      return ['enum']
    case 'const':
      return ['const']
    case 'max_length':
      return ['maxLength']
    case 'min_length':
      return ['minLength']
    case 'maximum':
      return ['maximum', 'exclusiveMaximum']
    case 'minimum':
      return ['minimum', 'exclusiveMinimum']
    case 'multiple_of':
      return ['multipleOf']
    case 'max_items':
      return ['maxItems']
    case 'min_items':
      return ['minItems']
    case 'additional_properties':
      return ['additionalProperties']
  }
}

function addNegativeCase(
  state: NegativeCaseState,
  category: IssuerFixtureNegativeCategory,
  mutate: (payload: Record<string, unknown>) => boolean,
  pathOverride?: string,
): void {
  if (state.cases.length >= MAX_NEGATIVE_CASES) {
    return
  }
  const payload: Record<string, unknown> = structuredClone(state.baseline)
  if (!mutate(payload)) {
    return
  }
  const validation = evaluatePayload(state.compiled, payload)
  if (validation.status !== 'FAIL') {
    return
  }
  const finding = validation.findings[0]
  if (finding === undefined) {
    return
  }
  const path = finding.path ?? '/'
  const keyword = finding.keyword ?? 'schema'
  if (!expectedKeywords(category).includes(keyword)) {
    return
  }
  const reportedPath = pathOverride ?? path
  const id = `${category}:${reportedPath}`
  if (state.seen.has(id)) {
    return
  }
  state.seen.add(id)
  state.cases.push({
    id,
    label: labelFor(category, reportedPath, keyword),
    category,
    keyword,
    path: reportedPath,
    expected: 'FAIL',
    reason: `The supplied schema documents reject this payload (${keyword} at ${path}).`,
    payload,
  })
}

function labelFor(category: IssuerFixtureNegativeCategory, path: string, keyword: string): string {
  switch (category) {
    case 'missing_required':
      return `Missing required attribute at ${path}`
    case 'type':
      return `Wrong value type at ${path}`
    case 'enum':
      return `Value outside the allowed enumeration at ${path}`
    case 'const':
      return `Value other than the required constant at ${path}`
    case 'max_length':
      return `Value longer than the maximum length at ${path}`
    case 'min_length':
      return `Value shorter than the minimum length at ${path}`
    case 'maximum':
      return `Value greater than the maximum at ${path}`
    case 'minimum':
      return `Value smaller than the minimum at ${path}`
    case 'multiple_of':
      return `Value not a multiple of the required factor at ${path}`
    case 'max_items':
      return `Too many array items at ${path}`
    case 'min_items':
      return `Too few array items at ${path}`
    case 'additional_properties':
      return `Undeclared property at ${path}`
    default:
      return `Schema "${keyword}" violation at ${path}`
  }
}

function derivePrimitiveNegativeCases(node: SynthEntity, state: NegativeCaseState): void {
  const segments = node.instanceSegments.map((segment) => String(segment))

  addNegativeCase(state, 'type', (payload) =>
    setAtPath(payload, segments, differentTypeValue(node.kind)),
  )

  const enumValues = node.constraints.enum
  if (Array.isArray(enumValues)) {
    addNegativeCase(state, 'enum', (payload) =>
      setAtPath(payload, segments, outsideEnum(enumValues, node.kind)),
    )
  }
  if ('const' in node.constraints) {
    addNegativeCase(state, 'const', (payload) =>
      setAtPath(payload, segments, differentValue(node.constraints.const)),
    )
  }

  if (node.kind === 'string') {
    const maxLength = numberConstraint(node, 'maxLength')
    if (maxLength !== null && maxLength < MAX_NEGATIVE_STRING_LENGTH) {
      addNegativeCase(state, 'max_length', (payload) =>
        setAtPath(payload, segments, 'x'.repeat(maxLength + 1)),
      )
    }
    const minLength = numberConstraint(node, 'minLength')
    if (minLength !== null && minLength > 0) {
      addNegativeCase(state, 'min_length', (payload) =>
        setAtPath(payload, segments, 'x'.repeat(Math.max(0, minLength - 1))),
      )
    }
  }

  if (node.kind === 'number' || node.kind === 'integer') {
    const maximum = numberConstraint(node, 'maximum')
    const exclusiveMaximum = numberConstraint(node, 'exclusiveMaximum')
    if (maximum !== null) {
      addNegativeCase(state, 'maximum', (payload) => setAtPath(payload, segments, maximum + 1))
    } else if (exclusiveMaximum !== null) {
      addNegativeCase(state, 'maximum', (payload) => setAtPath(payload, segments, exclusiveMaximum))
    }
    const minimum = numberConstraint(node, 'minimum')
    const exclusiveMinimum = numberConstraint(node, 'exclusiveMinimum')
    if (minimum !== null) {
      addNegativeCase(state, 'minimum', (payload) => setAtPath(payload, segments, minimum - 1))
    } else if (exclusiveMinimum !== null) {
      addNegativeCase(state, 'minimum', (payload) => setAtPath(payload, segments, exclusiveMinimum))
    }
    const multipleOf = numberConstraint(node, 'multipleOf')
    if (multipleOf !== null && !(node.kind === 'integer' && multipleOf <= 1)) {
      const current = node.value
      if (typeof current === 'number') {
        addNegativeCase(state, 'multiple_of', (payload) =>
          setAtPath(payload, segments, current + multipleOf / 2),
        )
      }
    }
  }
}

function deriveNegativeCases(
  node: SynthEntity,
  baseline: Record<string, unknown>,
  compiled: readonly CompiledJsonSchema[],
): IssuerFixtureNegativeCase[] {
  const state: NegativeCaseState = { cases: [], seen: new Set(), compiled, baseline }

  const visit = (current: SynthEntity): void => {
    if (state.cases.length >= MAX_NEGATIVE_CASES) {
      return
    }
    if (current.kind === 'object') {
      for (const property of current.properties) {
        if (state.cases.length >= MAX_NEGATIVE_CASES) {
          return
        }
        if (property.required) {
          const segments = property.node.instanceSegments.map((segment) => String(segment))
          addNegativeCase(
            state,
            'missing_required',
            (payload) => deleteAtPath(payload, segments),
            toJsonPointer(property.node.instanceSegments),
          )
        }
        visit(property.node)
      }
      if (current.constraints.additionalProperties === false) {
        const segments = [
          ...current.instanceSegments.map((segment) => String(segment)),
          EXTRA_PROPERTY_NAME,
        ]
        addNegativeCase(
          state,
          'additional_properties',
          (payload) => {
            const parent = getAtPath(payload, segments.slice(0, -1))
            if (!isRecord(parent.value)) {
              return false
            }
            Object.defineProperty(parent.value, EXTRA_PROPERTY_NAME, {
              value: null,
              enumerable: true,
              writable: true,
              configurable: true,
            })
            return true
          },
          toJsonPointer([...current.instanceSegments, EXTRA_PROPERTY_NAME]),
        )
      }
      return
    }
    if (current.kind === 'array') {
      const segments = current.instanceSegments.map((segment) => String(segment))
      const maxItems = numberConstraint(current, 'maxItems')
      if (maxItems !== null && maxItems < MAX_SYNTHESIS_ARRAY_ITEMS) {
        const template = current.items?.value ?? null
        addNegativeCase(state, 'max_items', (payload) =>
          setAtPath(
            payload,
            segments,
            Array.from({ length: maxItems + 1 }, () => template),
          ),
        )
      }
      const minItems = numberConstraint(current, 'minItems')
      if (minItems !== null && minItems > 0) {
        const template = current.items?.value ?? null
        addNegativeCase(state, 'min_items', (payload) =>
          setAtPath(
            payload,
            segments,
            Array.from({ length: minItems - 1 }, () => template),
          ),
        )
      }
      if (current.items !== null) {
        visit(current.items)
      }
      return
    }
    derivePrimitiveNegativeCases(current, state)
  }

  visit(node)
  return state.cases
}

function describeSynthesisError(error: SynthesisError): string {
  const [reason, detail] = error.reason.split(':', 2)
  switch (reason) {
    case 'unsupported_keyword':
      return `The supplied schema uses "${detail ?? 'an unsupported keyword'}", which this fixture slice cannot synthesize safely.`
    case 'incompatible_types':
      return 'The supplied schema documents declare attribute types that cannot all be satisfied by one value.'
    case 'conflicting_const':
      return 'The supplied schema documents declare conflicting const values for one attribute.'
    case 'incompatible_enum':
      return 'The supplied schema documents declare enumerations with no common value.'
    case 'unsatisfiable_numeric_constraints':
      return 'The supplied schema documents declare numeric bounds that no synthesized value can satisfy.'
    case 'unsatisfiable_string_length':
      return 'The supplied schema documents declare string-length bounds that no synthesized value can satisfy.'
    case 'unsatisfiable_item_count':
      return 'The supplied schema documents declare array item counts that no synthesized value can satisfy.'
    case 'string_too_large':
      return `The supplied schema requires a string longer than the ${MAX_SYNTHESIS_STRING_LENGTH}-character synthesis bound.`
    case 'array_too_large':
      return `The supplied schema requires more than ${MAX_SYNTHESIS_ARRAY_ITEMS} array items.`
    case 'too_many_properties':
      return `The supplied schema declares more than ${MAX_SYNTHESIS_PROPERTIES} object attributes.`
    case 'payload_too_large':
      return `The synthesized payload exceeds the ${MAX_SYNTHESIS_NODES}-node bound.`
    case 'payload_too_deep':
      return 'The supplied schema is nested more deeply than the fixture synthesis bound.'
    case 'root_not_object':
      return 'The supplied schema documents do not describe a JSON object claim set.'
    case 'no_attributes':
      return 'The supplied schema documents declare no object attributes, so there is nothing to generate.'
    case 'unsupported_boolean_schema':
      return 'The supplied schema contains a boolean schema branch this fixture slice cannot synthesize.'
    default:
      return 'The supplied schema documents cannot be synthesized into a fixture in this slice.'
  }
}

/** Runs one prepared fixture request entirely inside the sandbox child. */
export function runFixtureCore(request: FixtureSandboxRequest): FixtureSandboxResult {
  const compiled: CompiledJsonSchema[] = []
  const documents: FixtureSandboxDocumentResult[] = []
  for (const pending of request.items) {
    const result = compileJsonSchema(pending)
    if (!result.ok) {
      documents.push({
        index: pending.index,
        applied: false,
        diagnostic: result.diagnostic,
      })
      continue
    }
    compiled.push(result.compiled)
    documents.push({ index: pending.index, applied: true })
  }

  if (compiled.length === 0) {
    return { ok: false, reason: FIXTURE_SANDBOX_REASONS.noUsableDocuments }
  }

  const sources: SourcedSchema[] = compiled.map((document) => ({
    schema: document.pending.document as Record<string, unknown>,
    source: document.reference.uri,
  }))
  const attributes: IssuerFixtureAttribute[] = []
  const budget: SynthesisBudget = { nodes: 0, properties: 0 }
  let root: SynthEntity
  try {
    root = synthesizeNode(sources, [], [], 0, true, '', budget, attributes)
    if (root.kind !== 'object') {
      throw new SynthesisError('root_not_object')
    }
  } catch (error) {
    if (error instanceof SynthesisError) {
      return { ok: false, reason: describeSynthesisError(error) }
    }
    throw error
  }

  const baseline = root.value
  if (!isRecord(baseline)) {
    return {
      ok: false,
      reason: 'The supplied schema documents do not describe a JSON object claim set.',
    }
  }
  if (evaluatePayload(compiled, baseline).status !== 'PASS') {
    return { ok: false, reason: FIXTURE_SANDBOX_REASONS.baselineValidationFailed }
  }

  const deduped = dedupeAttributes(attributes)
  if (deduped.length === 0) {
    return { ok: false, reason: describeSynthesisError(new SynthesisError('no_attributes')) }
  }

  const payload: Record<string, unknown> = structuredClone(baseline)
  const overrides: IssuerFixtureOverride[] = []
  for (const [index, override] of request.overrides.entries()) {
    if (!setAtPath(payload, pathSegmentsOf(override.path), override.value)) {
      return {
        ok: false,
        reason: FIXTURE_SANDBOX_REASONS.overridePathMissing,
        index,
      }
    }
    overrides.push({ path: override.path, value: override.value, applied: true })
  }

  return {
    ok: true,
    documents,
    attributes: deduped,
    payload,
    payloadValidation: evaluatePayload(compiled, payload),
    overrides,
    negativeCases: deriveNegativeCases(root, baseline, compiled),
  }
}
