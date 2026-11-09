export interface AppConfig {
  readonly hostname: string
  readonly port: number
  /** SQLite database file opened by the server, or `:memory:` for tests. */
  readonly databasePath: string
  /** Hard wall-clock limit for the schema-evaluation sandbox child. */
  readonly schemaSandboxTimeoutMs: number
  /** RSS limit for the schema-evaluation sandbox child. */
  readonly schemaSandboxMaxRssMb: number
  /** Maximum number of concurrent schema-evaluation sandbox children. */
  readonly schemaSandboxConcurrency: number
  /** Maximum number of parsed immutable rulebook snapshots cached in-process. */
  readonly validationCacheMaxEntries: number
  /** Maximum total snapshot bytes cached in-process (MiB). */
  readonly validationCacheMaxMb: number
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
  }
}
