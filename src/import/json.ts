// Bounded JSON parsing for untrusted import documents.
//
// `JSON.parse` is safe against code execution but not against resource abuse:
// a small byte payload can still be deeply nested or contain a very large
// string. The importer therefore caps the byte size before parsing and walks
// the parsed value with an explicit stack to enforce the depth, node-count and
// string-length limits. `__proto__` members are rejected defensively even
// though `JSON.parse` itself creates ordinary own properties.

import { importError } from './errors'
import type { ImportLimits } from './limits'

/** A parsed import document plus its exact decoded text. */
export interface ParsedJsonDocument {
  readonly value: unknown
  readonly text: string
  readonly byteLength: number
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function decodeUtf8(bytes: Uint8Array, limits: ImportLimits): string {
  if (bytes.byteLength > limits.maxSourceBytes) {
    throw importError(
      'response_too_large',
      `the import document exceeds the ${limits.maxSourceBytes}-byte limit`,
    )
  }
  let text: string
  try {
    text = utf8Decoder.decode(bytes)
  } catch {
    throw importError('invalid_json', 'the import document is not valid UTF-8')
  }
  // A leading byte-order mark is not part of the JSON grammar.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function walk(root: unknown, limits: ImportLimits): void {
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
      throw importError(
        'json_limit',
        `the import document exceeds ${limits.maxJsonNodes} JSON values`,
      )
    }
    if (frame.depth > limits.maxJsonDepth) {
      throw importError(
        'json_limit',
        `the import document exceeds a JSON nesting depth of ${limits.maxJsonDepth}`,
      )
    }

    const value = frame.value
    if (typeof value === 'string') {
      if (value.length > limits.maxJsonStringLength) {
        throw importError(
          'json_limit',
          `a JSON string exceeds the ${limits.maxJsonStringLength}-character limit`,
        )
      }
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        stack.push({ value: item, depth: frame.depth + 1 })
      }
      continue
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        if (key === '__proto__') {
          throw importError('json_limit', 'the import document contains a forbidden member name')
        }
        if (key.length > limits.maxJsonStringLength) {
          throw importError(
            'json_limit',
            `a JSON member name exceeds the ${limits.maxJsonStringLength}-character limit`,
          )
        }
        stack.push({ value: item, depth: frame.depth + 1 })
      }
    }
  }
}

/** UTF-8 encodes a caller-supplied JSON string under the same byte limit. */
export function encodeImportText(text: string, limits: ImportLimits): Uint8Array {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength > limits.maxSourceBytes) {
    throw importError(
      'response_too_large',
      `the import document exceeds the ${limits.maxSourceBytes}-byte limit`,
    )
  }
  return bytes
}

/** Parses and bounds a JSON import document without executing it. */
export function parseBoundedJson(bytes: Uint8Array, limits: ImportLimits): ParsedJsonDocument {
  const text = decodeUtf8(bytes, limits)
  if (text.trim() === '') {
    throw importError('invalid_json', 'the import document is empty')
  }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw importError('invalid_json', 'the import document is not valid JSON')
  }

  walk(value, limits)
  return { value, text, byteLength: bytes.byteLength }
}
