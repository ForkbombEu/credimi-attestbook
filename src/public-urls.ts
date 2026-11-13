// Canonical public URLs for AttestBook-hosted credential schema documents
// (issue #98).
//
// A hosted schema URI is permanent: it is written into an existing TS11
// `schemaURIs[].uri` or rulebook `schemaReferences[].uri` and must keep
// resolving to the exact same immutable bytes. The origin therefore comes from
// explicit deployment configuration only. The request's `Host`, `Forwarded` or
// `X-Forwarded-*` headers never select the canonical origin, so a caller cannot
// mint an attacker-controlled URL that later appears in a rulebook or snapshot.

/** Environment variable carrying the trusted public origin. */
export const PUBLIC_BASE_URL_ENV = 'PUBLIC_BASE_URL'

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Canonical, version-independent URL target for one stored schema document.
 * The identifier is opaque and immutable, so the path is stable for the
 * lifetime of the document. Percent-encoding keeps the path a single segment.
 */
export function credentialSchemaDocumentPath(documentId: string): string {
  return `/api/v1/schema-documents/${encodeURIComponent(documentId)}/content`
}

/** Absolute canonical URL of one stored schema document's exact bytes. */
export function credentialSchemaDocumentUrl(publicBaseUrl: string, documentId: string): string {
  return `${publicBaseUrl}${credentialSchemaDocumentPath(documentId)}`
}

/**
 * W3C Subresource Integrity value (`sha256-<base64>`) for a lowercase hex
 * SHA-256 digest. It pins the exact bytes the same way the `Content-Digest`
 * and `ETag` response headers do.
 */
export function sha256Sri(hexDigest: string): string {
  return `sha256-${Buffer.from(hexDigest, 'hex').toString('base64')}`
}

/**
 * Parses and validates the trusted public base URL.
 *
 * Returns `null` when the variable is absent or blank; a deployment that does
 * not publish hosted schema URLs is still a valid deployment. Any other
 * malformed value fails fast, because silently accepting a wrong origin would
 * put unusable or untrusted permanent URLs into published rulebooks.
 *
 * Only an origin is accepted: no credentials, path, query or fragment. Public
 * deployments must use `https`. Plain `http` is accepted for loopback hosts
 * only, so local development and the user acceptance tests can address the
 * server they started without disabling TLS verification anywhere real.
 */
export function parsePublicBaseUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? ''
  if (trimmed === '') {
    return null
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(
      'invalid PUBLIC_BASE_URL: expected an absolute URL such as "https://attestbook.example"',
    )
  }

  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      'invalid PUBLIC_BASE_URL: a public origin must use https (plain http is allowed only for loopback hosts)',
    )
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('invalid PUBLIC_BASE_URL: credentials must not be part of a public origin')
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      'invalid PUBLIC_BASE_URL: expected only an origin, without a path, query or fragment',
    )
  }
  if (url.hostname === '0.0.0.0' || url.hostname === '::' || url.hostname === '[::]') {
    throw new Error('invalid PUBLIC_BASE_URL: expected a reachable public host, not a wildcard')
  }

  return url.origin
}
