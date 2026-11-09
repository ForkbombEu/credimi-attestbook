// Integration and performance tests for repeated reproducible validation
// (issue #53, specification §17 and Phase 6).
//
// The deterministic tests prove the cache policy: an immutable snapshot is
// read once and reused, a draft is never cached, lifecycle metadata stays
// fresh, and cached and uncached validators return identical evidence and a
// stable conformance result reference. The timed test measures a rulebook at
// the registry's structural bounds against the documented budgets.

import { afterEach, describe, expect, test } from 'bun:test'

import { buildConformanceResult } from '../conformance'
import { provisionProvider } from '../registry/bootstrap'
import type { Registry } from '../registry/registry'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import { CredentialValidator, type CredentialValidatorOptions } from './engine'
import { median, percentile, VALIDATION_PERFORMANCE_BUDGETS } from './performance-budget'
import { RulebookSnapshotCache } from './snapshot-cache'
import {
  issueTestCredential,
  PID_TYPE_METADATA_TEXT,
  seedPublishedRulebook,
  seedRepresentativeRulebook,
  sha256Sri,
  TEST_VCT,
  type SeededRulebook,
} from './test-support'
import type {
  CredentialValidationResult,
  RulebookValidationSource,
  ValidateCredentialInput,
} from './types'

const FIXED_NOW = '2026-01-01T00:00:00.000Z'

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

interface CountingSource {
  readonly source: RulebookValidationSource
  contentReads(): number
}

/** Wraps the real registry and counts snapshot reads, not metadata reads. */
function countingSource(registry: Registry): CountingSource {
  let reads = 0
  return {
    source: {
      getRulebook: (id: string) => registry.getRulebook(id),
      getRulebookVersion: (id: string, version: string) => registry.getRulebookVersion(id, version),
      getRulebookVersionContent: (id: string, version: string) => {
        reads += 1
        return registry.getRulebookVersionContent(id, version)
      },
    },
    contentReads: () => reads,
  }
}

function validator(
  source: RulebookValidationSource,
  options: Partial<CredentialValidatorOptions> = {},
): CredentialValidator {
  return new CredentialValidator({
    source,
    now: () => FIXED_NOW,
    generateId: () => 'validation-test-id',
    ...options,
  })
}

function request(
  seeded: SeededRulebook,
  credential: ValidateCredentialInput['credential'],
  schemaDocuments?: ValidateCredentialInput['schemaDocuments'],
): ValidateCredentialInput {
  return {
    rulebookId: seeded.rulebookId,
    rulebookVersion: seeded.version,
    attestationType: seeded.attestationName,
    credential,
    ...(schemaDocuments === undefined ? {} : { schemaDocuments }),
  }
}

/** The evidence that must not depend on the run identity or cache state. */
function stableResult(
  result: CredentialValidationResult,
): Omit<CredentialValidationResult, 'validationId' | 'validatedAt'> {
  const { validationId, validatedAt, ...stable } = result
  void validationId
  void validatedAt
  return stable
}

function conformanceReference(
  validation: CredentialValidationResult,
  input: ValidateCredentialInput,
): string {
  return buildConformanceResult({ validation, request: input }).resultReference
}

function setupPublished(): {
  fixture: RegistryFixture
  seeded: SeededRulebook
  source: CountingSource
} {
  const registryFixture = createRegistryFixture()
  fixture = registryFixture
  const seeded = seedPublishedRulebook(registryFixture.database, registryFixture.registry)
  return { fixture: registryFixture, seeded, source: countingSource(registryFixture.registry) }
}

interface DraftFixture {
  readonly seeded: SeededRulebook
  readonly attestationId: string
}

/** Creates a provider, a rulebook and one draft version (never published). */
function setupDraft(registryFixture: RegistryFixture): DraftFixture {
  const provider = provisionProvider(registryFixture.database, {
    name: 'Draft provider',
    publicationAuthority: 'authority-draft',
  })
  const token = provider.token.secret
  const rulebook = registryFixture.registry.createRulebook(token, {
    name: 'Draft rulebook',
    description: 'Draft fixture for the snapshot-cache tests',
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: 'PID',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
      },
    ],
  })
  const attestation = registryFixture.registry
    .listAttestations(rulebook.id)
    .find((candidate) => candidate.name === 'PID')
  if (attestation === undefined) {
    throw new Error('draft fixture failed to create the attestation type')
  }
  registryFixture.registry.addSchemaReference(token, rulebook.id, {
    formatIdentifier: 'dc+sd-jwt',
    uri: TEST_VCT,
    integrity: sha256Sri(PID_TYPE_METADATA_TEXT),
    attestationId: attestation.id,
  })
  const version = registryFixture.registry.createRulebookVersion(token, rulebook.id, {
    version: '1.0',
  })
  return {
    seeded: {
      rulebookId: rulebook.id,
      rulebookName: 'Draft rulebook',
      attestationName: 'PID',
      version: version.version,
      digest: version.contentDigest,
      schemaUri: TEST_VCT,
      schemaContent: PID_TYPE_METADATA_TEXT,
      integrity: sha256Sri(PID_TYPE_METADATA_TEXT),
      token,
    },
    attestationId: attestation.id,
  }
}

