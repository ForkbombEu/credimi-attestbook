// Capture explorer read model and rulebook correlation (FR-019, UI-006, issue #48).
//
// The explorer is a bounded projection of the normalized capture evidence served
// by the configured capture sources, backed by the durable capture store. It joins one capture
// artifact with the exact rulebook version it was validated against and with
// the opaque test-execution reference the source supplied, so a consumer can
// follow source -> capture -> pinned rulebook version -> validation findings
// -> test execution without AttestBook owning the test lifecycle (FR-019).
//
// Everything here is mock-backed: the only sources this build can construct
// are deterministic mock adapters, every source says `transport: "mock"` and
// no live `capture-issuer`/`capture-verifier` endpoint is contacted. Evidence
// and correlations are read and written through a `CaptureStore`; the server
// wires the SQLite implementation, so a capture and its binding survive a
// restart. External artifact references are never fetched.
//
// Raw inline evidence stays segregated in the store's artifact table and is
// never returned by a read model. The explorer displays only the redacted
// default-policy projection, and validation is refused for evidence that is
// external or already redacted by its source.

import { randomUUID } from 'node:crypto'

import { conflict, invalidInput, notFound } from '../registry/errors'
import { requireIdentifier, requireSemanticVersion, requireText } from '../registry/validation'
import {
  MAX_ATTESTATION_TYPE_LENGTH,
  type CredentialValidationResult,
  type CredentialValidationService,
  type ValidationDimension,
  type ValidationStatus,
} from '../validation'

import {
  captureAdapterError,
  hashCaptureCredential,
  MockCaptureSource,
  mockCaptureEnvelopes,
  type CaptureAdapterTransport,
  type CapturePullAdapter,
} from './adapters'
import { DEFAULT_CAPTURE_LIMITS, type CaptureLimits } from './limits'
import {
  DEFAULT_CAPTURE_REDACTION_POLICY_REF,
  redactNormalizedCaptureArtifact,
  type CaptureRedactionPolicy,
} from './redaction'
import {
  canonicalCaptureSubmission,
  MemoryCaptureStore,
  type CaptureArtifactMetadata,
  type CaptureCorrelation,
  type CaptureRulebookBinding,
  type CaptureStore,
  type CaptureStoreEntry,
} from './store'
import type {
  CaptureArtifact,
  CaptureArtifactEncoding,
  CaptureArtifactType,
  CaptureCredentialFormat,
  CaptureDiagnostic,
  CaptureIntegrity,
  CaptureInteractionType,
  CaptureMetadataValue,
  CaptureParty,
  CaptureProtocol,
  CaptureProvenance,
  CaptureRawArtifact,
  CaptureRedaction,
  CaptureSourceComponent,
  NormalizedCaptureArtifact,
} from './types'

/** Artifact types that carry a credential the structural engine can inspect. */
export const CAPTURE_VALIDATABLE_ARTIFACT_TYPES = ['issued-credential'] as const
export type CaptureValidatableArtifactType = (typeof CAPTURE_VALIDATABLE_ARTIFACT_TYPES)[number]

/** Stable codes of the evidence a capture does not carry. */
export const CAPTURE_EVIDENCE_GAP_CODES = [
  'external_artifact_not_fetched',
  'artifact_redacted_by_source',
  'no_test_execution_reference',
  'no_rulebook_binding',
  'validation_not_run',
  'validation_not_applicable',
] as const
export type CaptureEvidenceGapCode = (typeof CAPTURE_EVIDENCE_GAP_CODES)[number]

/** One explicitly unavailable piece of capture evidence. */
export interface CaptureEvidenceGap {
  readonly code: CaptureEvidenceGapCode
  readonly message: string
}

/** The configured capture source a capture was retrieved from. */
export interface CaptureSourceSummary {
  readonly sourceId: string
  readonly component: CaptureSourceComponent
  readonly transport: CaptureAdapterTransport
  readonly description: string
}

/** Capture provenance, projected without the raw artifact. */
export type CaptureProvenanceSummary = CaptureProvenance

/** Declared redaction of the artifact as carried by the envelope. */
export type CaptureDeclaredRedaction = CaptureRedaction

/** Whether the artifact bytes are inline (segregated) or external. */
export type CaptureArtifactAvailability = 'inline' | 'external'

