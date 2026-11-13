// Schema evaluation sandbox (issue #32, structural resource bound).
//
// The HTTP process prepares each reference cheaply (integrity, JSON parsing,
// depth, ambiguity and unsupported-keyword checks). Verified documents are sent
// to a separate Bun child process that compiles and runs them. The parent
// enforces a hard timeout, an RSS watchdog, an output cap and a concurrency
// cap, and fails closed on a platform without `/proc`.
//
// A hostile pinned schema can therefore at worst kill its sandbox and produce
// NOT_TESTED evidence; it cannot block the server's event loop or grow the
// server's memory without bound.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { HostedSchemaResolution } from './hosted-schema'
import {
  aggregateSchemaStatus,
  prepareSchemaDocuments,
  type PendingSchemaDocument,
  type PreparedSchemaDocuments,
  type SchemaApplication,
  type SchemaEvaluationInput,
  type SchemaValidationOutcome,
} from './schema'
import type { ParsedSdJwtVc } from './sd-jwt'
import type {
  SchemaDocumentInput,
  SchemaReferenceEvidence,
  SnapshotSchemaReference,
  VALIDATION_STATUSES,
  ValidationFinding,
  ValidationStatus,
} from './types'

type ValidationStatusValue = (typeof VALIDATION_STATUSES)[number]

/** Default resource bounds for one schema-evaluation child. */
export const DEFAULT_SANDBOX_LIMITS = {
  timeoutMs: 2_000,
  maxRssBytes: 256 * 2 ** 20,
  maxOutputBytes: 2 ** 20,
  maxConcurrent: 2,
} as const

export interface SchemaSandboxLimits {
  readonly timeoutMs?: number
  readonly maxRssBytes?: number
  readonly maxOutputBytes?: number
  readonly maxConcurrent?: number
  /** Worker entry override, used by tests. */
  readonly entry?: string
  /** Platform override, used to test fail-closed behaviour. */
  readonly platform?: NodeJS.Platform
}

export interface SandboxRequest {
  readonly items: readonly PendingSchemaDocument[]
  readonly input: SchemaEvaluationInput
}

export type SandboxFailure =
  'timeout' | 'memory_exceeded' | 'output_exceeded' | 'failed' | 'busy' | 'unavailable'

export type SandboxOutcome =
  | {
      readonly kind: 'ok'
      readonly results: readonly {
        readonly index: number
        readonly application: SchemaApplication
      }[]
    }
  | { readonly kind: SandboxFailure }

export interface ValidateSchemaDocumentsOptions {
  readonly references: readonly SnapshotSchemaReference[]
  readonly documents: readonly SchemaDocumentInput[]
  /** Resolved hosted documents by reference index; see `prepareSchemaDocuments`. */
  readonly hosted?: ReadonlyMap<number, HostedSchemaResolution>
  readonly parsed: ParsedSdJwtVc
}

let active = 0

function defaultEntry(): string {
  const url = new URL(import.meta.url)
  return url.pathname.endsWith('.ts')
    ? fileURLToPath(new URL('./schema-sandbox-entry.ts', url))
    : fileURLToPath(new URL('./validation/schema-sandbox-entry.js', url))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidationStatus(value: unknown): value is ValidationStatusValue {
  return (
    value === 'PASS' ||
    value === 'FAIL' ||
    value === 'NOT_TESTED' ||
    value === 'NOT_APPLICABLE' ||
    value === 'INCONCLUSIVE'
  )
}

function isFinding(value: unknown): value is ValidationFinding {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    (value.severity === 'error' || value.severity === 'warning' || value.severity === 'info') &&
    typeof value.dimension === 'string'
  )
}

/**
 * Strictly validates child output. Any duplicate, missing or unknown index, or
 * any malformed application, is a sandbox failure rather than trusted data.
 */
function parseSandboxResults(raw: string, request: SandboxRequest): SandboxOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'failed' }
  }
  if (!Array.isArray(parsed)) {
    return { kind: 'failed' }
  }

  const expected = new Set(request.items.map((item) => item.index))
  const seen = new Set<number>()
  const results: { index: number; application: SchemaApplication }[] = []

  for (const entry of parsed) {
    if (!isRecord(entry) || typeof entry.index !== 'number' || !expected.has(entry.index)) {
      return { kind: 'failed' }
    }
    if (seen.has(entry.index)) {
      return { kind: 'failed' }
    }
    seen.add(entry.index)
    const application = entry.application
    if (
      !isRecord(application) ||
      !isValidationStatus(application.status) ||
      typeof application.applied !== 'boolean' ||
      !Array.isArray(application.findings) ||
      !application.findings.every(isFinding)
    ) {
      return { kind: 'failed' }
    }
    results.push({
      index: entry.index,
      application: application as unknown as SchemaApplication,
    })
  }

  if (seen.size !== expected.size) {
    return { kind: 'failed' }
  }
  return { kind: 'ok', results }
}

