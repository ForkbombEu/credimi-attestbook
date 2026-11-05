import { describe, expect, test } from 'bun:test'

import { DEFAULT_HOSTNAME, DEFAULT_PORT, loadConfig } from './config'

describe('loadConfig', () => {
  test('uses the documented defaults', () => {
    expect(loadConfig({})).toEqual({
      hostname: DEFAULT_HOSTNAME,
      port: DEFAULT_PORT,
    })
  })

  test('reads PORT and HOST overrides', () => {
    expect(loadConfig({ PORT: '8080', HOST: '127.0.0.1' })).toEqual({
      hostname: '127.0.0.1',
      port: 8080,
    })
  })

  test('falls back to the default hostname for a blank HOST', () => {
    expect(loadConfig({ HOST: '   ' }).hostname).toBe(DEFAULT_HOSTNAME)
  })

  test.each(['0', '65536', 'abc', '', '3000.5', '-1', '00080'])(
    'rejects invalid PORT=%p',
    (port) => {
      expect(() => loadConfig({ PORT: port })).toThrow('invalid PORT')
    },
  )
})