/** Where the artifact lives, without its content. */
export interface CaptureArtifactSummary {
  readonly availability: CaptureArtifactAvailability
  readonly mediaType: string
  readonly byteLength: number | null
  /** Safe external reference URI; `null` for an inline artifact. */
  readonly uri: string | null
}

/** The exact pinned rulebook version one validation ran against. */
export type { CaptureRulebookBinding } from './store'

/** One dimension of a correlated validation result, without its evidence. */
export interface CaptureValidationDimensionSummary {
  readonly id: ValidationDimension['id']
  readonly status: ValidationStatus
  readonly applicable: boolean
  readonly executed: boolean
}

/** The linked validation result summary shown in a capture list. */
export interface CaptureValidationSummary {
  readonly validationId: string
  readonly validatedAt: string
  readonly overallStatus: ValidationStatus
  readonly violations: number
  readonly limitations: number
  readonly dimensions: readonly CaptureValidationDimensionSummary[]
}

/** A redacted artifact projection safe to display, log or index. */
export interface CaptureArtifactProjection {
  readonly mediaType: string
  readonly encoding: CaptureArtifactEncoding
  readonly byteLength: number
  /** SHA-256 of the redacted bytes, not of the original artifact. */
  readonly digest: string
  readonly redaction: CaptureRedaction
  /** Parsed redacted JSON document, or `null` for an opaque artifact. */
  readonly document: unknown
  readonly diagnostics: readonly CaptureDiagnostic[]
}

/** One event of the capture evidence timeline. */
export const CAPTURE_TIMELINE_EVENT_KINDS = ['captured', 'received', 'bound', 'validated'] as const
export type CaptureTimelineEventKind = (typeof CAPTURE_TIMELINE_EVENT_KINDS)[number]

export interface CaptureTimelineEvent {
  readonly kind: CaptureTimelineEventKind
  /** RFC 3339 timestamp preserved from the source or generated by AttestBook. */
  readonly at: string
  readonly label: string
  readonly detail: string
}

/** The list projection of one captured artifact. */
export interface CaptureExplorerSummary {
  readonly captureId: string
  readonly correlationId: string
  readonly kind: CaptureArtifact['kind']
  readonly envelopeVersion: CaptureArtifact['envelopeVersion']
  readonly source: CaptureSourceSummary
  readonly provenance: CaptureProvenanceSummary
  readonly interactionType: CaptureInteractionType
  readonly protocol: CaptureProtocol
  readonly credentialFormat: CaptureCredentialFormat
  readonly artifactType: CaptureArtifactType
  readonly party: CaptureParty | null
  readonly testExecutionRef: string | null
  readonly integrity: CaptureIntegrity
  readonly declaredRedaction: CaptureDeclaredRedaction
  readonly artifact: CaptureArtifactSummary
  readonly rulebook: CaptureRulebookBinding | null
  readonly validation: CaptureValidationSummary | null
  readonly evidenceGaps: readonly CaptureEvidenceGap[]
  readonly evidenceComplete: boolean
}

/** The detail projection of one captured artifact. */
export interface CaptureExplorerDetail extends CaptureExplorerSummary {
  readonly metadata: Readonly<Record<string, CaptureMetadataValue>>
  /** Redacted inline artifact projection; `null` when the artifact is external. */
  readonly artifactProjection: CaptureArtifactProjection | null
  /** The complete correlated validation result, when one has been recorded. */
  readonly validationResult: CredentialValidationResult | null
  readonly timeline: readonly CaptureTimelineEvent[]
  readonly limitations: readonly string[]
}

/** The result of correlating one capture with a pinned rulebook version. */
export interface CaptureCorrelationResult {
  readonly captureId: string
  readonly correlationId: string
  readonly testExecutionRef: string | null
  readonly rulebook: CaptureRulebookBinding
  readonly validation: CredentialValidationResult
}

/** The list of captures, with the page bounds. */
export interface CaptureExplorerPage {
  readonly captures: readonly CaptureExplorerSummary[]
  readonly total: number
  readonly limit: number
  readonly offset: number
}