function readRssBytes(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
  return match === null ? 0 : Number(match[1]) * 1_024
}

/** Result of one sandbox child run before the caller parses its protocol. */
export type SandboxChildOutcome =
  { readonly kind: 'ok'; readonly raw: string } | { readonly kind: SandboxFailure }

/**
 * Spawns one sandbox child and returns its raw stdout under the shared
 * timeout, RSS, output and concurrency bounds. Callers own the request and
 * response protocol and must parse `raw` strictly; this helper only transports
 * bytes. The concurrency counter is shared by every sandbox consumer.
 */
export async function runSandboxChild(
  entry: string,
  payload: unknown,
  limits: SchemaSandboxLimits = {},
): Promise<SandboxChildOutcome> {
  const platform = limits.platform ?? process.platform
  if (platform !== 'linux') {
    return { kind: 'unavailable' }
  }
  const maxConcurrent = limits.maxConcurrent ?? DEFAULT_SANDBOX_LIMITS.maxConcurrent
  if (active >= maxConcurrent) {
    return { kind: 'busy' }
  }

  const timeoutMs = limits.timeoutMs ?? DEFAULT_SANDBOX_LIMITS.timeoutMs
  const maxRssBytes = limits.maxRssBytes ?? DEFAULT_SANDBOX_LIMITS.maxRssBytes
  const maxOutputBytes = limits.maxOutputBytes ?? DEFAULT_SANDBOX_LIMITS.maxOutputBytes

  let child: Bun.Subprocess<'pipe', 'pipe', 'ignore'>
  active += 1
  try {
    child = Bun.spawn([process.execPath, entry], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      env: {},
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    })
  } catch {
    active -= 1
    return { kind: 'failed' }
  }

  let memoryExceeded = false
  let outputExceeded = false
  let watchdog: ReturnType<typeof setInterval> | undefined

  try {
    watchdog = setInterval(() => {
      try {
        if (readRssBytes(child.pid) > maxRssBytes) {
          memoryExceeded = true
          child.kill('SIGKILL')
        }
      } catch {
        // The child has already exited.
      }
    }, 10)

    try {
      await child.stdin.write(JSON.stringify(payload))
      await child.stdin.end()
    } catch {
      // The child may already have been killed.
    }

    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of child.stdout) {
      const bytes = chunk as Uint8Array
      size += bytes.byteLength
      if (size > maxOutputBytes) {
        outputExceeded = true
        child.kill('SIGKILL')
        break
      }
      chunks.push(bytes)
    }
    await child.exited

    if (memoryExceeded) {
      return { kind: 'memory_exceeded' }
    }
    if (outputExceeded) {
      return { kind: 'output_exceeded' }
    }
    if (child.signalCode === 'SIGKILL') {
      return { kind: 'timeout' }
    }
    if (child.exitCode !== 0) {
      return { kind: 'failed' }
    }

    return { kind: 'ok', raw: Buffer.concat(chunks).toString('utf8') }
  } catch {
    return { kind: 'failed' }
  } finally {
    if (watchdog !== undefined) {
      clearInterval(watchdog)
    }
    active -= 1
  }
}

export async function runSchemaSandbox(
  request: SandboxRequest,
  limits: SchemaSandboxLimits = {},
): Promise<SandboxOutcome> {
  const outcome = await runSandboxChild(limits.entry ?? defaultEntry(), request, limits)
  if (outcome.kind !== 'ok') {
    return outcome
  }
  return parseSandboxResults(outcome.raw, request)
}

function failureCode(kind: SandboxFailure): string {
  switch (kind) {
    case 'timeout':
      return 'schema_evaluation_timeout'
    case 'memory_exceeded':
      return 'schema_evaluation_memory_exceeded'
    case 'output_exceeded':
      return 'schema_evaluation_output_exceeded'
    case 'failed':
      return 'schema_evaluation_failed'
    case 'busy':
      return 'schema_sandbox_busy'
    case 'unavailable':
      return 'schema_sandbox_unavailable'
  }
}

function failureMessage(kind: SandboxFailure, limits: SchemaSandboxLimits): string {
  const timeoutMs = limits.timeoutMs ?? DEFAULT_SANDBOX_LIMITS.timeoutMs
  const maxRssMb = Math.round((limits.maxRssBytes ?? DEFAULT_SANDBOX_LIMITS.maxRssBytes) / 2 ** 20)
  switch (kind) {
    case 'timeout':
      return `Schema evaluation exceeded the ${timeoutMs} ms sandbox time limit; schema validation was not executed.`
    case 'memory_exceeded':
      return `Schema evaluation exceeded the ${maxRssMb} MiB sandbox memory limit; schema validation was not executed.`
    case 'output_exceeded':
      return 'Schema evaluation exceeded the sandbox output limit; schema validation was not executed.'
    case 'failed':
      return 'The schema evaluation sandbox failed; schema validation was not executed.'
    case 'busy':
      return 'The schema evaluation sandbox is at its concurrency limit; schema validation was not executed.'
    case 'unavailable':
      return 'The schema evaluation sandbox is unavailable on this platform; schema validation was not executed.'
  }
}

