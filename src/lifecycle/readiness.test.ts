// Publication readiness tests (issue #41).
//
// Readiness must never claim more than the executed checks: a stale draft, a
// corrupted artifact, a non-draft status or content that fails validation make
// the version not ready, while an unverified profile is an explicit warning.

import { describe, expect, test } from 'bun:test'

import { sha256Hex } from '../registry/digest'
import type { PublicationStatus, RulebookVersion } from '../registry/types'
import { serializeRulebookVersion, type RulebookVersionDocument } from '../registry/versioning'

import { assessPublicationReadiness } from './readiness'

function snapshot(overrides: Partial<RulebookVersionDocument> = {}): RulebookVersionDocument {
  return {
    format: 'attestbook.rulebook-version@1',
    rulebookId: 'rulebook-1',
    version: '1.0',
    specVersion: 'ts11@1.0.1',
    name: 'PID Rulebook',
    description: 'Person identification data.',
    sourceUrl: 'https://issuer.example.org/rulebooks/pid',
    attestations: [
      {
        name: 'Person Identification Data',
        attestationLoS: 'iso_18045_high',
        bindingType: 'key',
        supportedFormats: ['dc+sd-jwt'],
        schemaReferences: [
          {
            formatIdentifier: 'dc+sd-jwt',
            uri: 'https://issuer.example.org/schemas/pid',
            integrity: null,
          },
        ],
      },
    ],
    schemaReferences: [],
    ...overrides,
  }
}

function record(
  document: RulebookVersionDocument,
  overrides: Partial<RulebookVersion> = {},
): RulebookVersion {
  return {
    id: 'version-1',
    rulebookId: 'rulebook-1',
    version: document.version,
    status: 'draft',
    contentDigest: sha256Hex(serializeRulebookVersion(document)),
    specVersion: document.specVersion,
    provenance: {},
    createdAt: '2026-01-02T00:00:00.000Z',
    publishedAt: null,
    ...overrides,
  }
}

function assess(
  document: RulebookVersionDocument,
  options: {
    readonly version?: Partial<RulebookVersion>
    readonly current?: RulebookVersionDocument
    readonly rulebookStatus?: PublicationStatus
  } = {},
) {
  return assessPublicationReadiness({
    version: record(document, options.version),
    rulebookStatus: options.rulebookStatus ?? 'draft',
    bytes: serializeRulebookVersion(document),
    currentBytes: serializeRulebookVersion(options.current ?? document),
    document,
  })
}

function statusOf(
  result: ReturnType<typeof assessPublicationReadiness>,
  id: string,
): string | undefined {
  return result.checks.find((check) => check.id === id)?.status
}

describe('publication readiness', () => {
  test('a fresh, valid draft version is ready', () => {
    const result = assess(snapshot())

    expect(result.ready).toBe(true)
    expect(result.checks.map((check) => check.status)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
    ])
    expect(result.limitations.length).toBeGreaterThan(0)
  })

  test('a draft on an already-published rulebook is not ready', () => {
    for (const status of ['published', 'historical'] as const) {
      const result = assess(snapshot(), { rulebookStatus: status })

      expect(result.ready).toBe(false)
      expect(statusOf(result, 'rulebook_status')).toBe('fail')
      expect(result.checks.filter((check) => check.status === 'fail')).toHaveLength(1)
    }
  })

  test('a stale draft snapshot blocks publication until it is refreshed', () => {
    const result = assess(snapshot(), {
      current: snapshot({ description: 'Changed after the snapshot.' }),
    })

    expect(result.ready).toBe(false)
    expect(statusOf(result, 'snapshot_current')).toBe('fail')
    expect(statusOf(result, 'snapshot_integrity')).toBe('pass')
  })

  test('a published or historical version cannot be published again', () => {
    for (const status of ['published', 'historical'] as const) {
      const result = assess(snapshot(), { version: { status } })

      expect(result.ready).toBe(false)
      expect(statusOf(result, 'draft_version')).toBe('fail')
      expect(statusOf(result, 'snapshot_current')).toBe('not_applicable')
    }
  })

  test('a corrupted artifact fails the digest check', () => {
    const document = snapshot()
    const result = assessPublicationReadiness({
      version: record(document, { contentDigest: 'f'.repeat(64) }),
      rulebookStatus: 'draft',
      bytes: serializeRulebookVersion(document),
      currentBytes: serializeRulebookVersion(document),
      document,
    })

    expect(result.ready).toBe(false)
    expect(statusOf(result, 'snapshot_integrity')).toBe('fail')
  })

  test('a rulebook without an attestation type is not publishable', () => {
    const result = assess(snapshot({ attestations: [] }))

    expect(result.ready).toBe(false)
    expect(statusOf(result, 'attestation_types')).toBe('fail')
  })

  test('content that fails the standards checks is not publishable', () => {
    const document = snapshot()
    const attestation = document.attestations[0]
    if (attestation === undefined) {
      throw new Error('the fixture must define an attestation type')
    }
    const invalid = snapshot({
      attestations: [attestation, { ...attestation }],
    })
    const result = assess(invalid)

    expect(result.ready).toBe(false)
    expect(statusOf(result, 'content_valid')).toBe('fail')
    expect(result.checks.find((check) => check.id === 'content_valid')?.message).toContain(
      'validation error',
    )
  })

  test('an unsupported profile is a warning, never a silent pass', () => {
    const result = assess(snapshot({ specVersion: 'owf@0.5.4' }))

    expect(statusOf(result, 'standards_profile')).toBe('warn')
    expect(result.ready).toBe(true)
    expect(result.checks.find((check) => check.id === 'standards_profile')?.message).toContain(
      'owf@0.5.4',
    )
  })
})
