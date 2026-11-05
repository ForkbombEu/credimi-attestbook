// URL validation and DNS/SSRF resolution for untrusted remote imports.
//
// The import fetcher must never be steered at loopback, private, link-local,
// carrier-grade-NAT, multicast, reserved or cloud-metadata addresses. A URL is
// validated before any network activity, then its hostname is resolved once
// and every resolved address must be public; the HTTP transport connects to
// that pinned address so a second DNS answer cannot redirect the connection to
// an internal target (DNS rebinding).

import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

import { ImportError, importError } from './errors'
import type { ImportLimits } from './limits'

/** One resolved address of an import hostname. */
export interface HostAddress {
  readonly address: string
  readonly family: 4 | 6
}

/** Injectable DNS resolver; the default uses the operating system resolver. */
export type HostResolver = (hostname: string) => Promise<readonly HostAddress[]>

/** Options for resolving an import hostname. */
export interface ResolveImportTargetOptions {
  /** Bound on the DNS lookup; the caller's total fetch deadline may be tighter. */
  readonly timeoutMs?: number
}

/** A validated URL pinned to one public address. */
export interface ResolvedImportTarget {
  readonly url: URL
  readonly hostname: string
  readonly address: string
  readonly family: 4 | 6
  readonly port: number
}

/** Resolver used in production; tests inject a deterministic resolver. */
export const systemHostResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true })
  const addresses: HostAddress[] = []
  for (const record of records) {
    if (record.family !== 4 && record.family !== 6) {
      throw importError(
        'dns_failure',
        'the import hostname resolved to an unsupported address family',
      )
    }
    addresses.push({ address: record.address, family: record.family })
  }
  return addresses
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/**
 * Rejects any URL that is not an absolute `https` URL on the default port
 * without embedded credentials. The fragment is stripped because it is never
 * sent to the server. IP-literal hosts are checked here; DNS names are checked
 * by `resolveImportTarget`.
 */
export function validateImportUrl(value: unknown, limits: ImportLimits): URL {
  if (typeof value !== 'string') {
    throw importError('invalid_url', 'the import URL must be a string')
  }
  const raw = value.trim()
  if (raw === '') {
    throw importError('invalid_url', 'the import URL must not be empty')
  }
  if (raw.length > limits.maxUrlLength) {
    throw importError(
      'invalid_url',
      `the import URL must be at most ${limits.maxUrlLength} characters`,
    )
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw importError('invalid_url', 'the import URL must be an absolute URL')
  }

  if (url.protocol !== 'https:') {
    throw importError('invalid_url', 'the import URL must use https')
  }
  if (url.username !== '' || url.password !== '') {
    throw importError('invalid_url', 'the import URL must not embed credentials')
  }
  if (url.hostname === '') {
    throw importError('invalid_url', 'the import URL must name a host')
  }
  if (url.port !== '' && url.port !== '443') {
    throw importError('invalid_url', 'the import URL must use the default https port')
  }
  // Fragments are client-side only; removing them keeps provenance and
  // redirect comparison consistent with what is requested.
  url.hash = ''

  const hostname = stripBrackets(url.hostname)
  if (isIP(hostname) !== 0 && isBlockedAddress(hostname)) {
    throw importError('blocked_address', 'the import URL resolves to a blocked address')
  }

  return url
}

function parseIpv4(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) {
    return null
  }
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null
    }
    const octet = Number(part)
    if (octet > 255) {
      return null
    }
    value = value * 256 + octet
  }
  return value >>> 0
}

function isBlockedIpv4(value: number): boolean {
  const a = (value >>> 24) & 0xff
  const b = (value >>> 16) & 0xff
  const c = (value >>> 8) & 0xff

  if (a === 0) return true // "this network"
  if (a === 10) return true // private
  if (a === 127) return true // loopback
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true // IETF / TEST-NET-1
  if (a === 192 && b === 168) return true // private
  if (a === 192 && b === 88 && c === 99) return true // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51 && c === 100) return true // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true // TEST-NET-3
  if (a >= 224 && a <= 239) return true // multicast
  if (a >= 240) return true // reserved, including 255.255.255.255
  return false
}

function parseIpv6(address: string): readonly number[] | null {
  const input = address.toLowerCase()
  if (input === '' || input.includes('%')) {
    return null
  }

  let expanded = input
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':')
    if (lastColon === -1) {
      return null
    }
    const ipv4 = parseIpv4(input.slice(lastColon + 1))
    if (ipv4 === null) {
      return null
    }
    const high = (ipv4 >>> 16) & 0xffff
    const low = ipv4 & 0xffff
    expanded = `${input.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`
  }

  const halves = expanded.split('::')
  if (halves.length > 2) {
    return null
  }

  const parseGroups = (part: string): number[] | null => {
    if (part === '') {
      return []
    }
    const groups: number[] = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return null
      }
      groups.push(Number.parseInt(group, 16))
    }
    return groups
  }

  const head = parseGroups(halves[0] ?? '')
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : []
  if (head === null || tail === null) {
    return null
  }

  if (halves.length === 1) {
    return head.length === 8 ? head : null
  }
  if (head.length + tail.length > 7) {
    return null
  }
  const missing = 8 - head.length - tail.length
  return [...head, ...new Array<number>(missing).fill(0), ...tail]
}

