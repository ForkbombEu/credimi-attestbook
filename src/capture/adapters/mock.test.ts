// Normalization, provenance and idempotency tests for the deterministic mock
// capture source (FR-018, issue #47).
//
// The mock exercises the real normalization pipeline: inline evidence is
// segregated, external references stay explicitly unverified, every result is
// labelled `mock`, and a pushed capture is idempotent by `captureId`.

import { describe, expect, test } from 'bun:test'

import { sha256Hex } from '../../registry/digest'
import { isCaptureError } from '../errors'
import { CAPTURE_ARTIFACT_TYPES } from '../types'
import { hashCaptureCredential } from './credentials'
import { CaptureAdapterError, isCaptureAdapterError, type CaptureAdapterErrorCode } from './errors'
import { mockCaptureEnvelopes } from './fixtures'
import { MockCaptureSource, type MockCaptureSourceOptions } from './mock'

const NOW = new Date('2026-11-05T09:50:00.000Z')
const TOKEN = 'att_mock-capture-test-credential'
const ACCEPTED = hashCaptureCredential(TOKEN)

type SourceOptions = Omit<
  MockCaptureSourceOptions,
  'component' | 'acceptedCredentialHashes' | 'pullCredential' | 'now'
>

function source(
  component: MockCaptureSourceOptions['component'],
  options: SourceOptions = {},
): MockCaptureSource {
  return new MockCaptureSource({
    component,
    acceptedCredentialHashes: [ACCEPTED],
    pullCredential: TOKEN,
    now: () => NOW,
    ...options,
  })
}

function envelopeBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

async function expectAdapterError(
  run: () => Promise<unknown>,
  code: CaptureAdapterErrorCode,
): Promise<CaptureAdapterError> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(CaptureAdapterError)
    expect(isCaptureAdapterError(error) ? error.code : undefined).toBe(code)
    return error as CaptureAdapterError
  }
  throw new Error(`expected the capture adapter to fail with ${code}`)
}

describe('mock capture pull adapter', () => {
  test('normalizes mock interactions for every version 1 artifact type', async () => {
    const artifactTypes = new Set<string>()
    for (const component of ['capture-issuer', 'capture-verifier'] as const) {
      const result = await source(component).pull({ maxArtifacts: 20 })
      expect(result.nextCursor).toBeNull()
      expect(result.receivedAt).toBe(NOW.toISOString())
      expect(result.artifacts.length).toBeGreaterThan(0)
      for (const artifact of result.artifacts) {
        expect(artifact.envelope.kind).toBe('attestbook.capture-artifact@1')
        expect(artifact.envelope.provenance.sourceComponent).toBe(component)
        expect(artifact.envelope.provenance.sourceVersion).toBe('0.0.0-mock')
        expect(artifact.envelope.metadata.environment).toBe('mock')
        expect(artifact.envelope.metadata.synthetic).toBe(true)
        artifactTypes.add(artifact.envelope.artifactType)
      }
    }
    expect([...artifactTypes].sort()).toEqual([...CAPTURE_ARTIFACT_TYPES].sort())
  })

  test('segregates inline evidence and leaves external references explicitly unverified', async () => {
    const { artifacts } = await source('capture-issuer').pull({ maxArtifacts: 20 })

    const inline = artifacts.find(
      (artifact) => artifact.envelope.artifactType === 'issued-credential',
    )
    expect(inline).toBeDefined()
    expect(inline?.sensitive).not.toBeNull()
    expect(inline?.envelope.integrity.verified).toBe(true)
    expect(inline?.sensitive?.digest).toBe(inline?.envelope.integrity.digest)
    const serialized = JSON.stringify(inline?.envelope)
    expect(serialized).not.toContain('synthetic-access-token-not-a-secret')
    expect(serialized).not.toContain('given_name')

    const external = artifacts.find(
      (artifact) => artifact.envelope.artifactType === 'issuer-metadata',
    )
    expect(external).toBeDefined()
    expect(external?.sensitive).toBeNull()
    expect(external?.envelope.artifactRef).not.toBeNull()
    expect(external?.envelope.integrity.verified).toBe(false)
    expect(external?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'external_artifact_integrity_unverified',
    )
  })

  test('pages through its fixtures with an opaque cursor and no repeats', async () => {
    const adapter = source('capture-issuer')
    const first = await adapter.pull({ maxArtifacts: 2 })
    expect(first.artifacts).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    expect(first.nextCursor).not.toMatch(/^\d+$/)
    expect(first.nextCursor).not.toContain('mock-cursor')

    const second = await adapter.pull({ cursor: first.nextCursor, maxArtifacts: 2 })
    expect(second.artifacts).toHaveLength(2)
    expect(second.nextCursor).toBeNull()

    const captureIds = [...first.artifacts, ...second.artifacts].map(
      (artifact) => artifact.envelope.captureId,
    )
    expect(new Set(captureIds).size).toBe(captureIds.length)
  })

  test('labels the source as mock', async () => {
    const adapter = source('capture-verifier')
    expect(adapter.source.transport).toBe('mock')
    expect(adapter.source.sourceId).toBe('mock-capture-verifier')
    expect(adapter.source.description).toContain('no live capture endpoint')
    const result = await adapter.pull()
    expect(result.source).toEqual(adapter.source)
  })
})

