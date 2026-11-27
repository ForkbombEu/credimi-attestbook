// Durable capture evidence and correlation store (FR-015, FR-019, issue #156).
//
// The capture explorer used to keep normalized envelopes, segregated inline
// artifacts and recorded rulebook correlations in process memory, so a
// validation binding disappeared on restart. This module is the persistence
// seam the explorer reads and writes through:
//
//   capture_evidence            metadata-only envelope and source description
//   capture_evidence_artifacts  the segregated decoded inline artifact bytes
//   capture_correlations        the pinned-rulebook binding and validation
//
// The metadata and the raw artifact are separate tables on purpose: a list or
// metadata read never touches the blob, and nothing here returns raw bytes
// except the explicit `readArtifact` used to compute the redacted projection or
// to run structural validation. No module logs or exposes what it returns.
//
// Insert is idempotent by `captureId` over the exact accepted submission bytes
// (`docs/capture.md` §7): byte-identical bytes are `duplicate`, different bytes
// are `duplicate_conflict`. A new capture beyond `MAX_CAPTURE_RECORDS` is
// refused with the existing `capture_store_full` adapter code instead of
// growing or evicting. The in-memory implementation exists only for isolated
// tests and for an application assembled without a database; the server always
// wires the SQLite implementation.

import type { Database } from 'bun:sqlite'

import { compareCodeUnits, stableJson } from '../import/identity'
import { sha256Hex } from '../registry/digest'
import type { CredentialValidationResult } from '../validation'

import { captureAdapterError } from './adapters/errors'
import type { CaptureSource } from './adapters/types'
import type {
  CaptureArtifact,
  CaptureArtifactEncoding,
  CaptureRawArtifact,
  NormalizedCaptureArtifact,
} from './types'

/** Bound on the number of capture evidence records the store will hold. */
export const MAX_CAPTURE_RECORDS = 10_000

/** The exact pinned rulebook version one validation ran against. */
export interface CaptureRulebookBinding {
  readonly rulebookId: string
  readonly rulebookName: string
  readonly version: string
  /** Lowercase hex SHA-256 of the stored snapshot bytes. */
  readonly contentDigest: string
  /** Always `true`: a mismatching digest aborts the validation run. */
  readonly digestVerified: true
  readonly specVersion: string
  readonly rulebookStatus: 'draft' | 'published' | 'historical'
  /** The selected attestation type inside that exact snapshot. */
  readonly attestationType: string
  /** AttestBook timestamp of the correlation, RFC 3339 UTC. */
  readonly boundAt: string
}

/** A recorded rulebook binding together with its structural validation result. */
export interface CaptureCorrelation {
  readonly rulebook: CaptureRulebookBinding
  readonly validation: CredentialValidationResult
}

/** Artifact facts that are safe to read without loading the blob. */
export interface CaptureArtifactMetadata {
  readonly mediaType: string
  readonly encoding: CaptureArtifactEncoding
  readonly byteLength: number
  /** Lowercase hexadecimal SHA-256 recomputed over the decoded bytes. */
  readonly digest: string
}

/** One stored capture with its safe metadata and optional correlation. */
export interface CaptureStoreEntry {
  readonly envelope: CaptureArtifact
  readonly source: CaptureSource
  /** Segregated artifact metadata; `null` when the artifact stayed external. */
  readonly artifact: CaptureArtifactMetadata | null
  readonly correlation: CaptureCorrelation | null
}

/** One insert-if-absent attempt. */
export interface CaptureStoreInsert {
  readonly normalized: NormalizedCaptureArtifact
  readonly source: CaptureSource
  /**
   * The exact bytes the adapter accepted. Their SHA-256 is the idempotency key
   * (`docs/capture.md` §7). A pull transport has no submission frame, so the
   * explorer passes `canonicalCaptureSubmission` for its normalized artifact.
   */
  readonly submissionBytes: Uint8Array
}

/** Outcome of inserting one capture. */
export type CaptureStoreInsertResult = 'inserted' | 'duplicate' | 'duplicate_conflict'

/** Page bounds for a newest-first evidence read. */
export interface CaptureStorePage {
  readonly limit: number
  readonly offset: number
}

