import { describe, expect, test } from 'vitest'

import { DIMENSION_DEFINITIONS } from '../../src/validation/dimensions'
import {
  EVALUATION_SUPPORT,
  EVALUATION_SUPPORT_LABELS,
  RULEBOOK_COMPATIBILITY_DISCLOSURE,
} from './compatibility'

describe('standards compatibility disclosure', () => {
  test('covers every FR-010 dimension in the normative order', () => {
    expect(EVALUATION_SUPPORT.map((dimension) => dimension.id)).toEqual(
      DIMENSION_DEFINITIONS.map((definition) => definition.id),
    )
    expect(EVALUATION_SUPPORT.map((dimension) => dimension.title)).toEqual(
      DIMENSION_DEFINITIONS.map((definition) => definition.title),
    )
  })

  test('marks exactly the implemented dimensions as supported', () => {
    for (const definition of DIMENSION_DEFINITIONS) {
      const disclosed = EVALUATION_SUPPORT.find((dimension) => dimension.id === definition.id)
      expect(disclosed, definition.id).toBeDefined()
      if (definition.implemented) {
        expect(disclosed?.support, definition.id).toBe('supported')
      } else if (definition.applicability === 'not_applicable') {
        expect(disclosed?.support, definition.id).toBe('not_applicable')
      } else {
        expect(disclosed?.support, definition.id).toBe('not_tested')
      }
    }
  })

  test('labels every support state explicitly and never as a pass', () => {
    expect(Object.values(EVALUATION_SUPPORT_LABELS)).toEqual([
      'Supported per credential',
      'Not tested',
      'Not applicable',
    ])
    expect(RULEBOOK_COMPATIBILITY_DISCLOSURE).toContain(
      'No rulebook-level compatibility result is recorded.',
    )
    expect(RULEBOOK_COMPATIBILITY_DISCLOSURE).toContain('never imply')
  })
})
