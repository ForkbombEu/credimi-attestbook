// Bounded JSON parsing for untrusted capture submissions (issue #46).
//
// `JSON.parse` does not execute code but it does not bound resource use: a
// small payload can be deeply nested or carry a huge string. The normalizer
// caps the envelope size before parsing and then walks the parsed value with
// an explicit stack to enforce depth, node-count and string-length limits.
// `__proto__` members are rejected defensively even though JSON.parse creates
// ordinary own properties.

import { captureError } from './errors'
import type { CaptureLimits } from './limits'

/** A parsed capture submission plus its exact byte size. */
export interface ParsedCaptureDocument {
  readonly value: unknown
  readonly byteLength: number
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function rejectUnsupportedValue(): never {
  throw captureError('invalid_capture', 'the capture envelope contains an unsupported JSON value')
}

/**
 * Enforces the JSON resource bounds on an already-parsed value. Reused by the
 * redaction walker and by callers that hand an object (not bytes) to the
 * normalizer, so both entry points apply the same limits.
 */
export function assertBoundedJsonValue(root: unknown, limits: CaptureLimits): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ]
  let nodes = 0

  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame === undefined) {
      break
    }
    nodes += 1
    if (nodes > limits.maxJsonNodes) {
      throw captureError('json_limit', `the capture envelope exceeds ${limits.maxJsonNodes} values`)
    }
    if (frame.depth > limits.maxJsonDepth) {
      throw captureError(
        'json_limit',
        `the capture envelope exceeds a nesting depth of ${limits.maxJsonDepth}`,
      )
    }

    const value = frame.value
    if (value === null || typeof value === 'boolean') {
      continue
    }
    if (typeof value === 'string') {
      if (value.length > limits.maxJsonStringLength) {
        throw captureError(
          'json_limit',
          `a capture envelope string exceeds the ${limits.maxJsonStringLength}-character limit`,
        )
      }
      continue
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        rejectUnsupportedValue()
      }
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        stack.push({ value: item, depth: frame.depth + 1 })
      }
      continue
    }
    if (typeof value === 'object') {
      const prototype = Object.getPrototypeOf(value) as unknown
      if (prototype !== Object.prototype && prototype !== null) {
        rejectUnsupportedValue()
      }
      for (const [key, item] of Object.entries(value)) {
        // A caller handing an object directly may express an absent optional
        // member as `undefined`; JSON itself cannot carry that value.
        if (item === undefined) {
          continue
        }
        if (key === '__proto__') {
          throw captureError('json_limit', 'the capture envelope contains a forbidden member name')
        }
        if (key.length > limits.maxJsonStringLength) {
          throw captureError(
            'json_limit',
            `a capture envelope member name exceeds the ${limits.maxJsonStringLength}-character limit`,
          )
        }
        stack.push({ value: item, depth: frame.depth + 1 })
      }
      continue
    }
    rejectUnsupportedValue()
  }
}

function decodeUtf8(bytes: Uint8Array, limits: CaptureLimits): string {
  if (bytes.byteLength > limits.maxEnvelopeBytes) {
    throw captureError(
      'response_too_large',
      `the capture envelope exceeds the ${limits.maxEnvelopeBytes}-byte limit`,
    )
  }
  let text: string
  try {
    text = utf8Decoder.decode(bytes)
  } catch {
    throw captureError('invalid_json', 'the capture envelope is not valid UTF-8')
  }
  // A leading byte-order mark is not part of the JSON grammar.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** UTF-8 encodes a caller-supplied JSON string under the same byte limit. */
export function encodeCaptureText(text: string, limits: CaptureLimits): Uint8Array {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength > limits.maxEnvelopeBytes) {
    throw captureError(
      'response_too_large',
      `the capture envelope exceeds the ${limits.maxEnvelopeBytes}-byte limit`,
    )
  }
  return bytes
}

/** Parses and bounds one capture envelope without executing it. */
export function parseBoundedCaptureJson(
  bytes: Uint8Array,
  limits: CaptureLimits,
): ParsedCaptureDocument {
  const text = decodeUtf8(bytes, limits)
  if (text.trim() === '') {
    throw captureError('invalid_json', 'the capture envelope is empty')
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw captureError('invalid_json', 'the capture envelope is not valid JSON')
  }

  assertBoundedJsonValue(value, limits)
  return { value, byteLength: bytes.byteLength }
}
