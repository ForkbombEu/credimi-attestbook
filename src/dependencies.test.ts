import { describe, expect, test } from 'bun:test'

import applicationPackage from '../package.json'

// AttestBook must remain standalone: it may not acquire a Credimi runtime or
// the orchestration stack Credimi uses (specification §4, AGENTS.md project
// constraints). Dev-only tooling is checked separately by review.
const FORBIDDEN_RUNTIME_DEPENDENCIES = [
  /^@credimi\//i,
  /^credimi/i,
  /temporal/i,
  /stepci/i,
  /pocketbase/i,
]

describe('runtime dependency boundary', () => {
  test('has no Credimi, Temporal, StepCI or PocketBase runtime dependency', () => {
    const runtimeDependencies = Object.keys(applicationPackage.dependencies)

    for (const dependency of runtimeDependencies) {
      const forbidden = FORBIDDEN_RUNTIME_DEPENDENCIES.some((pattern) => pattern.test(dependency))

      expect({ dependency, forbidden }).toEqual({ dependency, forbidden: false })
    }
  })
})
