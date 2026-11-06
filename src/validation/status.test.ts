import { describe, expect, test } from 'bun:test'

import { aggregateStatus } from './status'
import type { ValidationStatus } from './types'

const entry = (status: ValidationStatus) => ({ status })

describe('aggregateStatus', () => {
  test('an empty result has no applicable dimension', () => {
    expect(aggregateStatus([])).toBe('NOT_APPLICABLE')
  })

  test('FAIL wins over every other status', () => {
    expect(aggregateStatus([entry('PASS'), entry('FAIL'), entry('NOT_TESTED')])).toBe('FAIL')
    expect(aggregateStatus([entry('FAIL'), entry('INCONCLUSIVE')])).toBe('FAIL')
  })

  test('INCONCLUSIVE wins over NOT_TESTED and PASS', () => {
    expect(aggregateStatus([entry('PASS'), entry('INCONCLUSIVE'), entry('NOT_TESTED')])).toBe(
      'INCONCLUSIVE',
    )
  })

  test('NOT_TESTED wins over PASS', () => {
    expect(aggregateStatus([entry('PASS'), entry('NOT_TESTED')])).toBe('NOT_TESTED')
  })

  test('PASS requires every applicable dimension to pass', () => {
    expect(aggregateStatus([entry('PASS'), entry('PASS')])).toBe('PASS')
    expect(aggregateStatus([entry('PASS'), entry('NOT_APPLICABLE')])).toBe('PASS')
  })

  test('all dimensions not applicable is NOT_APPLICABLE', () => {
    expect(aggregateStatus([entry('NOT_APPLICABLE'), entry('NOT_APPLICABLE')])).toBe(
      'NOT_APPLICABLE',
    )
  })
})