/** Typed correlation request for `POST /api/v1/captures/{captureId}/validate`. */
export interface CaptureCorrelationInput {
  readonly rulebookId: string
  readonly rulebookVersion: string
  readonly attestationType: string
  /**
   * Optional pinned snapshot digest. When supplied, a validation result whose
   * digest differs is refused before the recorded correlation is changed, so a
   * stale pin can never overwrite correct evidence with different bytes.
   */
  readonly rulebookDigest: string | null
}

/** Default page size of the capture list. */
export const DEFAULT_CAPTURE_PAGE_LIMIT = 50
/** Maximum page size of the capture list. */
export const MAX_CAPTURE_PAGE_LIMIT = 100
/** Bound on pages pulled from one source while seeding the explorer. */
export const MAX_CAPTURE_SOURCE_PAGES = 100

export { MAX_CAPTURE_RECORDS } from './store'

/** Explicit limitations of every capture explorer read. */
export const CAPTURE_EXPLORER_LIMITATIONS: readonly string[] = Object.freeze([
  'The capture explorer is backed by the deterministic local mock source. No live capture-issuer or capture-verifier interaction is shown and none is claimed operational.',
  'Capture evidence and correlations are persisted in SQLite by the server and survive a restart; external artifact references are not fetched.',
  'Inline artifacts are shown only as the redacted default-policy projection; the segregated raw artifact is never returned by the API.',
  'Validation runs the structural credential engine on a captured issued credential. External, source-redacted or non-credential evidence is reported as unavailable instead of being validated.',
  'A structural validation status never implies cryptographic, issuer-trust, protocol or interoperability success.',
  'The test execution reference is an opaque, caller-owned identifier. AttestBook does not query Credimi or orchestrate a test execution.',
  'Source metadata is displayed as supplied. The envelope contract defines it as non-sensitive scalar data, and the normalizer enforces its shape but does not classify its values; a source must never place credentials, tokens or personal attributes there.',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  return (
    normalized === 'application/json' || normalized === 'text/json' || normalized.endsWith('+json')
  )
}

/** Whether the structural credential engine can inspect this artifact type. */
export function isCaptureValidatableArtifactType(
  artifactType: CaptureArtifactType,
): artifactType is CaptureValidatableArtifactType {
  return (CAPTURE_VALIDATABLE_ARTIFACT_TYPES as readonly string[]).includes(artifactType)
}

/**
 * Validates and normalises an untyped capture-correlation body. Throws a
 * `RegistryError` with code `invalid_input` when the request is malformed.
 */
export function parseCaptureCorrelationInput(value: unknown): CaptureCorrelationInput {
  if (!isRecord(value)) {
    throw invalidInput('request body must be a JSON object')
  }
  return {
    rulebookId: requireIdentifier(value.rulebookId, 'rulebookId'),
    rulebookVersion: requireSemanticVersion(value.rulebookVersion, 'rulebookVersion'),
    attestationType: requireText(
      value.attestationType,
      'attestationType',
      MAX_ATTESTATION_TYPE_LENGTH,
    ),
    rulebookDigest: parseOptionalRulebookDigest(value.rulebookDigest),
  }
}

const CAPTURE_RULEBOOK_DIGEST_PATTERN = /^[0-9a-f]{64}$/

function parseOptionalRulebookDigest(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string' || !CAPTURE_RULEBOOK_DIGEST_PATTERN.test(value)) {
    throw invalidInput('rulebookDigest must be a lowercase hex SHA-256 digest')
  }
  return value
}

export interface CaptureExplorerOptions {
  /** Configured pull adapters; the only implemented transport is `mock`. */
  readonly sources: readonly CapturePullAdapter[]
  /** The structural validation service a correlation runs against. */
  readonly validation: CredentialValidationService
  /**
   * Evidence and correlation store. Defaults to an in-memory store for isolated
   * tests; the server wires the SQLite implementation so data survives a
   * restart.
   */
  readonly store?: CaptureStore
  /** Clock for the correlation timestamp; injectable for tests. */
  readonly now?: () => Date
  /** Redaction policy used for the display projection. */
  readonly redactionPolicy?: CaptureRedactionPolicy
  /** Bounds of the redaction projection. */
  readonly limits?: CaptureLimits
}

const DEFAULT_REDACTION_POLICY: CaptureRedactionPolicy = {
  mode: 'partial',
  policyRef: DEFAULT_CAPTURE_REDACTION_POLICY_REF,
}