export interface CaptureStoreOptions {
  /** Bound on stored evidence records; defaults to `MAX_CAPTURE_RECORDS`. */
  readonly maxRecords?: number
}

/** Persistence seam for capture evidence and correlations. */
export interface CaptureStore {
  /**
   * Inserts one capture if its `captureId` is absent. Byte-identical bytes are
   * `duplicate`; different bytes are `duplicate_conflict` and change nothing.
   * Throws `capture_store_full` when a new record would exceed the bound.
   */
  insert(input: CaptureStoreInsert): CaptureStoreInsertResult
  /** Records, newest first by `capturedAt` then `captureId`. */
  list(page: CaptureStorePage): readonly CaptureStoreEntry[]
  /** Number of stored evidence records. */
  count(): number
  /** One record without its artifact bytes, or `null` when absent. */
  get(captureId: string): CaptureStoreEntry | null
  /** The segregated decoded artifact, or `null` for external/missing evidence. */
  readArtifact(captureId: string): CaptureRawArtifact | null
  /** Inserts or replaces the rulebook binding and validation for a capture. */
  upsertCorrelation(captureId: string, correlation: CaptureCorrelation): void
}

/**
 * Canonical submission bytes for an artifact retrieved through a pull
 * transport. The metadata envelope is serialized with sorted member names and
 * the segregated artifact is bound by its digest, so two different normalized
 * artifacts can never share the fingerprint.
 *
 * `receivedAt`/`receivedAtMs` are generated by AttestBook at normalization
 * time, not by the source, so they are excluded: a restart must recognise the
 * same source evidence even though its receipt timestamp differs. A push
 * transport has the exact submitted bytes and must pass those instead.
 */
export function canonicalCaptureSubmission(artifact: NormalizedCaptureArtifact): Uint8Array {
  const sensitive = artifact.sensitive
  const provenance: Record<string, unknown> = { ...artifact.envelope.provenance }
  delete provenance.receivedAt
  delete provenance.receivedAtMs
  const descriptor = stableJson({
    envelope: { ...artifact.envelope, provenance },
    artifact:
      sensitive === null
        ? null
        : {
            mediaType: sensitive.mediaType,
            encoding: sensitive.encoding,
            byteLength: sensitive.byteLength,
            digest: sensitive.digest,
          },
  })
  return new TextEncoder().encode(descriptor)
}

function resolveMaxRecords(options: CaptureStoreOptions): number {
  const maxRecords = options.maxRecords ?? MAX_CAPTURE_RECORDS
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new RangeError('the capture store bound must be an integer >= 1')
  }
  return maxRecords
}

function resolvePage(page: CaptureStorePage): CaptureStorePage {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1) {
    throw new RangeError('the capture page limit must be an integer >= 1')
  }
  if (!Number.isSafeInteger(page.offset) || page.offset < 0) {
    throw new RangeError('the capture page offset must be an integer >= 0')
  }
  return page
}

function cloneMetadata(artifact: CaptureRawArtifact): CaptureArtifactMetadata {
  return {
    mediaType: artifact.mediaType,
    encoding: artifact.encoding,
    byteLength: artifact.byteLength,
    digest: artifact.digest,
  }
}

interface CaptureRow {
  readonly capture_id: string
  readonly envelope_json: string
  readonly source_id: string
  readonly source_component: string
  readonly source_transport: string
  readonly source_description: string
  readonly artifact_media_type: string | null
  readonly artifact_encoding: string | null
  readonly artifact_byte_length: number | null
  readonly artifact_digest: string | null
  readonly binding_json: string | null
  readonly validation_json: string | null
}

const CAPTURE_SELECT = `
  SELECT
    evidence.capture_id,
    evidence.envelope_json,
    evidence.source_id,
    evidence.source_component,
    evidence.source_transport,
    evidence.source_description,
    artifact.media_type AS artifact_media_type,
    artifact.encoding AS artifact_encoding,
    artifact.byte_length AS artifact_byte_length,
    artifact.digest AS artifact_digest,
    correlation.binding_json,
    correlation.validation_json
  FROM capture_evidence AS evidence
  LEFT JOIN capture_evidence_artifacts AS artifact
    ON artifact.capture_id = evidence.capture_id
  LEFT JOIN capture_correlations AS correlation
    ON correlation.capture_id = evidence.capture_id
`

