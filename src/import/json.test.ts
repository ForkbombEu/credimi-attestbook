import { describe, expect, test } from 'bun:test'

import { ImportError, type ImportErrorCode } from './errors'
import { encodeImportText, parseBoundedJson } from './json'
import { DEFAULT_IMPORT_LIMITS } from './limits'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const limits = DEFAULT_IMPORT_LIMITS

function expectJsonError(action: () => unknown, code: ImportErrorCode): void {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ImportError)
  expect((caught as ImportError).code).toBe(code)
}

describe('bounded JSON parsing', () => {
  test('parses a JSON object and tolerates a UTF-8 BOM', () => {
    expect(parseBoundedJson(bytes('{"a":1}'), limits).value).toEqual({ a: 1 })
    expect(parseBoundedJson(bytes('\uFEFF{"a":1}'), limits).value).toEqual({ a: 1 })
  })

  test('rejects invalid JSON, empty input and invalid UTF-8', () => {
    expectJsonError(() => parseBoundedJson(bytes('{'), limits), 'invalid_json')
    expectJsonError(() => parseBoundedJson(bytes('   '), limits), 'invalid_json')
    expectJsonError(
      () => parseBoundedJson(new Uint8Array([0xff, 0xfe, 0x00]), limits),
      'invalid_json',
    )
  })

  test('rejects a document larger than the byte limit', () => {
    expectJsonError(
      () => parseBoundedJson(bytes('{"a":1}'), { ...limits, maxSourceBytes: 4 }),
      'response_too_large',
    )
  })

  test('enforces the nesting depth limit', () => {
    expectJsonError(
      () => parseBoundedJson(bytes('{"a":{"b":{"c":1}}}'), { ...limits, maxJsonDepth: 2 }),
      'json_limit',
    )
  })

  test('enforces the node-count limit', () => {
    expectJsonError(
      () => parseBoundedJson(bytes('[1,2,3,4,5]'), { ...limits, maxJsonNodes: 4 }),
      'json_limit',
    )
  })

  test('enforces the string-length limit on values and member names', () => {
    expectJsonError(
      () => parseBoundedJson(bytes('{"value":"abcdef"}'), { ...limits, maxJsonStringLength: 5 }),
      'json_limit',
    )
    expectJsonError(
      () => parseBoundedJson(bytes('{"abcdef":1}'), { ...limits, maxJsonStringLength: 5 }),
      'json_limit',
    )
  })

  test('rejects a __proto__ member defensively', () => {
    expectJsonError(
      () => parseBoundedJson(bytes('{"__proto__":{"polluted":true}}'), limits),
      'json_limit',
    )
  })

  test('encodes caller-supplied text under the byte limit', () => {
    expect(encodeImportText('{"a":1}', limits).byteLength).toBe(7)
    expectJsonError(
      () => encodeImportText('{"a":1}', { ...limits, maxSourceBytes: 3 }),
      'response_too_large',
    )
  })
})
