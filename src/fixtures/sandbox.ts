// Wire contract between the fixture generator and its sandbox child (FR-013).
//
// The parent sends only prepared, integrity-verified schema documents and
// bounded overrides. The child returns a JSON result that is parsed strictly
// here: a malformed answer is a sandbox failure, never trusted data. Messages
// in the result are safe to return to a caller and never contain claim values.

import { z } from 'zod'

import type { PendingSchemaDocument } from '../validation/schema'

import {
  ISSUER_FIXTURE_NEGATIVE_CATEGORIES,
  type IssuerFixtureAttribute,
  type IssuerFixtureNegativeCase,
  type IssuerFixtureOverride,
  type IssuerFixtureOverrideInput,
  type IssuerFixturePayloadValidation,
} from './types'

/** Stable non-user-facing reasons the child reports for an expected failure. */
export const FIXTURE_SANDBOX_REASONS = {
  noUsableDocuments: 'no_usable_schema_documents',
  baselineValidationFailed: 'baseline_validation_failed',
  overridePathMissing: 'override_path_missing',
} as const

/** One fixture-generation request handed to the sandbox child. */
export interface FixtureSandboxRequest {
  /** Only prepared `json_schema` documents; Type Metadata stays in the parent. */
  readonly items: readonly PendingSchemaDocument[]
  readonly overrides: readonly IssuerFixtureOverrideInput[]
}

/** Per-document compilation outcome returned by the child. */
export interface FixtureSandboxDocumentResult {
  readonly index: number
  readonly applied: boolean
  readonly diagnostic?: string
}

/** One successful child result: everything derived in the sandbox. */
export interface FixtureSandboxSuccess {
  readonly ok: true
  readonly documents: readonly FixtureSandboxDocumentResult[]
  readonly attributes: readonly IssuerFixtureAttribute[]
  readonly payload: Readonly<Record<string, unknown>>
  readonly payloadValidation: IssuerFixturePayloadValidation
  readonly overrides: readonly IssuerFixtureOverride[]
  readonly negativeCases: readonly IssuerFixtureNegativeCase[]
}

/** An expected failure the child reports without echoing input values. */
export interface FixtureSandboxFailure {
  readonly ok: false
  readonly reason: string
  /** Index of the failing override, when the reason names one. */
  readonly index?: number
}

export type FixtureSandboxResult = FixtureSandboxSuccess | FixtureSandboxFailure

export function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) {
    return false
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1))
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every((entry) =>
      isJsonValue(entry, depth + 1),
    )
  }
  return false
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && isJsonValue(value)
}

/** A JSON object schema that keeps own `__proto__` claims instead of rebuilding them. */
const jsonObjectSchema = z.custom<Record<string, unknown>>((value) => isJsonObject(value), {
  message: 'expected a JSON object',
})

const jsonValueSchema = z.custom<unknown>((value) => isJsonValue(value), {
  message: 'expected a JSON value',
})

const findingSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
  keyword: z.string().optional(),
})

const attributeSchema = z.object({
  pointer: z.string(),
  name: z.string(),
  required: z.boolean(),
  types: z.array(z.string()),
  constraints: z.record(z.string(), z.json()),
  sources: z.array(z.string()),
  generated: z.boolean(),
  reason: z.string().optional(),
})

const payloadValidationSchema = z.object({
  status: z.enum(['PASS', 'FAIL']),
  findings: z.array(findingSchema),
})

const overrideSchema = z.object({
  path: z.string(),
  value: jsonValueSchema,
  applied: z.literal(true),
})

const negativeCaseSchema = z.object({
  id: z.string(),
  label: z.string(),
  category: z.enum(ISSUER_FIXTURE_NEGATIVE_CATEGORIES),
  keyword: z.string(),
  path: z.string(),
  expected: z.literal('FAIL'),
  reason: z.string(),
  payload: jsonObjectSchema,
})

const documentSchema = z.object({
  index: z.number().int().nonnegative(),
  applied: z.boolean(),
  diagnostic: z.string().optional(),
})

const resultSchema = z.union([
  z.object({
    ok: z.literal(true),
    documents: z.array(documentSchema),
    attributes: z.array(attributeSchema),
    payload: jsonObjectSchema,
    payloadValidation: payloadValidationSchema,
    overrides: z.array(overrideSchema),
    negativeCases: z.array(negativeCaseSchema),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.string().min(1),
    index: z.number().int().nonnegative().optional(),
  }),
])

/** Parses one child answer; `null` means the output was malformed. */
export function parseFixtureSandboxResult(raw: string): FixtureSandboxResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const result = resultSchema.safeParse(parsed)
  if (!result.success) {
    return null
  }
  return result.data as unknown as FixtureSandboxResult
}