function toEntry(row: CaptureRow): CaptureStoreEntry {
  const artifact: CaptureArtifactMetadata | null =
    row.artifact_media_type === null ||
    row.artifact_encoding === null ||
    row.artifact_byte_length === null ||
    row.artifact_digest === null
      ? null
      : {
          mediaType: row.artifact_media_type,
          encoding: row.artifact_encoding as CaptureArtifactEncoding,
          byteLength: row.artifact_byte_length,
          digest: row.artifact_digest,
        }
  const correlation: CaptureCorrelation | null =
    row.binding_json === null || row.validation_json === null
      ? null
      : {
          rulebook: JSON.parse(row.binding_json) as CaptureRulebookBinding,
          validation: JSON.parse(row.validation_json) as CredentialValidationResult,
        }
  return {
    envelope: JSON.parse(row.envelope_json) as CaptureArtifact,
    source: {
      sourceId: row.source_id,
      component: row.source_component as CaptureSource['component'],
      transport: row.source_transport as CaptureSource['transport'],
      description: row.source_description,
    },
    artifact,
    correlation,
  }
}

/**
 * SQLite-backed capture evidence. The constructor does not create tables: the
 * schema belongs to `migrations/0012_capture_evidence.sql` and is applied by
 * the normal migration runner.
 */
export class SqliteCaptureStore implements CaptureStore {
  private readonly database: Database
  private readonly maxRecords: number

  constructor(database: Database, options: CaptureStoreOptions = {}) {
    this.database = database
    this.maxRecords = resolveMaxRecords(options)
  }

  insert(input: CaptureStoreInsert): CaptureStoreInsertResult {
    const envelope = input.normalized.envelope
    const submissionDigest = sha256Hex(input.submissionBytes)
    return this.database.transaction((): CaptureStoreInsertResult => {
      const existing = this.database
        .query<{ submission_digest: string }, [string]>(
          'SELECT submission_digest FROM capture_evidence WHERE capture_id = ?',
        )
        .get(envelope.captureId)
      if (existing !== null) {
        return existing.submission_digest === submissionDigest ? 'duplicate' : 'duplicate_conflict'
      }
      if (this.count() >= this.maxRecords) {
        throw captureAdapterError('capture_store_full', 'the capture evidence store is full')
      }
      this.database
        .query(
          `INSERT INTO capture_evidence (
            capture_id, envelope_json, source_id, source_component, source_transport,
            source_description, received_at, captured_at_ms, submission_digest
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          envelope.captureId,
          stableJson(envelope),
          input.source.sourceId,
          input.source.component,
          input.source.transport,
          input.source.description,
          envelope.provenance.receivedAt,
          envelope.provenance.capturedAtMs,
          submissionDigest,
        )
      const sensitive = input.normalized.sensitive
      if (sensitive !== null) {
        this.database
          .query(
            `INSERT INTO capture_evidence_artifacts (
              capture_id, media_type, encoding, byte_length, digest, bytes
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            envelope.captureId,
            sensitive.mediaType,
            sensitive.encoding,
            sensitive.byteLength,
            sensitive.digest,
            sensitive.bytes,
          )
      }
      return 'inserted'
    })()
  }

