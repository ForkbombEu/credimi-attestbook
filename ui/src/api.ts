// Typed client for the public AttestBook product API (issues #36–#38).
//
// The UI is a client of the same versioned API the server exposes; it never
// bypasses the API to read the registry. Error messages are the stable, safe
// messages of the API error envelope, so a credential or claim value can never
// be echoed back through the client.

import type {
  Attestation,
  CredentialValidationResult,
  Provider,
  Rulebook,
  RulebookPage,
  RulebookVersion,
  SchemaReference,
  ValidateCredentialRequest,
} from './types'

/** Hard cap of the catalogue API page size (`limit` maximum). */
export const CATALOG_PAGE_LIMIT = 100

/** The product-API path that runs structural credential validation. */
export const CREDENTIAL_VALIDATION_PATH = '/api/v1/credentials/validate'

export interface CatalogApi {
  listProviders(signal?: AbortSignal): Promise<readonly Provider[]>
  listRulebooks(signal?: AbortSignal): Promise<RulebookPage>
  getRulebook(rulebookId: string, signal?: AbortSignal): Promise<Rulebook>
  listAttestations(rulebookId: string, signal?: AbortSignal): Promise<readonly Attestation[]>
  listSchemaReferences(
    rulebookId: string,
    signal?: AbortSignal,
  ): Promise<readonly SchemaReference[]>
  listVersions(rulebookId: string, signal?: AbortSignal): Promise<readonly RulebookVersion[]>
}

/**
 * The validation endpoint used by the playground. It is separate from
 * `CatalogApi` so the read-only catalog views do not depend on the mutating
 * request path, and tests can provide a fake validator without faking reads.
 */
export interface ValidationApi {
  validateCredential(
    input: ValidateCredentialRequest,
    signal?: AbortSignal,
  ): Promise<CredentialValidationResult>
}

export class CatalogApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'CatalogApiError'
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

interface ErrorEnvelope {
  readonly error?: {
    readonly message?: unknown
  }
}

async function readErrorMessage(response: Response, label = 'catalog'): Promise<string> {
  try {
    const body = (await response.json()) as ErrorEnvelope
    if (typeof body.error?.message === 'string' && body.error.message !== '') {
      return body.error.message
    }
  } catch {
    // A non-JSON error body must not replace the request failure.
  }
  return `The ${label} request failed with HTTP ${response.status}.`
}

function singleData<T>(body: unknown): T {
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new CatalogApiError('The catalog returned an unexpected response.', 0)
  }
  return (body as { readonly data: T }).data
}

async function getJson<T>(fetchImpl: FetchLike, path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetchImpl(path, {
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    throw new CatalogApiError(await readErrorMessage(response), response.status)
  }
  return (await response.json()) as T
}

/** Builds the HTTP client; `fetchImpl` is injectable for tests. */
export function createHttpCatalogApi(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): CatalogApi {
  const rulebookPath = (rulebookId: string) => `/api/v1/rulebooks/${encodeURIComponent(rulebookId)}`
  return {
    async listProviders(signal) {
      const body = await getJson<unknown>(fetchImpl, '/api/v1/providers', signal)
      return singleData<readonly Provider[]>(body)
    },
    listRulebooks(signal) {
      const path = `/api/v1/rulebooks?limit=${CATALOG_PAGE_LIMIT}&offset=0`
      return getJson<RulebookPage>(fetchImpl, path, signal)
    },
    async getRulebook(rulebookId, signal) {
      const body = await getJson<unknown>(fetchImpl, rulebookPath(rulebookId), signal)
      return singleData<Rulebook>(body)
    },
    async listAttestations(rulebookId, signal) {
      const path = `${rulebookPath(rulebookId)}/attestations`
      const body = await getJson<unknown>(fetchImpl, path, signal)
      return singleData<readonly Attestation[]>(body)
    },
    async listSchemaReferences(rulebookId, signal) {
      const path = `${rulebookPath(rulebookId)}/schema-references`
      const body = await getJson<unknown>(fetchImpl, path, signal)
      return singleData<readonly SchemaReference[]>(body)
    },
    async listVersions(rulebookId, signal) {
      const path = `${rulebookPath(rulebookId)}/versions`
      const body = await getJson<unknown>(fetchImpl, path, signal)
      return singleData<readonly RulebookVersion[]>(body)
    },
  }
}

/**
 * The public API path of a version snapshot's exact bytes. The link is an
 * export: the response carries `Content-Digest` and an `ETag` so a consumer can
 * verify it against the digest shown in the version history.
 */
export function versionContentPath(rulebookId: string, version: string): string {
  return `/api/v1/rulebooks/${encodeURIComponent(rulebookId)}/versions/${encodeURIComponent(version)}/content`
}

/**
 * Builds the HTTP client for `POST /api/v1/credentials/validate`. The credential
 * is sent in the request body only; it never appears in a URL, the result or an
 * error message.
 */
export function createHttpValidationApi(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): ValidationApi {
  return {
    async validateCredential(input, signal) {
      const response = await fetchImpl(CREDENTIAL_VALIDATION_PATH, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) {
        throw new CatalogApiError(await readErrorMessage(response, 'validation'), response.status)
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new CatalogApiError('The validation returned an unexpected response.', 0)
      }
      return singleData<CredentialValidationResult>(body)
    },
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}