/**
 * Bounded capture evidence joined with validation correlations. Loading is
 * lazy and shared: concurrent reads trigger one pull per source, and every
 * insert is idempotent by `captureId` through the store.
 */
export class CaptureExplorer {
  private readonly sources: readonly CapturePullAdapter[]
  private readonly validation: CredentialValidationService
  private readonly store: CaptureStore
  private readonly now: () => Date
  private readonly redactionPolicy: CaptureRedactionPolicy
  private readonly limits: CaptureLimits
  private loaded = false
  private loadPromise: Promise<void> | null = null

  constructor(options: CaptureExplorerOptions) {
    this.sources = [...options.sources]
    this.validation = options.validation
    this.store = options.store ?? new MemoryCaptureStore()
    this.now = options.now ?? (() => new Date())
    this.redactionPolicy = options.redactionPolicy ?? DEFAULT_REDACTION_POLICY
    this.limits = options.limits ?? DEFAULT_CAPTURE_LIMITS
  }

  /**
   * Seeds the store from every configured source. Idempotent: a restart over
   * the same database re-inserts nothing and keeps recorded correlations. The
   * server calls this during startup; a read also triggers it lazily.
   */
  initialize(): Promise<void> {
    return this.ensureLoaded()
  }

  /** Captures, newest first, with the requested page bounds. */
  async list(
    options: { readonly limit?: number; readonly offset?: number } = {},
  ): Promise<CaptureExplorerPage> {
    await this.ensureLoaded()
    const limit = options.limit ?? DEFAULT_CAPTURE_PAGE_LIMIT
    const offset = options.offset ?? 0
    return {
      captures: this.store.list({ limit, offset }).map((entry) => this.toSummary(entry)),
      total: this.store.count(),
      limit,
      offset,
    }
  }

  /** One capture with its redacted projection, timeline and linked validation. */
  async get(captureId: string): Promise<CaptureExplorerDetail | null> {
    await this.ensureLoaded()
    const entry = this.store.get(captureId)
    if (entry === null) {
      return null
    }
    return this.toDetail(entry, this.store.readArtifact(captureId))
  }

  /**
   * Binds one capture to a pinned rulebook version and records the structural
   * validation result. The engine resolves the rulebook, version and
   * attestation type; a missing resource is reported as not found and an
   * unknown request as invalid input.
   *
   * Validation is refused for evidence that cannot be validated honestly: an
   * external reference is not fetched, source-redacted evidence is not the
   * original artifact, and only a captured issued credential carries a
   * credential to inspect.
   */
  async correlate(captureId: string, input: unknown): Promise<CaptureCorrelationResult> {
    await this.ensureLoaded()
    const request = parseCaptureCorrelationInput(input)
    const entry = this.store.get(captureId)
    if (entry === null) {
      throw notFound('The requested capture does not exist.')
    }
    const envelope = entry.envelope
    const artifact = this.store.readArtifact(captureId)
    if (envelope.artifactRef !== null || artifact === null) {
      throw conflict(
        'The capture artifact is stored behind an external reference and AttestBook has not fetched it. External evidence cannot be validated against a rulebook version.',
      )
    }
    // Defensive check only: an external artifact is refused above, and the
    // version 1 normalizer rejects an inline artifact that already declares
    // redaction (`redaction_inconsistent`), so a normalizable inline artifact
    // always reaches this point with `redaction.status === 'none'`.
    if (envelope.redaction.status !== 'none') {
      throw conflict(
        `The capture artifact was declared ${envelope.redaction.status} redacted by its source. Redacted evidence cannot be validated against a rulebook version.`,
      )
    }
    if (!isCaptureValidatableArtifactType(envelope.artifactType)) {
      throw conflict(
        `Credential validation is not applicable to artifact type "${envelope.artifactType}". Only a captured issued credential carries a credential AttestBook can validate.`,
      )
    }
    const text = decodeArtifactText(artifact)
    const result = await this.validation.validate({
      rulebookId: request.rulebookId,
      rulebookVersion: request.rulebookVersion,
      attestationType: request.attestationType,
      credential: text,
    })
    // A stale pin must not replace a correct correlation. The validation run
    // itself writes nothing, so refusing here leaves the previous binding and
    // validation result untouched.
    if (request.rulebookDigest !== null && result.rulebook.digest !== request.rulebookDigest) {
      throw conflict(
        'The rulebook version snapshot digest no longer matches the requested rulebookDigest; nothing was recorded.',
      )
    }
    const boundAt = this.now()
    if (Number.isNaN(boundAt.getTime())) {
      throw new Error('the capture explorer clock returned an invalid date')
    }
    const binding: CaptureRulebookBinding = {
      rulebookId: result.rulebook.id,
      rulebookName: result.rulebook.name,
      version: result.rulebook.version,
      contentDigest: result.rulebook.digest,
      digestVerified: result.rulebook.digestVerified,
      specVersion: result.rulebook.specVersion,
      rulebookStatus: result.rulebook.status,
      attestationType: result.attestation.name,
      boundAt: boundAt.toISOString(),
    }
    this.store.upsertCorrelation(envelope.captureId, { rulebook: binding, validation: result })
    return {
      captureId: envelope.captureId,
      correlationId: envelope.correlationId,
      testExecutionRef: envelope.testExecutionRef,
      rulebook: binding,
      validation: result,
    }
  }

