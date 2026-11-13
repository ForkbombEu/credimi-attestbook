// Resolution of AttestBook-hosted schema documents for credential validation
// (issue #101).
//
// A rulebook version may reference a schema with the permanent AttestBook URL
// produced by the credential-schema store (#98). Such a reference is resolved
// from the immutable local store, never over HTTP: the HTTP process reads the
// exact stored bytes, recomputes their SHA-256 and only then hands them to the
// existing bounded schema sandbox.
//
// A URI is recognised as hosted only when it is exactly the canonical content
// URL of this deployment: the configured public origin, the canonical
// single-segment path and no credentials, query or fragment. A URI is never
// classified from a string prefix, so an attacker-controlled origin or a
// near-miss path stays an ordinary external reference and still needs its
// exact bytes from the caller.

import { sha256Hex } from '../registry/digest'
import { RegistryError } from '../registry/errors'
import type { CredentialSchemaDocumentContent } from '../registry/types'
import { MAX_ID_LENGTH } from '../registry/validation'

import type { SnapshotSchemaReference } from './types'

/** Canonical path prefix of one stored schema document's content route. */
const HOSTED_SCHEMA_PATH_PREFIX = '/api/v1/schema-documents/'
/** Canonical path suffix of the content route. */
const HOSTED_SCHEMA_PATH_SUFFIX = '/content'
/** Document identifiers are UUIDs; the path segment is never percent-encoded. */
const HOSTED_SCHEMA_ID_PATTERN = /^[A-Za-z0-9._~-]+$/

/** The narrow store read the validator needs; `Registry` satisfies it. */
export interface HostedSchemaDocumentStore {
  getCredentialSchemaDocumentContent(id: string): CredentialSchemaDocumentContent | null
}

/**
 * Enables hosted resolution for one validator. It is absent when the
 * deployment has no configured public origin, so no URI can be a canonical
 * hosted URL of this deployment.
 */
export interface HostedSchemaOptions {
  /** Trusted public origin, from `PUBLIC_BASE_URL`; never a request header. */
  readonly publicBaseUrl: string
  readonly store: HostedSchemaDocumentStore
}

/**
 * How one reference was resolved against the local store:
 *
 * - `resolved`: the store returned the document and its exact bytes match the
 *   recorded digest; `content` is the exact UTF-8 text the sandbox evaluates.
 * - `missing`: the URI is canonical for this deployment but no document with
 *   that identifier exists.
 * - `corrupt`: the stored bytes do not hash to the recorded digest (or are not
 *   valid UTF-8), so they must never be treated as the trusted document.
 */
export type HostedSchemaResolution =
  | {
      readonly kind: 'resolved'
      readonly documentId: string
      readonly contentDigest: string
      readonly content: string
    }
  | { readonly kind: 'missing'; readonly documentId: string }
  | { readonly kind: 'corrupt'; readonly documentId: string }

/**
 * Returns the stored document identifier when `uri` is exactly the canonical
 * hosted content URL for this deployment's public origin; otherwise `null`.
 *
 * The check is deliberately strict: an origin that merely contains the
 * configured origin, an extra path segment, a query, a fragment or userinfo is
 * not a hosted URL and is left to the caller-supplied document flow.
 */
export function hostedSchemaDocumentId(uri: string, publicBaseUrl: string): string | null {
  let base: URL
  let target: URL
  try {
    base = new URL(publicBaseUrl)
    target = new URL(uri)
  } catch {
    return null
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    return null
  }
  if (target.protocol !== base.protocol || target.origin !== base.origin) {
    return null
  }
  if (target.username !== '' || target.password !== '') {
    return null
  }
  if (target.search !== '' || target.hash !== '') {
    return null
  }
  const path = target.pathname
  if (!path.startsWith(HOSTED_SCHEMA_PATH_PREFIX) || !path.endsWith(HOSTED_SCHEMA_PATH_SUFFIX)) {
    return null
  }
  const segment = path.slice(
    HOSTED_SCHEMA_PATH_PREFIX.length,
    path.length - HOSTED_SCHEMA_PATH_SUFFIX.length,
  )
  if (
    segment === '' ||
    segment.length > MAX_ID_LENGTH ||
    segment.includes('/') ||
    !HOSTED_SCHEMA_ID_PATTERN.test(segment)
  ) {
    return null
  }
  return segment
}

function decodeExactUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Resolves every reference that is a canonical hosted URL of this deployment.
 * References that are not hosted are absent from the returned map and keep the
 * caller-supplied document flow. The returned bytes are verified against the
 * document's recorded SHA-256 before they can reach the sandbox.
 */
export function resolveHostedSchemaDocuments(options: {
  readonly references: readonly SnapshotSchemaReference[]
  readonly publicBaseUrl: string
  readonly store: HostedSchemaDocumentStore
}): ReadonlyMap<number, HostedSchemaResolution> {
  const resolutions = new Map<number, HostedSchemaResolution>()
  options.references.forEach((reference, index) => {
    const documentId = hostedSchemaDocumentId(reference.uri, options.publicBaseUrl)
    if (documentId === null) {
      return
    }
    // A store read is part of evaluation, never a way to fail the whole
    // request: an input-validation failure means the URL cannot name a stored
    // document. Any other error (I/O, corruption) still fails closed upward.
    let stored: CredentialSchemaDocumentContent | null
    try {
      stored = options.store.getCredentialSchemaDocumentContent(documentId)
    } catch (error) {
      if (error instanceof RegistryError && error.code === 'invalid_input') {
        resolutions.set(index, { kind: 'missing', documentId })
        return
      }
      throw error
    }
    if (stored === null) {
      resolutions.set(index, { kind: 'missing', documentId })
      return
    }
    // The URI-to-digest binding is the document identity: the URL names the
    // document, the store records one digest for it. Never apply bytes that do
    // not hash to that digest, even when the SRI value happens to match them.
    if (sha256Hex(stored.bytes) !== stored.document.contentDigest) {
      resolutions.set(index, { kind: 'corrupt', documentId })
      return
    }
    const content = decodeExactUtf8(stored.bytes)
    if (content === null) {
      resolutions.set(index, { kind: 'corrupt', documentId })
      return
    }
    resolutions.set(index, {
      kind: 'resolved',
      documentId,
      contentDigest: stored.document.contentDigest,
      content,
    })
  })
  return resolutions
}
