export interface AppConfig {
  readonly hostname: string
  readonly port: number
  /** SQLite database file opened by the server, or `:memory:` for tests. */
  readonly databasePath: string
}

export const DEFAULT_HOSTNAME = '127.0.0.1'
export const DEFAULT_PORT = 3000
export const DEFAULT_DATABASE_PATH = 'attestbook.sqlite'

const PORT_PATTERN = /^[1-9]\d*$/

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
  }
}
