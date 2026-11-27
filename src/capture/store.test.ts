// Capture evidence store tests (FR-015/FR-019, issue #156).
//
// The store is exercised over a real temporary SQLite database with the real
// migrations, so ordering, idempotency, the record bound and correlation
// upsert are tested against the same constraints the server uses.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { openDatabase } from '../db/database'
import { applyMigrations } from '../db/migrations'
import { isCaptureAdapterError } from './adapters'
import { normalizeCaptureArtifact } from './normalize'
import {
  canonicalCaptureSubmission,
  SqliteCaptureStore,
  type CaptureCorrelation,
  type CaptureRulebookBinding,
  type CaptureStoreInsert,
} from './store'
import { issuerEnvelope, verifierEnvelope, envelopeBytes } from './test/fixtures'

const RECEIVED_AT = new Date('2026-11-05T09:50:00.000Z')

const SOURCE = {
  sourceId: 'mock-capture-issuer',
  component: 'capture-issuer',
  transport: 'mock',
  description: 'Deterministic local mock fixtures',
} as const

const BINDING: CaptureRulebookBinding = {
  rulebookId: 'rulebook-1',
  rulebookName: 'PID Rulebook',
  version: '1.0',
  contentDigest: 'a'.repeat(64),
  digestVerified: true,
  specVersion: 'ts11@1.0.1',
  rulebookStatus: 'published',
  attestationType: 'PID',
  boundAt: '2026-11-05T09:51:00.000Z',
}

const CORRELATION: CaptureCorrelation = {
  rulebook: BINDING,
  validation: {
    validationId: 'validation-1',
    validatedAt: '2026-11-05T09:51:00.000Z',
    rulebook: {
      id: BINDING.rulebookId,
      name: BINDING.rulebookName,
      version: BINDING.version,
      digest: BINDING.contentDigest,
      digestVerified: true,
      specVersion: BINDING.specVersion,
      status: 'published',
    },
    attestation: {
      name: 'PID',
      attestationLoS: 'iso_18045_high',
      bindingType: 'cryptographic',
      supportedFormats: ['dc+sd-jwt'],
    },
    credential: {
      format: 'dc+sd-jwt',
      vct: 'urn:example:attestbook:pid:1',
      disclosureCount: 0,
      keyBindingPresent: false,
    },
    schemaReferences: [],
    dimensions: [],
    violations: [],
    limitations: [],
    overallStatus: 'NOT_TESTED',
  },
}

let directory: string | undefined
let database: Database | undefined

function createStore(maxRecords?: number): SqliteCaptureStore {
  directory = mkdtempSync(join(tmpdir(), 'attestbook-capture-store-'))
  database = openDatabase(join(directory, 'attestbook.sqlite'))
  applyMigrations(database)
  return new SqliteCaptureStore(database, maxRecords === undefined ? {} : { maxRecords })
}

afterEach(() => {
  database?.close()
  database = undefined
  if (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true })
    directory = undefined
  }
})

function insertInput(
  envelope: Record<string, unknown> = issuerEnvelope(),
  submissionBytes: Uint8Array = envelopeBytes(envelope),
): CaptureStoreInsert {
  return {
    normalized: normalizeCaptureArtifact(envelope, { now: () => RECEIVED_AT }),
    source: SOURCE,
    submissionBytes,
  }
}

