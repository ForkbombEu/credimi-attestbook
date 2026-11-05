export interface AppConfig {
  readonly hostname: string
  readonly port: number
}

export const DEFAULT_HOSTNAME = '127.0.0.1'
export const DEFAULT_PORT = 3000

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

  return {
    hostname: hostname === '' ? DEFAULT_HOSTNAME : hostname,
    port,
  }
}