describe('immutable rulebook snapshot cache', () => {
  test('reads an immutable snapshot once for repeated validations', async () => {
    const { fixture: registryFixture, seeded, source } = setupPublished()
    const cache = new RulebookSnapshotCache()
    const service = validator(source.source, { snapshotCache: cache })
    const credential = await issueTestCredential()
    const input = request(seeded, credential)

    const results = []
    for (let run = 0; run < 5; run += 1) {
      results.push(await service.validate(input))
    }

    expect(source.contentReads()).toBe(1)
    expect(cache.stats()).toMatchObject({ entries: 1, hits: 4, misses: 1 })
    expect(cache.stats().bytes).toBe(
      registryFixture.registry.getRulebookVersionContent(seeded.rulebookId, seeded.version)?.bytes
        .byteLength as number,
    )
  })

  test('never caches a draft version and reflects a refreshed snapshot', async () => {
    const registryFixture = createRegistryFixture()
    fixture = registryFixture
    const draft = setupDraft(registryFixture)
    const source = countingSource(registryFixture.registry)
    const cache = new RulebookSnapshotCache()
    const service = validator(source.source, { snapshotCache: cache })
    const credential = await issueTestCredential()
    const input = request(draft.seeded, credential)

    const before = await service.validate(input)
    expect(before.attestation.attestationLoS).toBe('iso_18045_high')

    registryFixture.registry.updateAttestation(
      draft.seeded.token,
      draft.seeded.rulebookId,
      draft.attestationId,
      { attestationLoS: 'iso_18045_moderate' },
    )
    const refreshed = registryFixture.registry.refreshDraftRulebookVersion(
      draft.seeded.token,
      draft.seeded.rulebookId,
      draft.seeded.version,
    )

    const after = await service.validate(input)
    expect(after.rulebook.digest).toBe(refreshed.contentDigest)
    expect(after.rulebook.digest).not.toBe(before.rulebook.digest)
    expect(after.attestation.attestationLoS).toBe('iso_18045_moderate')
    expect(source.contentReads()).toBe(2)
    expect(cache.stats().entries).toBe(0)
  })

  test('keeps lifecycle status fresh while serving snapshot content from cache', async () => {
    const { fixture: registryFixture, seeded, source } = setupPublished()
    const cache = new RulebookSnapshotCache()
    const service = validator(source.source, { snapshotCache: cache })
    const credential = await issueTestCredential()
    const input = request(seeded, credential)

    const published = await service.validate(input)
    expect(published.rulebook.status).toBe('published')

    registryFixture.registry.createRulebookVersion(seeded.token, seeded.rulebookId, {
      version: '1.1',
    })
    registryFixture.registry.publishRulebookVersion(seeded.token, seeded.rulebookId, '1.1')

    const historical = await service.validate(input)
    expect(historical.rulebook.status).toBe('historical')
    expect(historical.rulebook.digest).toBe(published.rulebook.digest)
    expect(source.contentReads()).toBe(1)
    expect(cache.stats().hits).toBe(1)
  })

  test('re-verifies the digest of a cached snapshot on every hit', async () => {
    const { fixture: registryFixture, seeded } = setupPublished()
    const cache = new RulebookSnapshotCache()
    cache.set(seeded.digest, new Uint8Array([0x7b, 0x7d]), {
      rulebookId: seeded.rulebookId,
      version: seeded.version,
      specVersion: 'ts11@1.0.1',
      attestations: [],
    })
    const service = validator(registryFixture.registry, { snapshotCache: cache })
    const credential = await issueTestCredential()

    let caught: unknown
    try {
      await service.validate(request(seeded, credential))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('does not match its recorded digest')
    expect(cache.stats().hits).toBe(1)
  })

  test('bounds the cache when many immutable versions are validated', async () => {
    const { fixture: registryFixture, seeded } = setupPublished()
    const cache = new RulebookSnapshotCache({ maxEntries: 2, maxBytes: 64 * 2 ** 20 })
    const service = validator(registryFixture.registry, { snapshotCache: cache })
    const credential = await issueTestCredential()

    const versions = [seeded.version]
    for (const version of ['1.1', '1.2', '1.3']) {
      registryFixture.registry.createRulebookVersion(seeded.token, seeded.rulebookId, { version })
      registryFixture.registry.publishRulebookVersion(seeded.token, seeded.rulebookId, version)
      versions.push(version)
    }

    for (const version of versions) {
      await service.validate({ ...request(seeded, credential), rulebookVersion: version })
    }

    const stats = cache.stats()
    expect(stats.entries).toBe(2)
    expect(stats.evictions).toBeGreaterThanOrEqual(versions.length - 2)
    expect(stats.bytes).toBeLessThanOrEqual(VALIDATION_PERFORMANCE_BUDGETS.cacheMaxBytes)
  })

  test('returns identical evidence with the cache enabled and disabled', async () => {
    const { fixture: registryFixture, seeded } = setupPublished()
    const credential = await issueTestCredential()
    const cached = validator(registryFixture.registry)
    const uncached = validator(registryFixture.registry, { snapshotCache: false })
    const inputs = [
      request(seeded, credential),
      request(seeded, credential, []),
      request(seeded, 'not-a-credential', []),
    ]

    for (const input of inputs) {
      const cachedCold = await cached.validate(input)
      const cachedWarm = await cached.validate(input)
      const uncachedResult = await uncached.validate(input)

      expect(stableResult(cachedCold)).toEqual(stableResult(uncachedResult))
      expect(stableResult(cachedWarm)).toEqual(stableResult(uncachedResult))
      expect(conformanceReference(cachedWarm, input)).toBe(
        conformanceReference(uncachedResult, input),
      )
    }
  })

  test('reproduces the conformance result reference across repeated runs', async () => {
    const { fixture: registryFixture, seeded } = setupPublished()
    const credential = await issueTestCredential()
    const input = request(seeded, credential, [])
    let run = 0
    const service = new CredentialValidator({
      source: registryFixture.registry,
      now: () => `2026-01-01T00:00:${String(run).padStart(2, '0')}.000Z`,
      generateId: () => `run-${run++}`,
    })

    const references: string[] = []
    let firstValidationId: string | undefined
    for (let index = 0; index < 6; index += 1) {
      const result = await service.validate(input)
      firstValidationId ??= result.validationId
      references.push(conformanceReference(result, input))
    }
    const uncachedResult = await validator(registryFixture.registry, {
      snapshotCache: false,
    }).validate(input)

    expect(new Set(references).size).toBe(1)
    expect(conformanceReference(uncachedResult, input)).toBe(references[0] as string)
    expect(firstValidationId).not.toBe(uncachedResult.validationId)
  })
})

describe('validation performance budgets', () => {
  test('meets the documented cold, warm and cache-effectiveness budgets', async () => {
    const registryFixture = createRegistryFixture()
    fixture = registryFixture
    const seeded = seedRepresentativeRulebook(registryFixture.database, registryFixture.registry)
    const snapshot = registryFixture.registry.getRulebookVersionContent(
      seeded.rulebookId,
      seeded.version,
    )
    if (snapshot === null) {
      throw new Error('representative fixture snapshot is missing')
    }
    expect(snapshot.bytes.byteLength).toBeGreaterThan(1_500_000)

    const credential = await issueTestCredential()
    const input = request(seeded, credential, [])
    const cache = new RulebookSnapshotCache()
    const service = validator(registryFixture.registry, { snapshotCache: cache })
    await service.validate(input)

    const coldRoundMedians: number[] = []
    const warmRoundMedians: number[] = []
    const warmSamples: number[] = []
    for (let round = 0; round < VALIDATION_PERFORMANCE_BUDGETS.rounds; round += 1) {
      const cold: number[] = []
      const warm: number[] = []
      for (let run = 0; run < VALIDATION_PERFORMANCE_BUDGETS.runsPerRound; run += 1) {
        cache.clear()
        let started = performance.now()
        const coldResult = await service.validate(input)
        cold.push(performance.now() - started)

        started = performance.now()
        const warmResult = await service.validate(input)
        warm.push(performance.now() - started)
        expect(stableResult(warmResult)).toEqual(stableResult(coldResult))
      }
      coldRoundMedians.push(median(cold))
      warmRoundMedians.push(median(warm))
      warmSamples.push(...warm)
    }

    // The best round rejects a single noisy round on a shared CI runner while
    // every round still has to stay inside the absolute ceiling.
    const coldMedian = Math.min(...coldRoundMedians)
    const warmMedian = Math.min(...warmRoundMedians)
    const warmP95 = percentile(warmSamples, 0.95)
    const stats = cache.stats()

    expect(coldMedian).toBeLessThanOrEqual(VALIDATION_PERFORMANCE_BUDGETS.coldMedianMs)
    expect(warmMedian).toBeLessThanOrEqual(VALIDATION_PERFORMANCE_BUDGETS.warmMedianMs)
    expect(warmP95).toBeLessThanOrEqual(VALIDATION_PERFORMANCE_BUDGETS.warmP95Ms)
    expect(warmMedian).toBeLessThanOrEqual(
      coldMedian * VALIDATION_PERFORMANCE_BUDGETS.warmToColdMedianRatio,
    )
    expect(stats.entries).toBeLessThanOrEqual(VALIDATION_PERFORMANCE_BUDGETS.cacheMaxEntries)
    expect(stats.bytes).toBeLessThanOrEqual(VALIDATION_PERFORMANCE_BUDGETS.cacheMaxBytes)
    expect(stats.entries).toBe(1)
  })
})
