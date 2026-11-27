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
//
// Bun itself may need a writable temporary/cache directory to start a child,
// and a production container can run with a read-only root filesystem where
// the inherited `env: {}` has nowhere to write. The launcher therefore
// provisions one private directory per child, derives the child's whole
// environment from it and removes it afterwards. Nothing else from the server
// environment is inherited.

import { readFileSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultSandboxTempBase } from '../sandbox-temp'
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
  /**
   * Base directory for the per-child writable temporary/cache directory. The
   * server passes the configured `SANDBOX_TEMP_DIR`; tests may point it at a
   * private directory. Without it the launcher uses the OS temporary directory.
   */
  readonly tempDir?: string
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

/**
 * The complete environment of a sandbox child, all pointing at its private
 * directory. `BUN_TMPDIR` is Bun's own temporary directory, `TMPDIR` the POSIX
 * one, and `HOME` keeps any home-relative cache (such as `$HOME/.cache`) inside
 * the same directory. `XDG_CACHE_HOME` is deliberately not set: with `HOME`
 * present it defaults inside that private directory, so passing it would be
 * redundant. No inherited variable is included, so credentials, the database
 * path and the public origin never reach the child.
 */
export const SANDBOX_CHILD_ENVIRONMENT_KEYS = ['BUN_TMPDIR', 'TMPDIR', 'HOME'] as const

export type SandboxChildEnvironmentKey = (typeof SANDBOX_CHILD_ENVIRONMENT_KEYS)[number]

export function sandboxChildEnvironment(
  directory: string,
): Record<SandboxChildEnvironmentKey, string> {
  return {
    BUN_TMPDIR: directory,
    TMPDIR: directory,
    HOME: directory,
  }
}

export interface SandboxTempDirectory {
  readonly path: string
  cleanup(): Promise<void>
}

export interface SandboxBaseStat {
  readonly isDirectory: boolean
  readonly isSymbolicLink: boolean
  readonly uid: number
  readonly mode: number
}

/**
 * Decides whether a sandbox base directory is safe to create children in.
 * Returns `null` when it is, or a fixed reason otherwise.
 *
 * The base is used as-is and never chmod-ed, so the runtime user must control
 * it: either it is owned by the runtime user, or it is a sticky directory
 * owned by root (like `/tmp`) where our entry cannot be renamed by another
 * account. A sticky directory owned by another account is not enough, because
 * its owner can rename or remove any entry in it.
 */
export function sandboxBaseRefusal(
  info: SandboxBaseStat,
  runtimeUid: number | undefined,
): string | null {
  if (info.isSymbolicLink || !info.isDirectory) {
    return 'not a directory'
  }
  if (runtimeUid === undefined) {
    return 'unknown runtime user'
  }
  if (info.uid === runtimeUid) {
    return null
  }
  const sticky = (info.mode & 0o1000) !== 0
  if (sticky && info.uid === 0) {
    return null
  }
  return 'not owned by the runtime user or by root'
}

/**
 * Creates one private (0700) directory for a single child and returns its
 * cleanup.
 *
 * The configured base is used as-is and is never chmod-ed: it must be a real
 * directory owned by the runtime user, or a sticky directory owned by root such
 * as `/tmp`. Only the directory created here is made private. A base that is
 * not a real directory, or that another account controls and could replace, is
 * refused; the caller maps any throw to a controlled sandbox failure.
 */
export async function createSandboxTempDirectory(base?: string): Promise<SandboxTempDirectory> {
  const root = base ?? defaultSandboxTempBase()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  const refusal = sandboxBaseRefusal(
    {
      isDirectory: info.isDirectory(),
      isSymbolicLink: info.isSymbolicLink(),
      uid: info.uid,
      mode: info.mode,
    },
    process.getuid?.(),
  )
  if (refusal !== null) {
    throw new Error(`sandbox base refused: ${refusal}`)
  }
  const path = await mkdtemp(join(root, 'run-'))
  const created = await lstat(path)
  if ((created.mode & 0o777) !== 0o700) {
    await chmod(path, 0o700)
  }
  return {
    path,
    async cleanup(): Promise<void> {
      await rm(path, { recursive: true, force: true })
    },
  }
}

export type SandboxFailureReason =
  'temp_dir_unavailable' | 'spawn_failed' | 'child_exit' | 'launcher_error'

