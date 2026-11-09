// Reproducible baseline benchmark for repeated structural validation
// (issue #53, specification §17). Development-only: it imports the test
// fixtures, including the throwaway @owf/crypto test signer.
//
// It seeds a published rulebook at the registry's structural bounds, measures
// cold (cache cleared) and warm (cache hit) validation medians, verifies the
// documented performance budgets and prints the numbers recorded in
// docs/validation-performance.md.
//
// Usage: bun run benchmark:validation

import { cpus, platform, release } from 'node:os'

import type { CredentialValidationResult, ValidateCredentialInput } from '../src/validation/types'
import { CredentialValidator } from '../src/validation/engine'
import {
  median,
  percentile,
  VALIDATION_PERFORMANCE_BUDGETS,
} from '../src/validation/performance-budget'
import { RulebookSnapshotCache } from '../src/validation/snapshot-cache'
import {
  issueTestCredential,
  seedRepresentativeRulebook,
} from '../src/validation/test-support'
import { createRegistryFixture } from '../src/registry/test-support'

const FIXED_NOW = '2026-01-01T00:00:00.000Z'

function stableResult(
  result: CredentialValidationResult,
): Omit<CredentialValidationResult, 'validationId' | 'validatedAt'> {
  const { validationId, validatedAt, ...stable } = result
  void validationId
  void validatedAt
  return stable
}

const fixture = createRegistryFixture()
try {
  const seeded = seedRepresentativeRulebook(fixture.database, fixture.registry)
  const snapshot = fixture.registry.getRulebookVersionContent(seeded.rulebookId, seeded.version)
  if (snapshot === null) {
    throw new Error('representative fixture snapshot is missing')
  }

  const credential = await issueTestCredential()
  const input: ValidateCredentialInput = {
    rulebookId: seeded.rulebookId,
    rulebookVersion: seeded.version,
    attestationType: seeded.attestationName,
    credential,
    schemaDocuments: [],
  }

  const cache = new RulebookSnapshotCache()
  const validator = new CredentialValidator({
    source: fixture.registry,
    now: () => FIXED_NOW,
    generateId: () => 'benchmark-run',
    snapshotCache: cache,
  })

  await validator.validate(input)

  const coldRoundMedians: number[] = []
  const warmRoundMedians: number[] = []
  const warmSamples: number[] = []
  for (let round = 0; round < VALIDATION_PERFORMANCE_BUDGETS.rounds; round += 1) {
    const cold: number[] = []
    const warm: number[] = []
    for (let run = 0; run < VALIDATION_PERFORMANCE_BUDGETS.runsPerRound; run += 1) {
      cache.clear()
      let started = performance.now()
      const coldResult = await validator.validate(input)
      cold.push(performance.now() - started)

      started = performance.now()
      const warmResult = await validator.validate(input)
      warm.push(performance.now() - started)
      if (JSON.stringify(stableResult(warmResult)) !== JSON.stringify(stableResult(coldResult))) {
        throw new Error('the cache changed the validation evidence')
      }
    }
    coldRoundMedians.push(median(cold))
    warmRoundMedians.push(median(warm))
    warmSamples.push(...warm)
  }

  const coldMedian = Math.min(...coldRoundMedians)
  const warmMedian = Math.min(...warmRoundMedians)
  const warmP95 = percentile(warmSamples, 0.95)
  const stats = cache.stats()
  const ratio = warmMedian / coldMedian
  const cpu = cpus()[0]?.model.trim() ?? 'unknown CPU'

  console.log('AttestBook validation baseline (#53, specification §17)')
  console.log(`runtime: Bun ${Bun.version} on ${platform()} ${release()} x64, ${cpu}`)
  console.log(
    `snapshot: ${snapshot.bytes.byteLength.toLocaleString()} bytes (${(snapshot.bytes.byteLength / 2 ** 20).toFixed(2)} MiB), ` +
      `${seeded.attestationName} attestation type, no schema documents`,
  )
  console.log(
    `samples: ${VALIDATION_PERFORMANCE_BUDGETS.rounds} rounds x ${VALIDATION_PERFORMANCE_BUDGETS.runsPerRound} cold/warm pairs`,
  )
  console.log('')
  console.log('round   cold median (ms)   warm median (ms)')
  coldRoundMedians.forEach((value, index) => {
    console.log(
      `${String(index + 1).padStart(5)}   ${value.toFixed(2).padStart(16)}   ${warmRoundMedians[index]?.toFixed(2).padStart(16)}`,
    )
  })
  console.log('')
  console.log(`cold median (best round): ${coldMedian.toFixed(2)} ms`)
  console.log(`warm median (best round): ${warmMedian.toFixed(2)} ms`)
  console.log(`warm p95:                 ${warmP95.toFixed(2)} ms`)
  console.log(`warm/cold median ratio:   ${ratio.toFixed(3)}`)
  console.log(
    `cache: ${stats.entries} ${stats.entries === 1 ? 'entry' : 'entries'}, ${stats.bytes} bytes, ` +
      `${stats.hits} hits, ${stats.misses} misses, ${stats.evictions} evictions`,
  )
  console.log('')

  const failures: string[] = []
  if (coldMedian > VALIDATION_PERFORMANCE_BUDGETS.coldMedianMs) {
    failures.push(
      `cold median ${coldMedian.toFixed(2)} ms exceeds ${VALIDATION_PERFORMANCE_BUDGETS.coldMedianMs} ms`,
    )
  }
  if (warmMedian > VALIDATION_PERFORMANCE_BUDGETS.warmMedianMs) {
    failures.push(
      `warm median ${warmMedian.toFixed(2)} ms exceeds ${VALIDATION_PERFORMANCE_BUDGETS.warmMedianMs} ms`,
    )
  }
  if (warmP95 > VALIDATION_PERFORMANCE_BUDGETS.warmP95Ms) {
    failures.push(
      `warm p95 ${warmP95.toFixed(2)} ms exceeds ${VALIDATION_PERFORMANCE_BUDGETS.warmP95Ms} ms`,
    )
  }
  if (ratio > VALIDATION_PERFORMANCE_BUDGETS.warmToColdMedianRatio) {
    failures.push(
      `warm/cold ratio ${ratio.toFixed(3)} exceeds ${VALIDATION_PERFORMANCE_BUDGETS.warmToColdMedianRatio}`,
    )
  }
  if (stats.bytes > VALIDATION_PERFORMANCE_BUDGETS.cacheMaxBytes) {
    failures.push(`cache bytes ${stats.bytes} exceed ${VALIDATION_PERFORMANCE_BUDGETS.cacheMaxBytes}`)
  }

  if (failures.length > 0) {
    console.error('performance budget FAILED:')
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    process.exitCode = 1
  } else {
    console.log('performance budgets: PASS')
  }
} finally {
  fixture.cleanup()
}
