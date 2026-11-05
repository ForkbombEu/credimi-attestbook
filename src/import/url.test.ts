import { describe, expect, test } from 'bun:test'

import { ImportError, type ImportErrorCode } from './errors'
import { DEFAULT_IMPORT_LIMITS } from './limits'
import { isBlockedAddress, resolveImportTarget, validateImportUrl, type HostResolver } from './url'

const limits = DEFAULT_IMPORT_LIMITS

async function expectResolveError(promise: Promise<unknown>, code: ImportErrorCode): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ImportError)
  expect((caught as ImportError).code).toBe(code)
}

function expectImportError(action: () => unknown, code: ImportErrorCode): void {
  let caught: unknown
  try {
    action()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ImportError)
  expect((caught as ImportError).code).toBe(code)
}

describe('import URL validation', () => {
  test('accepts https URLs and strips the client-side fragment', () => {
    const url = validateImportUrl('https://catalog.example.test/schemas.json#section', limits)

    expect(url.protocol).toBe('https:')
    expect(url.href).toBe('https://catalog.example.test/schemas.json')
  })

  test('accepts an explicit default https port', () => {
    expect(validateImportUrl('https://catalog.example.test:443/schemas.json', limits).href).toBe(
      'https://catalog.example.test/schemas.json',
    )
  })

  test('rejects non-https, credentialed, non-default-port and malformed URLs', () => {
    expectImportError(
      () => validateImportUrl('http://catalog.example.test/x', limits),
      'invalid_url',
    )
    expectImportError(
      () => validateImportUrl('https://user:pass@catalog.example.test/x', limits),
      'invalid_url',
    )
    expectImportError(
      () => validateImportUrl('https://catalog.example.test:8443/x', limits),
      'invalid_url',
    )
    expectImportError(() => validateImportUrl('file:///etc/passwd', limits), 'invalid_url')
    expectImportError(() => validateImportUrl('not a url', limits), 'invalid_url')
    expectImportError(() => validateImportUrl('', limits), 'invalid_url')
    expectImportError(() => validateImportUrl(42, limits), 'invalid_url')
  })

  test('rejects a URL longer than the configured limit', () => {
    expectImportError(
      () =>
        validateImportUrl(`https://catalog.example.test/${'a'.repeat(100)}`, {
          ...limits,
          maxUrlLength: 40,
        }),
      'invalid_url',
    )
  })

  test('blocks private, loopback, link-local, metadata and reserved literal addresses', () => {
    const blocked = [
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://172.16.0.1/x',
      'https://192.168.1.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/x',
      'https://0.0.0.0/x',
      'https://[::1]/x',
      'https://[fc00::1]/x',
      'https://[fe80::1]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://[2002:7f00:1::1]/x',
    ]

    for (const url of blocked) {
      expectImportError(() => validateImportUrl(url, limits), 'blocked_address')
    }
  })

  test('allows a public literal address and a normal hostname', () => {
    expect(validateImportUrl('https://93.184.216.34/x', limits).hostname).toBe('93.184.216.34')
    expect(validateImportUrl('https://catalog.example.test/x', limits).hostname).toBe(
      'catalog.example.test',
    )
  })
})

describe('address classification', () => {
  test('classifies private and reserved addresses as blocked', () => {
    for (const address of [
      '10.0.0.1',
      '127.0.0.1',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fc00::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
      '2001::1',
      '2001:10::1',
      'fec0::1',
      '64:ff9b::1',
      'not-an-address',
    ]) {
      expect(isBlockedAddress(address)).toBe(true)
    }
  })

  test('classifies public addresses as allowed', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
      expect(isBlockedAddress(address)).toBe(false)
    }
  })
})

describe('target resolution', () => {
  const resolver: HostResolver = () =>
    Promise.resolve([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ])

  test('pins a validated URL to the first public address', async () => {
    const target = await resolveImportTarget(
      new URL('https://catalog.example.test/schemas.json'),
      resolver,
    )

    expect(target.hostname).toBe('catalog.example.test')
    expect(target.address).toBe('93.184.216.34')
    expect(target.family).toBe(4)
    expect(target.port).toBe(443)
  })

  test('rejects a hostname with a private answer even when a public answer also exists', async () => {
    const mixed: HostResolver = () =>
      Promise.resolve([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ])

    await expectResolveError(
      resolveImportTarget(new URL('https://catalog.example.test/x'), mixed),
      'blocked_address',
    )
  })

  test('rejects an empty and a failed DNS answer', async () => {
    await expectResolveError(
      resolveImportTarget(new URL('https://catalog.example.test/x'), () => Promise.resolve([])),
      'dns_failure',
    )
    await expectResolveError(
      resolveImportTarget(new URL('https://catalog.example.test/x'), () =>
        Promise.reject(new Error('resolver failed')),
      ),
      'dns_failure',
    )
  })
})