/** Closed set of stderr meanings; raw child output is never logged. */
export type SandboxStderrClass = 'none' | 'write_denied' | 'runtime_error'

/** Result of one sandbox child run before the caller parses its protocol. */
export type SandboxChildOutcome =
  | { readonly kind: 'ok'; readonly raw: string }
  | {
      readonly kind: 'failed'
      readonly reason: SandboxFailureReason
      readonly exitCode: number | null
      readonly stderrClass: SandboxStderrClass
    }
  | { readonly kind: Exclude<SandboxFailure, 'failed'> }

const MAX_STDERR_BYTES = 4_096

function classifyStderr(text: string): SandboxStderrClass {
  if (text.trim() === '') {
    return 'none'
  }
  if (/unable to write files|AccessDenied|EACCES|EPERM|EROFS/i.test(text)) {
    return 'write_denied'
  }
  return 'runtime_error'
}

/**
 * Reads a bounded prefix of a child stream so a noisy child cannot block on a
 * full pipe. The text itself is only ever classified, never logged.
 */
async function readBoundedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for await (const bytes of stream) {
      size += bytes.byteLength
      if (size > MAX_STDERR_BYTES) {
        break
      }
      chunks.push(bytes)
    }
  } catch {
    // A killed child may tear down its stream; a partial prefix is enough.
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Logs one sanitized sandbox failure. It records only a closed-set failure
 * class, the exit status, the Bun version and whether a deployment-specific
 * directory was configured. It never logs stderr, stdin, schema bytes, claims,
 * tokens or database credentials, so an unexpected client-facing 500 cannot
 * leak untrusted input through the server log.
 */
export function logSandboxFailure(
  reason: SandboxFailureReason,
  details: {
    readonly exitCode?: number | null
    readonly signalCode?: string | null
    readonly stderrClass?: SandboxStderrClass
    readonly configuredTempDir: boolean
  },
): void {
  console.error('schema sandbox child failure', {
    reason,
    runtime: `bun ${Bun.version}`,
    configuredTempDir: details.configuredTempDir,
    ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
    ...(details.signalCode === undefined ? {} : { signalCode: details.signalCode }),
    ...(details.stderrClass === undefined ? {} : { stderrClass: details.stderrClass }),
  })
}

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
  const configuredTempDir = limits.tempDir !== undefined

  // Reserve the concurrency slot before any asynchronous filesystem work so two
  // simultaneous callers cannot both pass the limit check.
  active += 1
  let tempDirectory: SandboxTempDirectory
  try {
    tempDirectory = await createSandboxTempDirectory(limits.tempDir)
  } catch {
    active -= 1
    logSandboxFailure('temp_dir_unavailable', { configuredTempDir })
    return { kind: 'failed', reason: 'temp_dir_unavailable', exitCode: null, stderrClass: 'none' }
  }

  let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  try {
    // `--no-env-file`: Bun would otherwise load a `.env` from the working
    // directory into the child, handing deployment secrets (such as the
    // administrator password hash) to code evaluating untrusted schemas.
    child = Bun.spawn([process.execPath, '--no-env-file', entry], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: sandboxChildEnvironment(tempDirectory.path),
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    })
  } catch {
    active -= 1
    await tempDirectory.cleanup().catch(() => undefined)
    logSandboxFailure('spawn_failed', { configuredTempDir })
    return { kind: 'failed', reason: 'spawn_failed', exitCode: null, stderrClass: 'none' }
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

    const stderrText = readBoundedText(child.stderr)
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
    const stderr = await stderrText

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
      const stderrClass = classifyStderr(stderr)
      logSandboxFailure('child_exit', {
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        stderrClass,
        configuredTempDir,
      })
      return { kind: 'failed', reason: 'child_exit', exitCode: child.exitCode, stderrClass }
    }

    return { kind: 'ok', raw: Buffer.concat(chunks).toString('utf8') }
  } catch {
    logSandboxFailure('launcher_error', { configuredTempDir })
    return { kind: 'failed', reason: 'launcher_error', exitCode: null, stderrClass: 'none' }
  } finally {
    if (watchdog !== undefined) {
      clearInterval(watchdog)
    }
    await tempDirectory.cleanup().catch(() => undefined)
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