describe('capture store', () => {
  test('round-trips the metadata envelope, its source and the segregated artifact', () => {
    const store = createStore()
    const input = insertInput()

    expect(store.insert(input)).toBe('inserted')
    expect(store.count()).toBe(1)

    const entry = store.get(input.normalized.envelope.captureId)
    expect(entry?.envelope).toEqual(input.normalized.envelope)
    expect(entry?.source).toEqual(SOURCE)
    expect(entry?.correlation).toBeNull()
    expect(entry?.artifact).toEqual({
      mediaType: input.normalized.sensitive?.mediaType ?? '',
      encoding: input.normalized.sensitive?.encoding ?? 'utf8',
      byteLength: input.normalized.sensitive?.byteLength ?? 0,
      digest: input.normalized.sensitive?.digest ?? '',
    })
    // Metadata reads never carry the raw bytes.
    expect(entry?.artifact).not.toBeNull()
    expect(Object.hasOwn(entry?.artifact ?? {}, 'bytes')).toBe(false)

    const artifact = store.readArtifact(input.normalized.envelope.captureId)
    expect(artifact?.bytes).toEqual(input.normalized.sensitive?.bytes ?? new Uint8Array())
    expect(artifact?.digest).toBe(input.normalized.sensitive?.digest ?? '')
  })

  test('stores an external artifact without a segregated row', () => {
    const store = createStore()
    const input = insertInput(verifierEnvelope())

    expect(store.insert(input)).toBe('inserted')
    expect(store.get(input.normalized.envelope.captureId)?.artifact).toBeNull()
    expect(store.readArtifact(input.normalized.envelope.captureId)).toBeNull()
  })

  test('lists newest first by capture time, then capture id', () => {
    const store = createStore()
    for (const envelope of [
      issuerEnvelope({ captureId: 'capture-b', capturedAt: '2026-11-05T09:48:23Z' }),
      issuerEnvelope({ captureId: 'capture-a', capturedAt: '2026-11-05T09:48:23Z' }),
      issuerEnvelope({ captureId: 'capture-newest', capturedAt: '2026-11-05T10:00:00Z' }),
      issuerEnvelope({ captureId: 'capture-oldest', capturedAt: '2026-11-05T09:00:00Z' }),
    ]) {
      store.insert(insertInput(envelope))
    }

    expect(store.list({ limit: 10, offset: 0 }).map((entry) => entry.envelope.captureId)).toEqual([
      'capture-newest',
      'capture-a',
      'capture-b',
      'capture-oldest',
    ])
    expect(store.list({ limit: 2, offset: 1 }).map((entry) => entry.envelope.captureId)).toEqual([
      'capture-a',
      'capture-b',
    ])
    expect(store.count()).toBe(4)
  })

  test('inserts idempotently over byte-identical submissions', () => {
    const store = createStore()
    const input = insertInput()

    expect(store.insert(input)).toBe('inserted')
    expect(store.insert(input)).toBe('duplicate')
    expect(store.count()).toBe(1)
  })

  test('reports a conflicting submission and keeps the accepted evidence', () => {
    const store = createStore()
    const original = insertInput(issuerEnvelope({ correlationId: 'first-correlation' }))
    const conflicting = insertInput(
      issuerEnvelope({ correlationId: 'second-correlation' }),
      envelopeBytes({ different: 'bytes' }),
    )

    expect(store.insert(original)).toBe('inserted')
    expect(store.insert(conflicting)).toBe('duplicate_conflict')
    expect(store.count()).toBe(1)
    const entry = store.get(original.normalized.envelope.captureId)
    expect(entry?.envelope.correlationId).toBe('first-correlation')
    expect(store.readArtifact(original.normalized.envelope.captureId)?.bytes).toEqual(
      original.normalized.sensitive?.bytes ?? new Uint8Array(),
    )
  })

  test('refuses a new capture beyond the bound with capture_store_full', () => {
    const store = createStore(1)
    const first = insertInput(issuerEnvelope({ captureId: 'capture-1' }))
    const second = insertInput(issuerEnvelope({ captureId: 'capture-2' }))

    expect(store.insert(first)).toBe('inserted')
    expect(store.insert(first)).toBe('duplicate')
    try {
      store.insert(second)
      throw new Error('a capture beyond the bound must be refused')
    } catch (error) {
      expect(isCaptureAdapterError(error)).toBe(true)
      if (isCaptureAdapterError(error)) {
        expect(error.code).toBe('capture_store_full')
      }
    }
    expect(store.count()).toBe(1)
  })

  test('upserts a correlation and replaces it atomically', () => {
    const store = createStore()
    const captureId = 'capture-issuer-0001'
    store.insert(insertInput())

    store.upsertCorrelation(captureId, CORRELATION)
    expect(store.get(captureId)?.correlation).toEqual(CORRELATION)

    const replacement: CaptureCorrelation = {
      rulebook: { ...BINDING, contentDigest: 'b'.repeat(64), boundAt: '2026-11-05T12:00:00.000Z' },
      validation: { ...CORRELATION.validation, validationId: 'validation-2' },
    }
    store.upsertCorrelation(captureId, replacement)
    expect(store.get(captureId)?.correlation).toEqual(replacement)
    expect(store.count()).toBe(1)
  })

  test('persists evidence and its correlation across a new connection', () => {
    const store = createStore()
    const input = insertInput()
    store.insert(input)
    store.upsertCorrelation(input.normalized.envelope.captureId, CORRELATION)
    database?.close()
    database = undefined

    const reopenedPath = join(directory ?? '', 'attestbook.sqlite')
    database = openDatabase(reopenedPath)
    const reopened = new SqliteCaptureStore(database)
    expect(reopened.count()).toBe(1)
    expect(reopened.get(input.normalized.envelope.captureId)?.correlation).toEqual(CORRELATION)
    expect(reopened.readArtifact(input.normalized.envelope.captureId)?.bytes).toEqual(
      input.normalized.sensitive?.bytes ?? new Uint8Array(),
    )
  })

  test('keeps the normalized envelope free of the raw artifact', () => {
    const store = createStore()
    const input = insertInput()
    store.insert(input)
    const serialized = JSON.stringify(store.get(input.normalized.envelope.captureId))

    expect(serialized).not.toContain('sensitive-access-token-value')
    expect(serialized).not.toContain('"given_name"')
    expect(serialized).toContain('capture-issuer-0001')
  })

  test('rejects malformed page bounds', () => {
    const store = createStore()
    expect(() => store.list({ limit: 0, offset: 0 })).toThrow(RangeError)
    expect(() => store.list({ limit: 1, offset: -1 })).toThrow(RangeError)
  })

  test('uses a stable canonical fingerprint that ignores the receipt timestamp', () => {
    const earlier = normalizeCaptureArtifact(issuerEnvelope(), { now: () => RECEIVED_AT })
    const later = normalizeCaptureArtifact(issuerEnvelope(), {
      now: () => new Date('2026-11-05T11:00:00.000Z'),
    })
    const store = createStore()
    store.insert({
      normalized: earlier,
      source: SOURCE,
      submissionBytes: canonicalCaptureSubmission(earlier),
    })

    // Re-normalizing the same source evidence at a later receipt time must be
    // a duplicate, not a conflict: receivedAt is generated by AttestBook.
    expect(
      store.insert({
        normalized: later,
        source: SOURCE,
        submissionBytes: canonicalCaptureSubmission(later),
      }),
    ).toBe('duplicate')
  })
})