  private toSummary(entry: CaptureStoreEntry): CaptureExplorerSummary {
    const envelope = entry.envelope
    const correlation = entry.correlation
    const validation = correlation === null ? null : toValidationSummary(correlation.validation)
    const evidenceGaps = evidenceGapsFor(
      envelope,
      correlation?.rulebook ?? null,
      correlation?.validation ?? null,
    )
    return {
      captureId: envelope.captureId,
      correlationId: envelope.correlationId,
      kind: envelope.kind,
      envelopeVersion: envelope.envelopeVersion,
      source: {
        sourceId: entry.source.sourceId,
        component: entry.source.component,
        transport: entry.source.transport,
        description: entry.source.description,
      },
      provenance: envelope.provenance,
      interactionType: envelope.interactionType,
      protocol: envelope.protocol,
      credentialFormat: envelope.credentialFormat,
      artifactType: envelope.artifactType,
      party: envelope.party,
      testExecutionRef: envelope.testExecutionRef,
      integrity: envelope.integrity,
      declaredRedaction: envelope.redaction,
      artifact: artifactSummaryFor(envelope, entry.artifact),
      rulebook: correlation?.rulebook ?? null,
      validation,
      evidenceGaps,
      evidenceComplete: evidenceGaps.length === 0,
    }
  }

  private toDetail(
    entry: CaptureStoreEntry,
    artifact: CaptureRawArtifact | null,
  ): CaptureExplorerDetail {
    return {
      ...this.toSummary(entry),
      metadata: { ...entry.envelope.metadata },
      artifactProjection: projectionFor(
        entry.envelope,
        artifact,
        this.redactionPolicy,
        this.limits,
      ),
      validationResult: entry.correlation?.validation ?? null,
      timeline: timelineFor(entry.envelope, entry.correlation),
      limitations: [...CAPTURE_EXPLORER_LIMITATIONS],
    }
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return Promise.resolve()
    }
    this.loadPromise ??= this.load()
    return this.loadPromise
  }

  private async load(): Promise<void> {
    try {
      for (const source of this.sources) {
        await this.pullSource(source)
      }
      this.loaded = true
    } catch (error) {
      // Allow a later read to retry a failed source instead of caching the
      // failure for the lifetime of the process.
      this.loadPromise = null
      throw error
    }
  }

  private async pullSource(source: CapturePullAdapter): Promise<void> {
    let cursor: string | null = null
    for (let page = 0; page < MAX_CAPTURE_SOURCE_PAGES; page += 1) {
      const result = await source.pull(cursor === null ? {} : { cursor })
      for (const artifact of result.artifacts) {
        const outcome = this.store.insert({
          normalized: artifact,
          source: result.source,
          submissionBytes: canonicalCaptureSubmission(artifact),
        })
        if (outcome === 'duplicate_conflict') {
          throw captureAdapterError(
            'duplicate_conflict',
            'a capture identifier was already stored with different submission bytes',
          )
        }
      }
      cursor = result.nextCursor
      if (cursor === null) {
        return
      }
    }
    throw new Error('a capture source exceeded the explorer page bound')
  }
}

