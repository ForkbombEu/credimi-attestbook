// Typed client for the public AttestBook catalogue API (issue #36).
//
// The catalog is a client of the same versioned API the server exposes; it
// never bypasses the API to read the registry. Error messages are the stable,
// safe messages of the API error envelope.

import type { Attestation, Provider, RulebookPage, RulebookVersion } from './types'

/** Hard cap of the catalogue API page size (`limit` maximum). */
export const CATALOG_PAGE_LIMIT = 100

export interface CatalogApi {
  listProviders(signal?: AbortSignal): Promise<readonly Provider[]>
  listRulebooks(signal?: AbortSignal): Promise<RulebookPage>
  listAttestations(rulebookId: string, signal?: AbortSignal): Promise<readonly Attestation[]>
  listVersions(rulebookId: string, signal?: AbortSignal): Promise<readonly RulebookVersion[]>
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

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ErrorEnvelope
    if (typeof body.error?.message === 'string' && body.error.message !== '') {
      return body.error.message
    }
  } catch {
    // A non-JSON error body must not replace the request failure.
  }
  return `The catalog request failed with HTTP ${response.status}.`
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
  return {
    async listProviders(signal) {
      const body = await getJson<unknown>(fetchImpl, '/api/v1/providers', signal)
      return singleData<readonly Provider[]>(body)
    },
    listRulebooks(signal) {
      const path = `/api/v1/rulebooks?limit=${CATALOG_PAGE_LIMIT}&offset=0`
      return getJson<RulebookPage>(fetchImpl, path, signal)
    },
    async listAttestations(rulebookId, signal) {
      const path = `/api/v1/rulebooks/${encodeURIComponent(rulebookId)}/attestations`
      const body = await getJson<unknown>(fetchImpl, path, signal)
      return singleData<readonly Attestation[]>(body)
    },
    async listVersions(rulebookId, signal) {
      const path = `/api/v1/rulebooks/${encodeURIComponent(rulebookId)}/versions`
      const body = await getJson<unknown>(fetchImpl, path, signal)
      return singleData<readonly RulebookVersion[]>(body)
    },
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}
