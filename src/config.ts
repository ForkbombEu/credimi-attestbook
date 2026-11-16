import { dirname, join, resolve } from 'node:path'

import { parsePublicBaseUrl } from './public-urls'
import { SANDBOX_TEMP_DIRECTORY_NAME, defaultSandboxTempBase } from './sandbox-temp'

export interface AppConfig {
  readonly hostname: string
  readonly port: number
  /** SQLite database file opened by the server, or `:memory:` for tests. */
  readonly databasePath: string
  /**
   * Trusted public origin used to build permanent hosted-schema URLs (#98), or
   * `null` when the deployment does not publish them. It is never derived from
   * request headers. See `src/public-urls.ts`.
   */
  readonly publicBaseUrl: string | null
  /** Hard wall-clock limit for the schema-evaluation sandbox child. */
  readonly schemaSandboxTimeoutMs: number
  /** RSS limit for the schema-evaluation sandbox child. */
  readonly schemaSandboxMaxRssMb: number
  /** Maximum number of concurrent schema-evaluation sandbox children. */
  readonly schemaSandboxConcurrency: number
  /**
   * Private writable base directory for the sandbox child's temporary and
   * cache files. The launcher creates one per-child directory beneath it and
   * removes it after the child exits; the child receives no other writable
   * environment. It defaults to the database's directory so a read-only root
   * filesystem still has a writable location. See `SANDBOX_TEMP_DIR`.
   */
  readonly schemaSandboxTempDir: string
  /** Maximum number of parsed immutable rulebook snapshots cached in-process. */
  readonly validationCacheMaxEntries: number
  /** Maximum total snapshot bytes cached in-process (MiB). */
  readonly validationCacheMaxMb: number
  /**
   * Test-only opt-in that lets a webhook callback use plain `http` on a
   * literal loopback address. Off in production; the local UAT start script
   * enables it so a disposable callback server can be reached. It never
   * permits a DNS name to resolve to a non-public address.
   */
  readonly subscriptionsAllowLoopbackHttp: boolean
}

export const DEFAULT_HOSTNAME = '127.0.0.1'
export const DEFAULT_PORT = 3000
export const DEFAULT_DATABASE_PATH = 'attestbook.sqlite'
export const DEFAULT_SCHEMA_SANDBOX_TIMEOUT_MS = 2_000
export const DEFAULT_SCHEMA_SANDBOX_MAX_RSS_MB = 256
export const DEFAULT_SCHEMA_SANDBOX_CONCURRENCY = 2
export const DEFAULT_VALIDATION_CACHE_MAX_ENTRIES = 64
export const DEFAULT_VALIDATION_CACHE_MAX_MB = 16

const PORT_PATTERN = /^[1-9]\d*$/
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/

function booleanFlag(env: Record<string, string | undefined>, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase() ?? ''
  if (raw === '' || raw === '0' || raw === 'false') {
    return false
  }
  if (raw === '1' || raw === 'true') {
    return true
  }
  throw new Error(`invalid ${name} "${raw}": expected true or false`)
}

/**
 * Resolves the writable base directory for sandbox children. A deployment may
 * override it with `SANDBOX_TEMP_DIR`; otherwise it sits next to the SQLite
 * database, which the documented container configuration already mounts
 * writable (`/data`), so it also works under a read-only root filesystem.
 * An in-memory database has no directory, so the private OS temporary
 * directory is the only documented writable location left.
 */
export function resolveSchemaSandboxTempDir(
  env: Record<string, string | undefined>,
  databasePath: string,
): string {
  const raw = env.SANDBOX_TEMP_DIR?.trim() ?? ''
  if (raw !== '') {
    if (raw.includes('\0')) {
      throw new Error('invalid SANDBOX_TEMP_DIR: expected a filesystem path')
    }
    return resolve(raw)
  }
  if (databasePath === ':memory:') {
    return defaultSandboxTempBase()
  }
  return join(dirname(resolve(databasePath)), SANDBOX_TEMP_DIRECTORY_NAME)
}

function positiveInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim() ?? ''
  if (raw === '') {
    return fallback
  }
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) {
    throw new Error(`invalid ${name} "${raw}": expected a positive integer`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`invalid ${name} "${raw}": expected a positive integer`)
  }
  return value
}

/**
 * Reads the small runtime configuration surface. Invalid values fail fast so a
 * misconfigured container exits instead of serving on an unexpected port.
 */
export function loadConfig(env: Record<string, string | undefined> = Bun.env): AppConfig {
  const rawPort = env.PORT ?? String(DEFAULT_PORT)
  const port = Number(rawPort)

  if (!PORT_PATTERN.test(rawPort) || port < 1 || port > 65_535) {
    throw new Error(`invalid PORT "${rawPort}": expected an integer between 1 and 65535`)
  }

  const hostname = env.HOST?.trim() ?? ''
  const rawDatabasePath = env.DATABASE_PATH?.trim() ?? ''
  const databasePath = rawDatabasePath === '' ? DEFAULT_DATABASE_PATH : rawDatabasePath
  if (databasePath.includes('\0')) {
    throw new Error('invalid DATABASE_PATH: expected a filesystem path or ":memory:"')
  }

  return {
    hostname: hostname === '' ? DEFAULT_HOSTNAME : hostname,
    port,
    databasePath,
    publicBaseUrl: parsePublicBaseUrl(env.PUBLIC_BASE_URL),
    schemaSandboxTimeoutMs: positiveInteger(
      env,
      'SCHEMA_SANDBOX_TIMEOUT_MS',
      DEFAULT_SCHEMA_SANDBOX_TIMEOUT_MS,
    ),
    schemaSandboxMaxRssMb: positiveInteger(
      env,
      'SCHEMA_SANDBOX_MAX_RSS_MB',
      DEFAULT_SCHEMA_SANDBOX_MAX_RSS_MB,
    ),
    schemaSandboxConcurrency: positiveInteger(
      env,
      'SCHEMA_SANDBOX_CONCURRENCY',
      DEFAULT_SCHEMA_SANDBOX_CONCURRENCY,
    ),
    schemaSandboxTempDir: resolveSchemaSandboxTempDir(env, databasePath),
    validationCacheMaxEntries: positiveInteger(
      env,
      'VALIDATION_CACHE_MAX_ENTRIES',
      DEFAULT_VALIDATION_CACHE_MAX_ENTRIES,
    ),
    validationCacheMaxMb: positiveInteger(
      env,
      'VALIDATION_CACHE_MAX_MB',
      DEFAULT_VALIDATION_CACHE_MAX_MB,
    ),
    subscriptionsAllowLoopbackHttp: booleanFlag(env, 'SUBSCRIPTIONS_ALLOW_LOOPBACK_HTTP'),
  }
}
