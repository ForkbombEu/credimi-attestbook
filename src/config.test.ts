import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_DATABASE_PATH,
  DEFAULT_HOSTNAME,
  DEFAULT_PORT,
  DEFAULT_SCHEMA_SANDBOX_CONCURRENCY,
  DEFAULT_SCHEMA_SANDBOX_MAX_RSS_MB,
  DEFAULT_SCHEMA_SANDBOX_TIMEOUT_MS,
  DEFAULT_VALIDATION_CACHE_MAX_ENTRIES,
  DEFAULT_VALIDATION_CACHE_MAX_MB,
  loadConfig,
} from './config'

const DEFAULTS = {
  hostname: DEFAULT_HOSTNAME,
  port: DEFAULT_PORT,
  databasePath: DEFAULT_DATABASE_PATH,
  schemaSandboxTimeoutMs: DEFAULT_SCHEMA_SANDBOX_TIMEOUT_MS,
  schemaSandboxMaxRssMb: DEFAULT_SCHEMA_SANDBOX_MAX_RSS_MB,
  schemaSandboxConcurrency: DEFAULT_SCHEMA_SANDBOX_CONCURRENCY,
  validationCacheMaxEntries: DEFAULT_VALIDATION_CACHE_MAX_ENTRIES,
  validationCacheMaxMb: DEFAULT_VALIDATION_CACHE_MAX_MB,
}

describe('loadConfig', () => {
  test('uses the documented defaults', () => {
    expect(loadConfig({})).toEqual(DEFAULTS)
  })

  test('reads PORT, HOST, DATABASE_PATH and sandbox overrides', () => {
    expect(
      loadConfig({
        PORT: '8080',
        HOST: '127.0.0.1',
        DATABASE_PATH: '/tmp/attestbook.sqlite',
        SCHEMA_SANDBOX_TIMEOUT_MS: '1500',
        SCHEMA_SANDBOX_MAX_RSS_MB: '128',
        SCHEMA_SANDBOX_CONCURRENCY: '1',
        VALIDATION_CACHE_MAX_ENTRIES: '8',
        VALIDATION_CACHE_MAX_MB: '4',
      }),
    ).toEqual({
      hostname: '127.0.0.1',
      port: 8080,
      databasePath: '/tmp/attestbook.sqlite',
      schemaSandboxTimeoutMs: 1500,
      schemaSandboxMaxRssMb: 128,
      schemaSandboxConcurrency: 1,
      validationCacheMaxEntries: 8,
      validationCacheMaxMb: 4,
    })
  })

  test('falls back to the default hostname for a blank HOST', () => {
    expect(loadConfig({ HOST: '   ' }).hostname).toBe(DEFAULT_HOSTNAME)
  })

  test('falls back to the default database path for a blank DATABASE_PATH', () => {
    expect(loadConfig({ DATABASE_PATH: '   ' }).databasePath).toBe(DEFAULT_DATABASE_PATH)
    expect(loadConfig({ DATABASE_PATH: ':memory:' }).databasePath).toBe(':memory:')
  })

  test('rejects a DATABASE_PATH with a NUL character', () => {
    expect(() => loadConfig({ DATABASE_PATH: 'bad\0path' })).toThrow('invalid DATABASE_PATH')
  })

  test('falls back to sandbox defaults for a blank value', () => {
    expect(loadConfig({ SCHEMA_SANDBOX_TIMEOUT_MS: '   ' })).toEqual(DEFAULTS)
  })

  test.each([
    ['SCHEMA_SANDBOX_TIMEOUT_MS', '0'],
    ['SCHEMA_SANDBOX_TIMEOUT_MS', '-1'],
    ['SCHEMA_SANDBOX_TIMEOUT_MS', '1.5'],
    ['SCHEMA_SANDBOX_TIMEOUT_MS', 'abc'],
    ['SCHEMA_SANDBOX_MAX_RSS_MB', '0'],
    ['SCHEMA_SANDBOX_MAX_RSS_MB', '12.5'],
    ['SCHEMA_SANDBOX_CONCURRENCY', '0'],
    ['SCHEMA_SANDBOX_CONCURRENCY', 'x'],
    ['VALIDATION_CACHE_MAX_ENTRIES', '0'],
    ['VALIDATION_CACHE_MAX_ENTRIES', '2.5'],
    ['VALIDATION_CACHE_MAX_MB', '0'],
    ['VALIDATION_CACHE_MAX_MB', 'x'],
  ])('rejects invalid %s=%p', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(`invalid ${name}`)
  })

  test.each(['0', '65536', 'abc', '', '3000.5', '-1', '00080'])(
    'rejects invalid PORT=%p',
    (port) => {
      expect(() => loadConfig({ PORT: port })).toThrow('invalid PORT')
    },
  )
})