  list(page: CaptureStorePage): readonly CaptureStoreEntry[] {
    const resolved = resolvePage(page)
    return this.database
      .query<CaptureRow, [number, number]>(
        `${CAPTURE_SELECT}
         ORDER BY evidence.captured_at_ms DESC, evidence.capture_id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(resolved.limit, resolved.offset)
      .map(toEntry)
  }

  count(): number {
    return (
      this.database
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM capture_evidence')
        .get()?.count ?? 0
    )
  }

  get(captureId: string): CaptureStoreEntry | null {
    const row = this.database
      .query<CaptureRow, [string]>(`${CAPTURE_SELECT} WHERE evidence.capture_id = ?`)
      .get(captureId)
    return row === null ? null : toEntry(row)
  }

  readArtifact(captureId: string): CaptureRawArtifact | null {
    const row = this.database
      .query<
        {
          media_type: string
          encoding: string
          byte_length: number
          digest: string
          bytes: Uint8Array
        },
        [string]
      >(
        `SELECT media_type, encoding, byte_length, digest, bytes
         FROM capture_evidence_artifacts WHERE capture_id = ?`,
      )
      .get(captureId)
    if (row === null) {
      return null
    }
    return {
      mediaType: row.media_type,
      encoding: row.encoding as CaptureArtifactEncoding,
      byteLength: row.byte_length,
      digest: row.digest,
      bytes: new Uint8Array(row.bytes),
    }
  }

  upsertCorrelation(captureId: string, correlation: CaptureCorrelation): void {
    this.database
      .query(
        `INSERT INTO capture_correlations (capture_id, binding_json, validation_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (capture_id) DO UPDATE SET
           binding_json = excluded.binding_json,
           validation_json = excluded.validation_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        captureId,
        stableJson(correlation.rulebook),
        stableJson(correlation.validation),
        correlation.rulebook.boundAt,
      )
  }
}

interface MemoryRecord {
  readonly entry: CaptureStoreEntry
  readonly submissionDigest: string
  readonly artifact: CaptureRawArtifact | null
}

/**
 * In-memory implementation for isolated tests and for an application assembled
 * without a database. It follows the same insert/duplicate/bound semantics as
 * the SQLite store. It persists nothing across a restart.
 */
export class MemoryCaptureStore implements CaptureStore {
  private readonly records = new Map<string, MemoryRecord>()
  private readonly maxRecords: number

  constructor(options: CaptureStoreOptions = {}) {
    this.maxRecords = resolveMaxRecords(options)
  }

  insert(input: CaptureStoreInsert): CaptureStoreInsertResult {
    const envelope = input.normalized.envelope
    const submissionDigest = sha256Hex(input.submissionBytes)
    const existing = this.records.get(envelope.captureId)
    if (existing !== undefined) {
      return existing.submissionDigest === submissionDigest ? 'duplicate' : 'duplicate_conflict'
    }
    if (this.records.size >= this.maxRecords) {
      throw captureAdapterError('capture_store_full', 'the capture evidence store is full')
    }
    const sensitive = input.normalized.sensitive
    this.records.set(envelope.captureId, {
      submissionDigest,
      entry: {
        envelope: structuredClone(envelope),
        source: { ...input.source },
        artifact: sensitive === null ? null : cloneMetadata(sensitive),
        correlation: null,
      },
      artifact: sensitive === null ? null : structuredClone(sensitive),
    })
    return 'inserted'
  }

  list(page: CaptureStorePage): readonly CaptureStoreEntry[] {
    const resolved = resolvePage(page)
    return this.sorted().slice(resolved.offset, resolved.offset + resolved.limit)
  }

  count(): number {
    return this.records.size
  }

  get(captureId: string): CaptureStoreEntry | null {
    const record = this.records.get(captureId)
    return record === undefined ? null : structuredClone(record.entry)
  }

  readArtifact(captureId: string): CaptureRawArtifact | null {
    const record = this.records.get(captureId)
    if (record === undefined || record.artifact === null) {
      return null
    }
    return structuredClone(record.artifact)
  }

  upsertCorrelation(captureId: string, correlation: CaptureCorrelation): void {
    const record = this.records.get(captureId)
    if (record === undefined) {
      throw new Error('the capture does not exist')
    }
    this.records.set(captureId, {
      ...record,
      entry: {
        ...record.entry,
        correlation: structuredClone(correlation),
      },
    })
  }

  private sorted(): readonly CaptureStoreEntry[] {
    return [...this.records.values()]
      .sort((left, right) => {
        const byTime =
          right.entry.envelope.provenance.capturedAtMs - left.entry.envelope.provenance.capturedAtMs
        return byTime !== 0
          ? byTime
          : compareCodeUnits(left.entry.envelope.captureId, right.entry.envelope.captureId)
      })
      .map((record) => structuredClone(record.entry))
  }
}