function decodeArtifactText(artifact: CaptureRawArtifact): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes)
  } catch {
    throw conflict(
      'The capture artifact is not valid UTF-8 text, so it cannot be validated as a credential artifact.',
    )
  }
  if (text.trim() === '') {
    throw conflict('The capture artifact is empty and cannot be validated as a credential.')
  }
  return text
}

function artifactSummaryFor(
  envelope: CaptureArtifact,
  artifact: CaptureArtifactMetadata | null,
): CaptureArtifactSummary {
  if (artifact === null) {
    return {
      availability: 'external',
      mediaType: envelope.artifactRef?.mediaType ?? '',
      byteLength: envelope.artifactRef?.byteLength ?? null,
      uri: envelope.artifactRef?.uri ?? null,
    }
  }
  return {
    availability: 'inline',
    mediaType: artifact.mediaType,
    byteLength: artifact.byteLength,
    uri: null,
  }
}

function projectionFor(
  envelope: CaptureArtifact,
  artifact: CaptureRawArtifact | null,
  policy: CaptureRedactionPolicy,
  limits: CaptureLimits,
): CaptureArtifactProjection | null {
  if (artifact === null) {
    return null
  }
  const normalized: NormalizedCaptureArtifact = {
    envelope,
    sensitive: artifact,
    diagnostics: [],
  }
  const redacted = redactNormalizedCaptureArtifact(normalized, policy, limits)
  const sensitive = redacted.sensitive
  if (sensitive === null) {
    return null
  }
  let document: unknown = null
  if (isJsonMediaType(sensitive.mediaType)) {
    try {
      document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(sensitive.bytes))
    } catch {
      document = null
    }
  }
  return {
    mediaType: sensitive.mediaType,
    encoding: sensitive.encoding,
    byteLength: sensitive.byteLength,
    digest: sensitive.digest,
    redaction: {
      status: redacted.envelope.redaction.status,
      policyRef: redacted.envelope.redaction.policyRef,
      redactedPaths: [...redacted.envelope.redaction.redactedPaths],
      redactedDigest: redacted.envelope.redaction.redactedDigest,
    },
    document,
    diagnostics: redacted.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  }
}

function toValidationSummary(validation: CredentialValidationResult): CaptureValidationSummary {
  return {
    validationId: validation.validationId,
    validatedAt: validation.validatedAt,
    overallStatus: validation.overallStatus,
    violations: validation.violations.length,
    limitations: validation.limitations.length,
    dimensions: validation.dimensions.map((dimension) => ({
      id: dimension.id,
      status: dimension.status,
      applicable: dimension.applicable,
      executed: dimension.executed,
    })),
  }
}

const EVIDENCE_GAP_MESSAGES: Readonly<Record<CaptureEvidenceGapCode, string>> = {
  external_artifact_not_fetched:
    'The artifact is stored behind an external reference. AttestBook has not fetched it, so its content and digest are unavailable for display or validation.',
  artifact_redacted_by_source:
    'The source declared this artifact partially or fully redacted. Only the declared redaction evidence is available and it cannot be validated against a rulebook version.',
  no_test_execution_reference:
    'No Credimi test execution reference was supplied with this capture, so it cannot be correlated with a test run.',
  no_rulebook_binding:
    'This capture is not bound to a rulebook version yet, so no validation result is linked to a pinned rulebook.',
  validation_not_run:
    'No validation has been recorded for this capture. Run it against a pinned rulebook version to link findings.',
  validation_not_applicable:
    'Credential validation applies to a captured issued credential; this artifact type carries no credential the structural engine can inspect.',
}

function evidenceGapsFor(
  envelope: CaptureArtifact,
  binding: CaptureRulebookBinding | null,
  validation: CredentialValidationResult | null,
): readonly CaptureEvidenceGap[] {
  const codes: CaptureEvidenceGapCode[] = []
  if (envelope.artifactRef !== null) {
    codes.push('external_artifact_not_fetched')
  }
  if (envelope.redaction.status !== 'none') {
    codes.push('artifact_redacted_by_source')
  }
  if (envelope.testExecutionRef === null) {
    codes.push('no_test_execution_reference')
  }
  if (binding === null) {
    codes.push('no_rulebook_binding')
  }
  if (validation === null) {
    codes.push(
      isCaptureValidatableArtifactType(envelope.artifactType)
        ? 'validation_not_run'
        : 'validation_not_applicable',
    )
  }
  return codes.map((code) => ({ code, message: EVIDENCE_GAP_MESSAGES[code] }))
}

