// Transport adapter contracts for capture ingestion (FR-018, issue #47).
//
// Push-based submission and pull-based retrieval share the normalized capture
// envelope; only the trigger and transport differ. These interfaces are the
// extension seam: a future transport adapter (for example one built around the
// real `capture-issuer`/`capture-verifier` HTTP contracts) implements them and
// is used by the rest of AttestBook without changes here. No concrete live
// transport ships with this module, so the only transport kind is `mock` and
// every source built from it is explicitly labelled as such.

import type { CaptureSourceComponent, NormalizedCaptureArtifact } from '../types'

/** Transport kinds implemented by this repository. */
export const CAPTURE_ADAPTER_TRANSPORTS = ['mock'] as const
export type CaptureAdapterTransport = (typeof CAPTURE_ADAPTER_TRANSPORTS)[number]

/**
 * A configured origin of capture artifacts. It carries no credential: the
 * credential is either presented by the pushing source or held by the pull
 * caller, never part of the indexable source description.
 */
export interface CaptureSource {
  /** Stable, opaque identifier of this configured source. */
  readonly sourceId: string
  readonly component: CaptureSourceComponent
  /** Transport that carries the artifacts; `mock` is the only implemented kind. */
  readonly transport: CaptureAdapterTransport
  /** Human-readable provenance label; never a live-endpoint claim for mock. */
  readonly description: string
}

/** One pull request. Omitted cursor means "from the beginning of the source". */
export interface CapturePullRequest {
  /** Opaque cursor returned as `nextCursor` by an earlier pull. */
  readonly cursor?: string | null
  /** Requested page size; the adapter may cap it. */
  readonly maxArtifacts?: number
}

/** One page of retrieved and normalized capture artifacts. */
export interface CapturePullResult {
  readonly source: CaptureSource
  readonly artifacts: readonly NormalizedCaptureArtifact[]
  /** Opaque cursor for the next page, or `null` when the source is drained. */
  readonly nextCursor: string | null
  /** AttestBook receipt time of this pull, RFC 3339 UTC. */
  readonly receivedAt: string
}

/**
 * One pushed submission. `authorization` is the bearer credential the source
 * presents to AttestBook; it is never logged or echoed in a result or error.
 */
export interface CapturePushSubmission {
  readonly authorization: string | null
  readonly mediaType: string
  /** The untrusted, exact UTF-8 JSON bytes of one capture envelope. */
  readonly bytes: Uint8Array
}

/** The outcome of one accepted (or idempotently repeated) push. */
export interface CapturePushResult {
  readonly source: CaptureSource
  readonly normalized: NormalizedCaptureArtifact
  /**
   * True when the same `captureId` was already accepted with byte-identical
   * submission bytes.
   */
  readonly duplicate: boolean
  /** AttestBook receipt time of this push, RFC 3339 UTC. */
  readonly receivedAt: string
}

/** Pull-based retrieval of capture artifacts from one source. */
export interface CapturePullAdapter {
  readonly source: CaptureSource
  pull(request?: CapturePullRequest): Promise<CapturePullResult>
}

/** Push-based submission of one capture artifact to AttestBook. */
export interface CapturePushAdapter {
  readonly source: CaptureSource
  push(submission: CapturePushSubmission): Promise<CapturePushResult>
}