describe('mock capture push adapter', () => {
  test('accepts a pushed envelope and repeats it idempotently', async () => {
    const adapter = source('capture-issuer')
    const envelope = mockCaptureEnvelopes('capture-issuer')[2]
    if (envelope === undefined) {
      throw new Error('expected the issued-credential fixture')
    }

    const first = await adapter.push({
      authorization: TOKEN,
      mediaType: 'application/json',
      bytes: envelopeBytes(envelope),
    })
    expect(first.duplicate).toBe(false)
    expect(first.normalized.envelope.artifactType).toBe('issued-credential')
    expect(first.normalized.sensitive).not.toBeNull()
    expect(first.normalized.envelope.provenance.receivedAt).toBe(NOW.toISOString())

    const repeat = await adapter.push({
      authorization: TOKEN,
      mediaType: 'application/json; charset=utf-8',
      bytes: envelopeBytes(envelope),
    })
    expect(repeat.duplicate).toBe(true)
    expect(repeat.normalized.envelope.captureId).toBe(first.normalized.envelope.captureId)
  })

  test('rejects a resubmission that changes only correlation fields', async () => {
    const adapter = source('capture-issuer')
    const envelope = mockCaptureEnvelopes('capture-issuer')[2]
    if (envelope === undefined) {
      throw new Error('expected the issued-credential fixture')
    }
    await adapter.push({
      authorization: TOKEN,
      mediaType: 'application/json',
      bytes: envelopeBytes(envelope),
    })

    const correlationChanged = structuredClone(envelope)
    correlationChanged.correlationId = 'mock-correlation-other'
    await expectAdapterError(
      () =>
        adapter.push({
          authorization: TOKEN,
          mediaType: 'application/json',
          bytes: envelopeBytes(correlationChanged),
        }),
      'duplicate_conflict',
    )

    const executionChanged = structuredClone(envelope)
    executionChanged.testExecutionRef = 'mock-execution-other'
    await expectAdapterError(
      () =>
        adapter.push({
          authorization: TOKEN,
          mediaType: 'application/json',
          bytes: envelopeBytes(executionChanged),
        }),
      'duplicate_conflict',
    )

    // A rejected conflict must not overwrite the accepted submission.
    const repeat = await adapter.push({
      authorization: TOKEN,
      mediaType: 'application/json',
      bytes: envelopeBytes(envelope),
    })
    expect(repeat.duplicate).toBe(true)
  })

  test('rejects a resubmission that changes only an external reference', async () => {
    const adapter = source('capture-issuer')
    const envelope = mockCaptureEnvelopes('capture-issuer')[0]
    if (envelope === undefined) {
      throw new Error('expected the issuer-metadata fixture')
    }
    await adapter.push({
      authorization: TOKEN,
      mediaType: 'application/json',
      bytes: envelopeBytes(envelope),
    })

    const referenceChanged = structuredClone(envelope)
    const reference = referenceChanged.artifactRef as Record<string, unknown>
    reference.uri = 'https://artifacts.example.test/mock/other.json'
    await expectAdapterError(
      () =>
        adapter.push({
          authorization: TOKEN,
          mediaType: 'application/json',
          bytes: envelopeBytes(referenceChanged),
        }),
      'duplicate_conflict',
    )
  })

  test('rejects a resubmission of the same captureId with different bytes', async () => {
    const adapter = source('capture-issuer')
    const envelope = mockCaptureEnvelopes('capture-issuer')[2]
    if (envelope === undefined) {
      throw new Error('expected the issued-credential fixture')
    }
    await adapter.push({
      authorization: TOKEN,
      mediaType: 'application/json',
      bytes: envelopeBytes(envelope),
    })

    const changed = structuredClone(envelope)
    const artifact = changed.artifact as Record<string, unknown>
    const content = JSON.stringify({ vct: 'urn:example:attestbook:mock:changed', claims: {} })
    artifact.content = content
    artifact.byteLength = new TextEncoder().encode(content).byteLength
    changed.integrity = {
      algorithm: 'sha256',
      digest: sha256Hex(new TextEncoder().encode(content)),
    }

    await expectAdapterError(
      () =>
        adapter.push({
          authorization: TOKEN,
          mediaType: 'application/json',
          bytes: envelopeBytes(changed),
        }),
      'duplicate_conflict',
    )
  })

  test('rejects an artifact whose component differs from the configured source', async () => {
    const adapter = source('capture-issuer')
    const verifierEnvelope = mockCaptureEnvelopes('capture-verifier')[1]
    if (verifierEnvelope === undefined) {
      throw new Error('expected the presentation-submission fixture')
    }
    await expectAdapterError(
      () =>
        adapter.push({
          authorization: TOKEN,
          mediaType: 'application/json',
          bytes: envelopeBytes(verifierEnvelope),
        }),
      'forbidden',
    )
  })

  test('keeps a normalization failure a CaptureError instead of an adapter error', async () => {
    const adapter = source('capture-issuer')
    try {
      await adapter.push({
        authorization: TOKEN,
        mediaType: 'application/json',
        bytes: new TextEncoder().encode('{ not json'),
      })
    } catch (error) {
      expect(isCaptureError(error)).toBe(true)
      expect(isCaptureAdapterError(error)).toBe(false)
      return
    }
    throw new Error('expected the malformed submission to be rejected')
  })

  test('bounds the in-memory idempotency store without losing stored captures', async () => {
    const adapter = source('capture-issuer', { maxAcceptedCaptures: 1 })
    const first = mockCaptureEnvelopes('capture-issuer')[0]
    const second = mockCaptureEnvelopes('capture-issuer')[1]
    if (first === undefined || second === undefined) {
      throw new Error('expected the issuer-metadata and credential-offer fixtures')
    }
    await adapter.push({
      authorization: TOKEN,
      mediaType: 'application/json',
      bytes: envelopeBytes(first),
    })
    await expectAdapterError(
      () =>
        adapter.push({
          authorization: TOKEN,
          mediaType: 'application/json',
          bytes: envelopeBytes(second),
        }),
      'capture_store_full',
    )
    const repeat = await adapter.push({
      authorization: TOKEN,
      mediaType: 'application/json',
      bytes: envelopeBytes(first),
    })
    expect(repeat.duplicate).toBe(true)
  })

  test('clones configured fixtures so later caller mutations do not change them', async () => {
    const envelopes = mockCaptureEnvelopes('capture-issuer')
    const adapter = source('capture-issuer', { envelopes })
    const original = envelopes[0]
    if (original === undefined) {
      throw new Error('expected the issuer-metadata fixture')
    }
    const originalCaptureId = String(original.captureId)
    original.captureId = 'mutated-after-construction'

    const { artifacts } = await adapter.pull({ maxArtifacts: 10 })
    expect(artifacts[0]?.envelope.captureId).toBe(originalCaptureId)
  })

  test('rejects an invalid configured fixture at construction', () => {
    expect(
      () =>
        new MockCaptureSource({
          component: 'capture-issuer',
          envelopes: [{ kind: 'not-a-capture-envelope' }],
        }),
    ).toThrow()
  })
})