function timelineFor(
  envelope: CaptureArtifact,
  correlation: CaptureCorrelation | null,
): readonly CaptureTimelineEvent[] {
  const events: CaptureTimelineEvent[] = [
    {
      kind: 'captured',
      at: envelope.provenance.capturedAt,
      label: 'Evidence captured',
      detail:
        envelope.provenance.sourceVersion === null
          ? `${envelope.provenance.sourceComponent} capture`
          : `${envelope.provenance.sourceComponent} ${envelope.provenance.sourceVersion}`,
    },
    {
      kind: 'received',
      at: envelope.provenance.receivedAt,
      label: 'Received and normalized',
      detail: 'AttestBook receipt timestamp; the source asserted capturedAt itself.',
    },
  ]
  if (correlation !== null) {
    events.push({
      kind: 'bound',
      at: correlation.rulebook.boundAt,
      label: 'Bound to pinned rulebook version',
      detail: `${correlation.rulebook.rulebookName} ${correlation.rulebook.version} · ${correlation.rulebook.attestationType} · SHA-256 ${correlation.rulebook.contentDigest}`,
    })
    events.push({
      kind: 'validated',
      at: correlation.validation.validatedAt,
      label: 'Validation recorded',
      detail: `${correlation.validation.overallStatus} · ${correlation.validation.violations.length} violation(s) · ${correlation.validation.limitations.length} limitation(s)`,
    })
  }
  return events
    .map((event, index) => ({ event, index, time: Date.parse(event.at) }))
    .sort((left, right) =>
      Number.isNaN(left.time) || Number.isNaN(right.time)
        ? left.index - right.index
        : left.time - right.time || left.index - right.index,
    )
    .map(({ event }) => event)
}

export interface MockCaptureExplorerOptions {
  readonly validation: CredentialValidationService
  /** Evidence store; defaults to an in-memory store for isolated tests. */
  readonly store?: CaptureStore
  /** Extra capture-issuer envelopes appended to the deterministic fixtures. */
  readonly additionalIssuerEnvelopes?: readonly unknown[]
  /** Extra capture-verifier envelopes appended to the deterministic fixtures. */
  readonly additionalVerifierEnvelopes?: readonly unknown[]
  readonly now?: () => Date
  readonly limits?: CaptureLimits
}

function mockSource(
  component: CaptureSourceComponent,
  pullCredential: string,
  acceptedCredentialHashes: readonly string[],
  envelopes: readonly unknown[],
  now: (() => Date) | undefined,
): MockCaptureSource {
  return new MockCaptureSource({
    component,
    acceptedCredentialHashes,
    pullCredential,
    envelopes,
    ...(now === undefined ? {} : { now }),
  })
}

/**
 * Builds the mock-backed explorer the server serves. Both capture components
 * use the deterministic local fixtures; the internal pull credential is
 * generated in memory so the adapter's authorization boundary is exercised
 * without shipping a secret.
 */
export function createMockCaptureExplorer(options: MockCaptureExplorerOptions): CaptureExplorer {
  const pullCredential = randomUUID()
  const acceptedCredentialHashes = [hashCaptureCredential(pullCredential)]
  const issuerEnvelopes = [
    ...mockCaptureEnvelopes('capture-issuer'),
    ...(options.additionalIssuerEnvelopes ?? []),
  ]
  const verifierEnvelopes = [
    ...mockCaptureEnvelopes('capture-verifier'),
    ...(options.additionalVerifierEnvelopes ?? []),
  ]
  return new CaptureExplorer({
    sources: [
      mockSource(
        'capture-issuer',
        pullCredential,
        acceptedCredentialHashes,
        issuerEnvelopes,
        options.now,
      ),
      mockSource(
        'capture-verifier',
        pullCredential,
        acceptedCredentialHashes,
        verifierEnvelopes,
        options.now,
      ),
    ],
    validation: options.validation,
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  })
}
