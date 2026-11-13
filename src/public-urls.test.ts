import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  credentialSchemaDocumentPath,
  credentialSchemaDocumentUrl,
  parsePublicBaseUrl,
  sha256Sri,
} from './public-urls'

describe('parsePublicBaseUrl', () => {
  test('returns null for an absent or blank value', () => {
    expect(parsePublicBaseUrl(undefined)).toBeNull()
    expect(parsePublicBaseUrl('')).toBeNull()
    expect(parsePublicBaseUrl('   ')).toBeNull()
  })

  test('normalizes a HTTPS origin and strips the redundant default port', () => {
    expect(parsePublicBaseUrl('https://AttestBook.Example:443/')).toBe('https://attestbook.example')
    expect(parsePublicBaseUrl(' https://schemas.example:8443 ')).toBe(
      'https://schemas.example:8443',
    )
  })

  test('allows plain http only for loopback hosts', () => {
    expect(parsePublicBaseUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(parsePublicBaseUrl('http://localhost:3000')).toBe('http://localhost:3000')
    expect(parsePublicBaseUrl('http://[::1]:3000')).toBe('http://[::1]:3000')
    expect(() => parsePublicBaseUrl('http://schemas.example')).toThrow(
      'invalid PUBLIC_BASE_URL: a public origin must use https',
    )
  })

  test.each([
    'ftp://schemas.example',
    'schemas.example',
    '/schemas',
    'https://user:secret@schemas.example',
    'https://schemas.example/prefix',
    'https://schemas.example/prefix/',
    'https://schemas.example?query=1',
    'https://schemas.example#fragment',
    'https://0.0.0.0:3000',
    'https://[::]:3000',
  ])('rejects %p without echoing credentials', (value) => {
    let message = ''
    try {
      parsePublicBaseUrl(value)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('invalid PUBLIC_BASE_URL')
    expect(message).not.toContain('secret')
  })
})

describe('canonical hosted schema URLs', () => {
  test('uses one stable, permanent content path per opaque document id', () => {
    expect(credentialSchemaDocumentPath('3f2f0a1e-6f8a-4c79-9ec1-5f1f9d5e1a2b')).toBe(
      '/api/v1/schema-documents/3f2f0a1e-6f8a-4c79-9ec1-5f1f9d5e1a2b/content',
    )
    expect(credentialSchemaDocumentPath('a b/c?d')).toBe(
      '/api/v1/schema-documents/a%20b%2Fc%3Fd/content',
    )
  })

  test('composes the absolute URL from the trusted origin only', () => {
    expect(credentialSchemaDocumentUrl('https://schemas.example', 'doc-1')).toBe(
      'https://schemas.example/api/v1/schema-documents/doc-1/content',
    )
  })
})

describe('sha256Sri', () => {
  test('matches the W3C SRI form of the exact bytes', () => {
    const bytes = new TextEncoder().encode('hello')
    const hex = createHash('sha256').update(bytes).digest('hex')
    expect(sha256Sri(hex)).toBe('sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=')
  })
})
