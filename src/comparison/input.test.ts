import { describe, expect, test } from 'bun:test'

import {
  MAX_EXTERNAL_WALLET_ID_LENGTH,
  MAX_EXTERNAL_WALLET_OBSERVATIONS,
  parseCompareCaptureInput,
  parseExternalWalletObservation,
} from '../comparison'

import { externalWalletObservation, TEST_WALLET_ID } from './test/fixtures'

function validObservation(): Record<string, unknown> {
  return {
    walletId: TEST_WALLET_ID,
    observedAt: '2026-01-02T03:04:30Z',
    interaction: 'issuance',
    observations: [
      { dimension: 'protocol_conformance', status: 'PASS', code: 'ok', detail: 'done' },
    ],
  }
}

describe('comparison request parsing', () => {
  test('accepts an observation for every FR-010 dimension', () => {
    const parsed = parseExternalWalletObservation(externalWalletObservation())
    expect(parsed.walletId).toBe(TEST_WALLET_ID)
    expect(parsed.interaction).toBe('issuance')
    expect(parsed.observations).toHaveLength(4)
  })

  test('treats an absent external wallet as a valid comparison request', () => {
    expect(parseCompareCaptureInput({})).toEqual({ externalWallet: null })
    expect(parseCompareCaptureInput({ externalWallet: null })).toEqual({
      externalWallet: null,
    })
  })

  test('rejects a body that is not a JSON object', () => {
    expect(() => parseCompareCaptureInput(null)).toThrow('must be a JSON object')
    expect(() => parseCompareCaptureInput([])).toThrow('must be a JSON object')
  })

  test('rejects a missing, oversized, or whitespace wallet identifier', () => {
    expect(() =>
      parseExternalWalletObservation({ ...validObservation(), walletId: undefined }),
    ).toThrow('walletId must be a string')
    expect(() =>
      parseExternalWalletObservation({
        ...validObservation(),
        walletId: 'x'.repeat(MAX_EXTERNAL_WALLET_ID_LENGTH + 1),
      }),
    ).toThrow('at most')
    expect(() =>
      parseExternalWalletObservation({ ...validObservation(), walletId: 'wallet a' }),
    ).toThrow('printable ASCII without whitespace')
  })

  test('rejects a malformed or partial observation timestamp', () => {
    for (const observedAt of ['2026-01-02', '2026-01-02T03:04:30', 'not-a-date', '']) {
      expect(() => parseExternalWalletObservation({ ...validObservation(), observedAt })).toThrow()
    }
  })

  test('rejects an unknown interaction', () => {
    expect(() =>
      parseExternalWalletObservation({ ...validObservation(), interaction: 'other' }),
    ).toThrow('interaction must be one of')
  })

  test('rejects unknown dimensions and statuses', () => {
    expect(() =>
      parseExternalWalletObservation({
        ...validObservation(),
        observations: [{ dimension: 'made_up', status: 'PASS' }],
      }),
    ).toThrow('known FR-010 validation dimension')
    expect(() =>
      parseExternalWalletObservation({
        ...validObservation(),
        observations: [{ dimension: 'protocol_conformance', status: 'MAYBE' }],
      }),
    ).toThrow('must be one of')
  })

  test('rejects an empty observation list and duplicate dimensions', () => {
    expect(() =>
      parseExternalWalletObservation({ ...validObservation(), observations: [] }),
    ).toThrow('at least one observation')
    expect(() =>
      parseExternalWalletObservation({
        ...validObservation(),
        observations: [
          { dimension: 'protocol_conformance', status: 'PASS' },
          { dimension: 'protocol_conformance', status: 'FAIL' },
        ],
      }),
    ).toThrow('must not repeat the dimension')
  })

  test('rejects more observations than the FR-010 dimensions', () => {
    expect(() =>
      parseExternalWalletObservation({
        ...validObservation(),
        observations: Array.from({ length: MAX_EXTERNAL_WALLET_OBSERVATIONS + 1 }, () => ({
          dimension: 'protocol_conformance',
          status: 'PASS',
        })),
      }),
    ).toThrow('at most')
  })

  test('rejects a non-object observation and a non-object external wallet', () => {
    expect(() => parseExternalWalletObservation('nope')).toThrow(
      'externalWallet must be a JSON object',
    )
    expect(() => parseCompareCaptureInput({ externalWallet: 'nope' })).toThrow(
      'externalWallet must be a JSON object',
    )
  })

  test('bounds caller-supplied code and detail text', () => {
    expect(() =>
      parseExternalWalletObservation({
        ...validObservation(),
        observations: [
          {
            dimension: 'protocol_conformance',
            status: 'PASS',
            code: 'x'.repeat(121),
          },
        ],
      }),
    ).toThrow('at most 120 characters')
    expect(() =>
      parseExternalWalletObservation({
        ...validObservation(),
        observations: [
          {
            dimension: 'protocol_conformance',
            status: 'PASS',
            detail: 'x'.repeat(501),
          },
        ],
      }),
    ).toThrow('at most 500 characters')
  })
})