function isBlockedIpv6(address: string): boolean {
  const groups = parseIpv6(address)
  if (groups === null) {
    return true // fail closed on an address form we cannot inspect
  }
  const [first, second] = groups

  // :: and ::1
  if (groups.every((group) => group === 0)) return true
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true

  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 deprecated
  // site-local, ff00::/8 multicast.
  if (first !== undefined && (first & 0xfe00) === 0xfc00) return true
  if (first !== undefined && (first & 0xffc0) === 0xfe80) return true
  if (first !== undefined && (first & 0xffc0) === 0xfec0) return true
  if (first !== undefined && (first & 0xff00) === 0xff00) return true

  // 2001:db8::/32 documentation, 2002::/16 6to4, 2001::/32 Teredo and the
  // 2001:10::/28 / 2001:20::/28 ORCHID ranges (not public unicast targets).
  if (first === 0x2001 && second === 0x0db8) return true
  if (first === 0x2001 && second === 0) return true
  if (
    first === 0x2001 &&
    second !== undefined &&
    ((second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020)
  ) {
    return true
  }
  if (first === 0x2002) return true

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses
  // must be judged by the embedded IPv4 address.
  if (groups.slice(0, 5).every((group) => group === 0)) {
    if (groups[5] === 0xffff || groups[5] === 0) {
      const high = groups[6]
      const low = groups[7]
      if (high !== undefined && low !== undefined) {
        return isBlockedIpv4(((high << 16) | low) >>> 0)
      }
      return true
    }
  }

  // 64:ff9b::/32 (the well-known and local-use NAT64 prefixes) maps an
  // arbitrary IPv4 address; block it rather than relying on the embedded
  // address's representation.
  if (first === 0x0064 && second === 0xff9b) return true

  return false
}

/** True when an address must never be connected to by the importer. */
export function isBlockedAddress(address: string): boolean {
  const raw = stripBrackets(address.trim())
  const ipv4 = parseIpv4(raw)
  if (ipv4 !== null) {
    return isBlockedIpv4(ipv4)
  }
  if (isIP(raw) === 6) {
    return isBlockedIpv6(raw)
  }
  return true
}

async function resolveWithTimeout(
  resolver: HostResolver,
  hostname: string,
  timeoutMs: number,
): Promise<readonly HostAddress[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<readonly HostAddress[]>((resolve, reject) => {
      timer = setTimeout(
        () => reject(importError('timeout', 'the import hostname lookup timed out')),
        Math.max(1, timeoutMs),
      )
      Promise.resolve()
        .then(() => resolver(hostname))
        .then(resolve, reject)
    })
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

/**
 * Resolves a validated URL to one public address. Every resolved address must
 * be public: a hostname with a mixed public/private answer is rejected instead
 * of taking the first answer.
 */
export async function resolveImportTarget(
  url: URL,
  resolver: HostResolver = systemHostResolver,
  options: ResolveImportTargetOptions = {},
): Promise<ResolvedImportTarget> {
  const hostname = stripBrackets(url.hostname)
  const port = url.port === '' ? 443 : Number(url.port)

  const literal = isIP(hostname)
  if (literal !== 0) {
    if (isBlockedAddress(hostname)) {
      throw importError('blocked_address', 'the import URL resolves to a blocked address')
    }
    return {
      url,
      hostname,
      address: hostname,
      family: literal === 4 ? 4 : 6,
      port,
    }
  }

  let addresses: readonly HostAddress[]
  try {
    addresses =
      options.timeoutMs === undefined
        ? await resolver(hostname)
        : await resolveWithTimeout(resolver, hostname, options.timeoutMs)
  } catch (error) {
    if (error instanceof ImportError) {
      throw error
    }
    throw importError('dns_failure', 'the import hostname could not be resolved')
  }

  if (addresses.length === 0) {
    throw importError('dns_failure', 'the import hostname resolved to no addresses')
  }
  for (const record of addresses) {
    if (isBlockedAddress(record.address)) {
      throw importError('blocked_address', 'the import hostname resolves to a blocked address')
    }
  }

  const chosen = addresses[0]
  if (chosen === undefined) {
    throw importError('dns_failure', 'the import hostname resolved to no addresses')
  }
  return {
    url,
    hostname,
    address: chosen.address,
    family: chosen.family,
    port,
  }
}
