// Bounded parsing of the untrusted headless-wallet comparison request
// (FR-021, issue #50).
//
// The body carries only the caller's external wallet observation. AttestBook
// rejects malformed, ambiguous and oversized input with a stable
// `invalid_input` error before it is interpreted, and never echoes the body
// back in an error message. The external observation is untrusted input: it is
// recorded as external evidence and never treated as an AttestBook result.

import { invalidInput } from '../registry/errors'
import { requireText } from '../registry/validation'
import {
  VALIDATION_DIMENSIONS,
  VALIDATION_STATUSES,
  type ValidationDimensionId,
  type ValidationStatus,
} from '../validation'

import {
  EXTERNAL_WALLET_INTERACTIONS,
  type ExternalDimensionObservation,
  type ExternalWalletInteraction,
  type ExternalWalletObservation,
} from './types'

/** Bound on the caller-owned wallet identifier. */
export const MAX_EXTERNAL_WALLET_ID_LENGTH = 200
/** Bound on the number of observations one wallet may report. */
export const MAX_EXTERNAL_WALLET_OBSERVATIONS = 8
/** Bound on a caller-defined observation code. */
export const MAX_EXTERNAL_OBSERVATION_CODE_LENGTH = 120
/** Bound on a caller-supplied non-sensitive observation detail. */
export const MAX_EXTERNAL_OBSERVATION_DETAIL_LENGTH = 500
/** Bound on the caller-asserted observation timestamp text. */
export const MAX_EXTERNAL_OBSERVATION_TIMESTAMP_LENGTH = 64

const OPAQUE_IDENTIFIER_PATTERN = /^[\x21-\x7e]+$/
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

/** The typed comparison request body. */
export interface CompareCaptureInput {
  readonly externalWallet: ExternalWalletObservation | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireOpaqueIdentifier(value: unknown, field: string, maxLength: number): string {
  const text = requireText(value, field, maxLength)
  if (!OPAQUE_IDENTIFIER_PATTERN.test(text)) {
    throw invalidInput(`${field} must be printable ASCII without whitespace`)
  }
  return text
}

function requireTimestamp(value: unknown, field: string): string {
  const text = requireText(value, field, MAX_EXTERNAL_OBSERVATION_TIMESTAMP_LENGTH)
  if (!RFC3339_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw invalidInput(`${field} must be an RFC 3339 timestamp with an explicit offset`)
  }
  return text
}

function requireInteraction(value: unknown): ExternalWalletInteraction {
  if (
    typeof value !== 'string' ||
    !(EXTERNAL_WALLET_INTERACTIONS as readonly string[]).includes(value)
  ) {
    throw invalidInput(
      `externalWallet.interaction must be one of ${EXTERNAL_WALLET_INTERACTIONS.join(', ')}`,
    )
  }
  return value as ExternalWalletInteraction
}

function requireDimension(value: unknown, field: string): ValidationDimensionId {
  if (typeof value !== 'string' || !(VALIDATION_DIMENSIONS as readonly string[]).includes(value)) {
    throw invalidInput(`${field} must be a known FR-010 validation dimension`)
  }
  return value as ValidationDimensionId
}

function requireStatus(value: unknown, field: string): ValidationStatus {
  if (typeof value !== 'string' || !(VALIDATION_STATUSES as readonly string[]).includes(value)) {
    throw invalidInput(`${field} must be one of ${VALIDATION_STATUSES.join(', ')}`)
  }
  return value as ValidationStatus
}

function parseObservation(value: unknown, index: number): ExternalDimensionObservation {
  const field = `externalWallet.observations[${index}]`
  if (!isRecord(value)) {
    throw invalidInput(`${field} must be a JSON object`)
  }
  return {
    dimension: requireDimension(value.dimension, `${field}.dimension`),
    status: requireStatus(value.status, `${field}.status`),
    code:
      value.code === undefined || value.code === null
        ? null
        : requireText(value.code, `${field}.code`, MAX_EXTERNAL_OBSERVATION_CODE_LENGTH),
    detail:
      value.detail === undefined || value.detail === null
        ? null
        : requireText(value.detail, `${field}.detail`, MAX_EXTERNAL_OBSERVATION_DETAIL_LENGTH),
  }
}

/** Parses and bounds one external wallet observation. */
export function parseExternalWalletObservation(value: unknown): ExternalWalletObservation {
  if (!isRecord(value)) {
    throw invalidInput('externalWallet must be a JSON object')
  }
  const walletId = requireOpaqueIdentifier(
    value.walletId,
    'externalWallet.walletId',
    MAX_EXTERNAL_WALLET_ID_LENGTH,
  )
  const observedAt = requireTimestamp(value.observedAt, 'externalWallet.observedAt')
  const interaction = requireInteraction(value.interaction)
  if (!Array.isArray(value.observations)) {
    throw invalidInput('externalWallet.observations must be an array')
  }
  if (value.observations.length === 0) {
    throw invalidInput('externalWallet.observations must contain at least one observation')
  }
  if (value.observations.length > MAX_EXTERNAL_WALLET_OBSERVATIONS) {
    throw invalidInput(
      `externalWallet.observations must contain at most ${MAX_EXTERNAL_WALLET_OBSERVATIONS} entries`,
    )
  }
  const observations = value.observations.map((observation, index) =>
    parseObservation(observation, index),
  )
  const seen = new Set<ValidationDimensionId>()
  for (const observation of observations) {
    if (seen.has(observation.dimension)) {
      throw invalidInput(
        `externalWallet.observations must not repeat the dimension "${observation.dimension}"`,
      )
    }
    seen.add(observation.dimension)
  }
  return { walletId, observedAt, interaction, observations }
}

/**
 * Parses the comparison request body. The external wallet observation is
 * optional: a comparison without it still reports the AttestBook structural
 * evidence and every unsupported dimension explicitly.
 */
export function parseCompareCaptureInput(value: unknown): CompareCaptureInput {
  if (!isRecord(value)) {
    throw invalidInput('request body must be a JSON object')
  }
  if (value.externalWallet === undefined || value.externalWallet === null) {
    return { externalWallet: null }
  }
  return { externalWallet: parseExternalWalletObservation(value.externalWallet) }
}