interface ResolvedReference {
  readonly index: number
  readonly application: SchemaApplication
  readonly evidence: SchemaReferenceEvidence
}

function pendingFailure(
  pending: PendingSchemaDocument,
  kind: SandboxFailure,
  limits: SchemaSandboxLimits,
): ResolvedReference {
  const finding: ValidationFinding = {
    code: failureCode(kind),
    message: failureMessage(kind, limits),
    severity: 'warning',
    dimension: 'schema_validation',
    path: `/schemaReferences/${pending.index}`,
  }
  return {
    index: pending.index,
    application: {
      reference: pending.reference,
      kind: pending.kind,
      applied: false,
      status: 'NOT_TESTED',
      findings: [...pending.integrityFindings, finding],
    },
    evidence: {
      formatIdentifier: pending.reference.formatIdentifier,
      uri: pending.reference.uri,
      integrity: pending.reference.integrity,
      kind: pending.kind,
      applied: false,
      source: pending.source ?? null,
    },
  }
}

function outcomeFrom(
  prepared: PreparedSchemaDocuments,
  resolved: readonly ResolvedReference[],
): SchemaValidationOutcome {
  const byIndex = new Map<number, ResolvedReference>()
  for (const entry of resolved) {
    byIndex.set(entry.index, entry)
  }
  const applications: SchemaApplication[] = []
  const schemaReferences: SchemaReferenceEvidence[] = []
  const statuses: ValidationStatus[] = []

  for (let index = 0; index < prepared.settled.length + prepared.pending.length; index += 1) {
    const entry = byIndex.get(index)
    if (entry === undefined) {
      continue
    }
    applications.push(entry.application)
    schemaReferences.push(entry.evidence)
    statuses.push(entry.application.status)
  }

  return {
    status: aggregateSchemaStatus(statuses),
    findings: applications.flatMap((application) => application.findings),
    applications,
    schemaReferences,
  }
}

/**
 * Evaluates every supplied schema document. Cheap checks stay in the HTTP
 * process; verified documents go through the sandbox. Sandbox failures become
 * NOT_TESTED evidence for the affected references, while references already
 * settled (for example an integrity mismatch) keep their own status.
 */
export async function validateSchemaDocuments(
  options: ValidateSchemaDocumentsOptions,
  limits: SchemaSandboxLimits = {},
): Promise<SchemaValidationOutcome> {
  const prepared = prepareSchemaDocuments({
    references: options.references,
    documents: options.documents,
    ...(options.hosted === undefined ? {} : { hosted: options.hosted }),
    claims: options.parsed.claims,
  })

  const resolved: ResolvedReference[] = prepared.settled.map((entry) => ({
    index: entry.index,
    application: entry.application,
    evidence: entry.evidence,
  }))

  if (prepared.pending.length === 0) {
    return outcomeFrom(prepared, resolved)
  }

  const input: SchemaEvaluationInput = {
    claims: options.parsed.claims,
    packedPayload: options.parsed.packedPayload,
    disclosureMap: Object.fromEntries(
      Object.entries(options.parsed.disclosureMap).map(([digest, disclosure]) => [
        digest,
        disclosure.key === undefined
          ? { value: disclosure.value }
          : { key: disclosure.key, value: disclosure.value },
      ]),
    ),
    vct: options.parsed.vct,
  }

  const sandbox = await runSchemaSandbox({ items: prepared.pending, input }, limits)
  if (sandbox.kind !== 'ok') {
    for (const pending of prepared.pending) {
      resolved.push(pendingFailure(pending, sandbox.kind, limits))
    }
    return outcomeFrom(prepared, resolved)
  }

  const byIndex = new Map(sandbox.results.map((entry) => [entry.index, entry.application]))
  for (const pending of prepared.pending) {
    const application = byIndex.get(pending.index)
    if (application === undefined) {
      resolved.push(pendingFailure(pending, 'failed', limits))
      continue
    }
    resolved.push({
      index: pending.index,
      application,
      evidence: {
        formatIdentifier: pending.reference.formatIdentifier,
        uri: pending.reference.uri,
        integrity: pending.reference.integrity,
        kind: application.kind,
        applied: application.applied,
        source: pending.source ?? null,
      },
    })
  }
  return outcomeFrom(prepared, resolved)
}
