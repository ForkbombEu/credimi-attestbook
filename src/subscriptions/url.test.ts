import { describe, expect, test } from 'bun:test'

import { isSubscriptionError } from './errors'
import { parseSubscriptionCallbackUrl } from './url'

const OPTIONS = { maxLength: 2_048, allowLoopbackHttp: false }

function parse(value: unknown, allowLoopbackHttp = false): string {
  return parseSubscriptionCallbackUrl(value, { ...OPTIONS, allowLoopbackHttp })
}

function parseError(value: unknown, allowLoopbackHttp = false): string {
  try {
    parse(value, allowLoopbackHttp)
  } catch (error) {
    if (isSubscriptionError(error)) {
      return error.code
    }
    throw error
  }
  throw new Error('expected the callback URL to be rejected')
}

describe('subscription callback URL validation', () => {
  test('accepts and normalizes a public HTTPS URL', () => {
    expect(parse('https://Subscriber.Example.Test:443/webhook?token=abc')).toBe(
      'https://subscriber.example.test/webhook?token=abc',
    )
    expect(parse('https://subscriber.example.test')).toBe('https://subscriber.example.test/')
    expect(parse('https://subscriber.example.test:8443/hook')).toBe(
      'https://subscriber.example.test:8443/hook',
    )
  })

  test('rejects non-string, empty, padded and oversized values', () => {
    expect(parseError(undefined)).toBe('invalid_input')
    expect(parseError(42)).toBe('invalid_input')
    expect(parseError('')).toBe('invalid_input')
    expect(parseError(' https://subscriber.example.test/hook')).toBe('invalid_input')
    expect(parseError('https://subscriber.example.test/hook ')).toBe('invalid_input')
    expect(parseError(`https://subscriber.example.test/${'a'.repeat(OPTIONS.maxLength)}`)).toBe(
      'invalid_input',
    )
  })

  test('rejects non-HTTPS schemes, including cloud metadata over plain http', () => {
    expect(parseError('http://169.254.169.254/latest/meta-data/')).toBe('invalid_input')
    expect(parseError('http://subscriber.example.test/hook')).toBe('invalid_input')
    expect(parseError('ftp://subscriber.example.test/hook')).toBe('invalid_input')
    expect(parseError('javascript:alert(1)')).toBe('invalid_input')
  })

  test('rejects embedded credentials, fragments and ambiguous raw syntax', () => {
    expect(parseError('https://user:secret@subscriber.example.test/hook')).toBe('invalid_input')
    expect(parseError('https://user@subscriber.example.test/hook')).toBe('invalid_input')
    expect(parseError('https://subscriber.example.test/hook#fragment')).toBe('invalid_input')
    expect(parseError('https://subscriber.example.test/hook#')).toBe('invalid_input')
    expect(parseError('https://subscriber.example.test\\@attacker.example/hook')).toBe(
      'invalid_input',
    )
    expect(parseError('https://subscriber.example.test/hook path')).toBe('invalid_input')
    expect(parseError('https://subscriber.example.test/ünicode')).toBe('invalid_input')
    expect(parseError('https://subscriber.example.test/\u0000')).toBe('invalid_input')
    expect(parseError('https://subscriber.example.test:0/hook')).toBe('invalid_input')
    expect(parseError('not a url')).toBe('invalid_input')
  })

  test('rejects non-public, ambiguous and malformed hosts', () => {
    for (const url of [
      'https://127.0.0.1/hook',
      'https://[::1]/hook',
      'https://10.0.0.1/hook',
      'https://192.168.1.10/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://[fe80::1]/hook',
      'https://0.0.0.0/hook',
      'https://localhost/hook',
      'https://localhost.localdomain/hook',
      'https://subscriber.local/hook',
      'https://subscriber.internal/hook',
      'https://subscriber.localhost/hook',
      'https://subscriber.home.arpa/hook',
      'https://intranet/hook',
      'https://subscriber.example.test./hook',
      'https://subscriber..example.test/hook',
      'https://subscriber_example.test/hook',
      'https://-subscriber.example.test/hook',
      'https://subscriber.example.test%/hook',
    ]) {
      expect(parseError(url), url).toBe('invalid_input')
    }
  })

  test('accepts plain loopback HTTP only with the explicit test opt-in', () => {
    expect(parse('http://127.0.0.1:4321/hook', true)).toBe('http://127.0.0.1:4321/hook')
    expect(parse('http://[::1]:4321/hook', true)).toBe('http://[::1]:4321/hook')
    expect(parseError('http://127.0.0.1:4321/hook')).toBe('invalid_input')
    expect(parseError('http://localhost:4321/hook', true)).toBe('invalid_input')
    expect(parseError('http://127.0.0.2:4321/hook', true)).toBe('invalid_input')
    expect(parseError('http://192.168.1.10:4321/hook', true)).toBe('invalid_input')
    // The opt-in never turns a public HTTPS requirement into an http allowance
    // for a non-loopback host.
    expect(parseError('http://subscriber.example.test/hook', true)).toBe('invalid_input')
  })

  test('does not resolve or contact any host during validation', () => {
    // A DNS name that cannot resolve is accepted at registration time: this
    // slice performs no lookup and no outbound request. A later delivery worker
    // must resolve and pin a public address.
    expect(parse('https://subscriber.example.test/hook')).toBe(
      'https://subscriber.example.test/hook',
    )
  })
})
