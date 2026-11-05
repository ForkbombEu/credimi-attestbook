import { describe, expect, test } from 'bun:test'

import { DEFAULT_DATABASE_PATH, DEFAULT_HOSTNAME, DEFAULT_PORT, loadConfig } from './config'

describe('loadConfig', () => {
  test('uses the documented defaults', () => {
    expect(loadConfig({})).toEqual({
      hostname: DEFAULT_HOSTNAME,
      port: DEFAULT_PORT,
      databasePath: DEFAULT_DATABASE_PATH,
    })
  })

  test('reads PORT, HOST and DATABASE_PATH overrides', () => {
    expect(
      loadConfig({
        PORT: '8080',
        HOST: '127.0.0.1',
        DATABASE_PATH: '/tmp/attestbook.sqlite',
      }),
    ).toEqual({
      hostname: '127.0.0.1',
      port: 8080,
      databasePath: '/tmp/attestbook.sqlite',
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

  test.each(['0', '65536', 'abc', '', '3000.5', '-1', '00080'])(
    'rejects invalid PORT=%p',
    (port) => {
      expect(() => loadConfig({ PORT: port })).toThrow('invalid PORT')
    },
  )
})
