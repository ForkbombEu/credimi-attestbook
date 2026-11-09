// Unit tests for the standalone Credimi integration adapter (issue #49).
//
// These exercise the transport and contract boundary without a network: the
// injected fetch records every call, so the pinned request bodies, the retry
// policy, the response bound and every typed failure are asserted exactly. The
// real-server round-trip lives in `server.test.ts`.

import { describe, expect, test } from 'bun:test'

import {
  buildHeadlessWalletComparison,
  type ComparisonEvidenceSource,
  type ExternalWalletObservation,
} from '../../comparison'
import {
  comparisonSource,
  externalWalletObservation,
  TEST_CAPTURE_ID,
  TEST_COMPARED_AT,
  TEST_WALLET_ID,
} from '../../comparison/test/fixtures'

import { conformanceResultSchema, headlessWalletComparisonSchema } from '../../api/schemas'
import {
  conformanceResult,
  TEST_CREDENTIAL,
  TEST_SCHEMA_CONTENT,
  TEST_SCHEMA_URI,
} from '../../conformance/test/fixtures'

import {
  assertPinnedComparison,
  assertPinnedConformance,
  assertPinnedCorrelation,
  assertPinnedValidation,
  CredimiAdapter,
  CredimiAdapterError,
  credimiRulebookPinSchema,
  isCredimiAdapterError,
  RULEBOOK_PIN_KIND,
  type CredimiAdapterOptions,
  type CredimiConformanceResult,
  type CredimiEvidenceCorrelation,
  type CredimiExternalWalletObservation,
  type CredimiHeadlessWalletComparison,
  type CredimiRulebook,
  type CredimiRulebookPage,
  type CredimiRulebookPin,
  type CredimiValidationEvidence,
} from './index'

const BASE_URL = 'http://attestbook.test'
const DIGEST = 'a'.repeat(64)
const PIN: CredimiRulebookPin = {
  kind: RULEBOOK_PIN_KIND,
  rulebookId: 'rulebook-1',
  version: '1.0',
  contentDigest: DIGEST,
  specVersion: 'ts11@1.0.1',
  attestationType: 'PID',
}
const VERSION_RECORD = {
  id: 'version-1',
  rulebookId: 'rulebook-1',
  version: '1.0',
  status: 'published',
  contentDigest: DIGEST,
  specVersion: 'ts11@1.0.1',
  createdAt: '2026-01-01T00:00:00.000Z',
  publishedAt: '2026-01-01T00:00:00.000Z',
}
const RULEBOOK: CredimiRulebook = {
  id: 'rulebook-1',
  providerId: 'provider-1',
  name: 'PID Rulebook',
  description: 'Fixture rulebook',
  sourceUrl: null,
  applicableSpec: 'ts11@1.0.1',
  publicationStatus: 'published',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}
const RULEBOOK_PAGE: CredimiRulebookPage = {
  data: [RULEBOOK],
  pagination: { limit: 50, offset: 0, total: 1 },
}

interface FetchCall {
  readonly input: Parameters<typeof fetch>[0]
  readonly init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status)
}

function fakeFetch(handler: (call: FetchCall, index: number) => Response | Promise<Response>): {
  readonly fetch: typeof fetch
  readonly calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchFn = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const call: FetchCall = { input, init: init ?? {} }
    calls.push(call)
    return handler(call, calls.length - 1)
  }) as typeof fetch
  return { fetch: fetchFn, calls }
}

function firstCall(calls: readonly FetchCall[]): FetchCall {
  const call = calls[0]
  if (call === undefined) {
    throw new Error('the adapter did not call fetch')
  }
  return call
}

function requestUrl(call: FetchCall): URL {
  const input = call.input
  if (typeof input === 'string') {
    return new URL(input)
  }
  return input instanceof URL ? new URL(input.href) : new URL(input.url)
}

function requestBody(call: FetchCall): unknown {
  const body = call.init.body
  if (typeof body !== 'string') {
    throw new Error('expected the adapter to send a string request body')
  }
  return JSON.parse(body)
}

function authorizationOf(call: FetchCall): string | null {
  const headers = call.init.headers
  return headers instanceof Headers
    ? headers.get('authorization')
    : ((headers as Record<string, string> | undefined)?.authorization ?? null)
}

async function rejection(promise: Promise<unknown>): Promise<CredimiAdapterError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CredimiAdapterError) {
      return error
    }
    throw error
  }
  throw new Error('expected the adapter to reject')
}

function configurationError(options: CredimiAdapterOptions): CredimiAdapterError {
  try {
    new CredimiAdapter(options)
  } catch (error) {
    if (error instanceof CredimiAdapterError) {
      return error
    }
    throw error
  }
  throw new Error('expected the adapter configuration to be rejected')
}

describe('adapter configuration', () => {
  test('rejects an invalid base URL, token and bounds', () => {
    const invalidOptions: readonly CredimiAdapterOptions[] = [
      { baseUrl: 'attestbook.test' },
      { baseUrl: '' },
      { baseUrl: 'ftp://attestbook.test' },
      { baseUrl: 'https://user:secret@attestbook.test' },
      { baseUrl: 'https://attestbook.test?tenant=1' },
      { baseUrl: 'https://attestbook.test#fragment' },
      { baseUrl: BASE_URL, token: '   ' },
      { baseUrl: BASE_URL, timeoutMs: 0 },
      { baseUrl: BASE_URL, timeoutMs: 120_001 },
      { baseUrl: BASE_URL, retries: 4 },
      { baseUrl: BASE_URL, retryDelayMs: 10_001 },
      { baseUrl: BASE_URL, maxResponseBytes: 0 },
    ]

    for (const options of invalidOptions) {
      const error = configurationError(options)
      expect({ options, code: error.code }).toEqual({
        options,
        code: 'invalid_configuration',
      })
    }
  })

  test('keeps a base path prefix and drops trailing slashes', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(RULEBOOK_PAGE))
    const client = new CredimiAdapter({
      baseUrl: 'https://host.test/attestbook/',
      fetch,
    })

    await client.listRulebooks()

    expect(requestUrl(firstCall(calls)).pathname).toBe('/attestbook/api/v1/rulebooks')
  })
})

describe('catalogue and version reads', () => {
  test('passes filters as query parameters and parses the page', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(RULEBOOK_PAGE))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const page = await client.listRulebooks({
      providerId: 'provider 1',
      status: 'published',
      limit: 10,
      offset: 5,
    })

    const url = requestUrl(firstCall(calls))
    expect(url.pathname).toBe('/api/v1/rulebooks')
    expect(url.searchParams.get('providerId')).toBe('provider 1')
    expect(url.searchParams.get('status')).toBe('published')
    expect(url.searchParams.get('limit')).toBe('10')
    expect(url.searchParams.get('offset')).toBe('5')
    expect(page).toEqual(RULEBOOK_PAGE)
  })

  test('rejects an invalid page bound locally without a request', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(RULEBOOK_PAGE))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const error = await rejection(client.listRulebooks({ limit: 0 }))

    expect(error.code).toBe('invalid_request')
    expect(calls).toHaveLength(0)
  })

  test('encodes path identifiers', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ data: RULEBOOK }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    await client.getRulebook('rulebook/with spaces')

    expect(requestUrl(firstCall(calls)).pathname).toBe('/api/v1/rulebooks/rulebook%2Fwith%20spaces')
  })

  test('scopes the configured bearer token to authenticated operations', async () => {
    const readFetch = fakeFetch(() => jsonResponse(RULEBOOK_PAGE))
    await new CredimiAdapter({
      baseUrl: BASE_URL,
      token: 'provider-token',
      fetch: readFetch.fetch,
    }).listRulebooks()
    expect(authorizationOf(firstCall(readFetch.calls))).toBeNull()
    expect(firstCall(readFetch.calls).init.redirect).toBe('error')

    const correlateFetch = fakeFetch(() =>
      errorResponse(401, 'unauthorized', 'The bearer token is missing.'),
    )
    const error = await rejection(
      new CredimiAdapter({
        baseUrl: BASE_URL,
        token: 'provider-token',
        retries: 0,
        fetch: correlateFetch.fetch,
      }).correlateCapture({ captureId: 'capture-1', pin: PIN }),
    )

    expect(error.code).toBe('unauthorized')
    expect(authorizationOf(firstCall(correlateFetch.calls))).toBe('Bearer provider-token')
    expect(requestBody(firstCall(correlateFetch.calls))).toEqual({
      rulebookId: PIN.rulebookId,
      rulebookVersion: PIN.version,
      attestationType: PIN.attestationType,
      rulebookDigest: PIN.contentDigest,
    })
  })

  test('resolves a pin from the authoritative version record', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ data: VERSION_RECORD }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const pin = await client.pinRulebook({
      rulebookId: 'rulebook-1',
      version: '1.0',
      attestationType: 'PID',
    })

    expect(requestUrl(firstCall(calls)).pathname).toBe('/api/v1/rulebooks/rulebook-1/versions/1.0')
    expect(pin).toEqual(PIN)
    expect(credimiRulebookPinSchema.safeParse(pin).success).toBe(true)
  })

  test('refuses a server digest that cannot form a pin', async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ data: { ...VERSION_RECORD, contentDigest: 'not-a-digest' } }),
    )
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const error = await rejection(
      client.pinRulebook({ rulebookId: 'rulebook-1', version: '1.0', attestationType: 'PID' }),
    )

    expect(error.code).toBe('invalid_response')
  })
})

describe('version-pinned validation request', () => {
  test('sends the pinned identifier, exact version and attestation type', async () => {
    const { fetch, calls } = fakeFetch(() =>
      errorResponse(404, 'not_found', 'The requested rulebook version does not exist.'),
    )
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const error = await rejection(
      client.validateCredential({ pin: PIN, credential: 'header.payload.signature' }),
    )

    const call = firstCall(calls)
    expect(requestUrl(call).pathname).toBe('/api/v1/credentials/validate')
    expect(call.init.method).toBe('POST')
    expect(requestBody(call)).toEqual({
      rulebookId: 'rulebook-1',
      rulebookVersion: '1.0',
      attestationType: 'PID',
      credential: 'header.payload.signature',
    })
    expect(error).toMatchObject({ code: 'not_found', status: 404, serverCode: 'not_found' })
  })

  test('rejects a malformed pin and an empty credential locally', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({}))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const malformed = await rejection(
      client.validateCredential({
        pin: { ...PIN, contentDigest: 'npm-not-hex' },
        credential: 'header.payload.signature',
      }),
    )
    expect(malformed.code).toBe('invalid_request')

    const empty = await rejection(client.validateCredential({ pin: PIN, credential: '   ' }))
    expect(empty.code).toBe('invalid_request')
    expect(calls).toHaveLength(0)
  })
})

describe('typed failure mapping', () => {
  test('maps HTTP statuses and keeps the server error code', async () => {
    const cases: readonly {
      readonly status: number
      readonly expected: CredimiAdapterError['code']
    }[] = [
      { status: 400, expected: 'invalid_input' },
      { status: 401, expected: 'unauthorized' },
      { status: 403, expected: 'forbidden' },
      { status: 404, expected: 'not_found' },
      { status: 409, expected: 'conflict' },
      { status: 413, expected: 'payload_too_large' },
      { status: 500, expected: 'internal_error' },
      { status: 502, expected: 'unavailable' },
      { status: 503, expected: 'unavailable' },
      { status: 504, expected: 'unavailable' },
      { status: 418, expected: 'http_error' },
    ]

    for (const { status, expected } of cases) {
      const { fetch } = fakeFetch(() => errorResponse(status, 'server_code', 'Server message.'))
      const client = new CredimiAdapter({ baseUrl: BASE_URL, retries: 0, fetch })

      const error = await rejection(client.listRulebooks())

      expect({ status, error: error.code }).toEqual({ status, error: expected })
      expect(error.status).toBe(status)
      expect(error.serverCode).toBe('server_code')
      expect(error.message).toContain('Server message.')
      expect(error.retryable).toBe(status === 502 || status === 503 || status === 504)
    }
  })

  test('maps a non-JSON error body without echoing it', async () => {
    const { fetch } = fakeFetch(
      () => new Response('<html>secret-token-value</html>', { status: 500 }),
    )
    const client = new CredimiAdapter({ baseUrl: BASE_URL, retries: 0, fetch })

    const error = await rejection(client.listRulebooks())

    expect(error).toMatchObject({ code: 'internal_error', status: 500, serverCode: null })
    expect(error.message).not.toContain('secret-token-value')
  })

  test('reports a malformed success body as invalid_response', async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ data: { id: 'only-an-id' } }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const error = await rejection(client.getRulebook('rulebook-1'))

    expect(error.code).toBe('invalid_response')
    expect(error.message).not.toContain('only-an-id')
  })

  test('enforces the response-size bound', async () => {
    const { fetch } = fakeFetch(() => jsonResponse(RULEBOOK_PAGE))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, maxResponseBytes: 10, fetch })

    const error = await rejection(client.listRulebooks())

    expect(error.code).toBe('response_too_large')
  })

  test('reports a transport failure as a retryable network error', async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError('connect ECONNREFUSED 127.0.0.1:9')
    })
    const client = new CredimiAdapter({ baseUrl: BASE_URL, retries: 0, fetch })

    const error = await rejection(client.listRulebooks())

    expect(error).toMatchObject({ code: 'network_error', retryable: true, status: null })
    expect(error.message).toContain('ECONNREFUSED')
  })

  test('aborts a hanging request and reports a timeout', async () => {
    const fetchFn = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('the request was aborted'))
        })
      })
    }) as typeof fetch
    const client = new CredimiAdapter({
      baseUrl: BASE_URL,
      timeoutMs: 5,
      retries: 0,
      fetch: fetchFn,
    })

    const error = await rejection(client.listRulebooks())

    expect(error).toMatchObject({ code: 'timeout', retryable: true, status: null })
  })
})

describe('bounded retries', () => {
  test('retries an idempotent read after a transient failure', async () => {
    const { fetch, calls } = fakeFetch((_call, index) => {
      if (index === 0) {
        throw new TypeError('temporary transport failure')
      }
      if (index === 1) {
        return errorResponse(503, 'registry_unavailable', 'Try again later.')
      }
      return jsonResponse(RULEBOOK_PAGE)
    })
    const client = new CredimiAdapter({ baseUrl: BASE_URL, retries: 2, retryDelayMs: 0, fetch })

    const page = await client.listRulebooks()

    expect(page).toEqual(RULEBOOK_PAGE)
    expect(calls).toHaveLength(3)
  })

  test('stops after the configured attempt bound', async () => {
    const { fetch, calls } = fakeFetch(() =>
      errorResponse(503, 'registry_unavailable', 'Try again later.'),
    )
    const client = new CredimiAdapter({ baseUrl: BASE_URL, retries: 2, retryDelayMs: 0, fetch })

    const error = await rejection(client.listRulebooks())

    expect(error.code).toBe('unavailable')
    expect(calls).toHaveLength(3)
  })

  test('never retries a validation mutation automatically', async () => {
    const { fetch, calls } = fakeFetch(() =>
      errorResponse(503, 'registry_unavailable', 'Try again later.'),
    )
    const client = new CredimiAdapter({ baseUrl: BASE_URL, retries: 3, retryDelayMs: 0, fetch })

    const error = await rejection(
      client.validateCredential({ pin: PIN, credential: 'header.payload.signature' }),
    )

    expect(error.code).toBe('unavailable')
    expect(calls).toHaveLength(1)
  })
})

describe('capture evidence reads', () => {
  test('parses a capture page and a capture read', async () => {
    const emptyPage = {
      data: [],
      pagination: { limit: 50, offset: 0, total: 0 },
    }
    const pageFetch = fakeFetch(() => jsonResponse(emptyPage))
    const page = await new CredimiAdapter({
      baseUrl: BASE_URL,
      fetch: pageFetch.fetch,
    }).listCaptures({ limit: 20 })
    expect(page).toEqual(emptyPage)
    expect(requestUrl(firstCall(pageFetch.calls)).searchParams.get('limit')).toBe('20')

    const detailFetch = fakeFetch(() =>
      errorResponse(404, 'not_found', 'The requested capture does not exist.'),
    )
    const client = new CredimiAdapter({ baseUrl: BASE_URL, retries: 0, fetch: detailFetch.fetch })
    const error = await rejection(client.getCapture('missing capture'))
    expect(requestUrl(firstCall(detailFetch.calls)).pathname).toBe(
      '/api/v1/captures/missing%20capture',
    )
    expect(error.code).toBe('not_found')
  })

  test('requires a provider token before recording a correlation', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({}))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const error = await rejection(client.correlateCapture({ captureId: 'capture-1', pin: PIN }))

    expect(error.code).toBe('authorization_required')
    expect(calls).toHaveLength(0)
  })
})

describe('pin verification', () => {
  function validationEvidence(overrides: {
    readonly id?: string
    readonly version?: string
    readonly digest?: string
    readonly attestationType?: string
  }): CredimiValidationEvidence {
    return {
      rulebook: {
        id: overrides.id ?? PIN.rulebookId,
        version: overrides.version ?? PIN.version,
        digest: overrides.digest ?? PIN.contentDigest,
      },
      attestation: { name: overrides.attestationType ?? PIN.attestationType },
    } as unknown as CredimiValidationEvidence
  }

  test('accepts evidence that names exactly the pinned selection', () => {
    expect(() => assertPinnedValidation(PIN, validationEvidence({}))).not.toThrow()
  })

  test('rejects a changed digest, version, rulebook or attestation type', () => {
    const cases = [
      validationEvidence({ digest: 'b'.repeat(64) }),
      validationEvidence({ version: '2.0' }),
      validationEvidence({ id: 'rulebook-2' }),
      validationEvidence({ attestationType: 'Badge' }),
    ]

    for (const evidence of cases) {
      try {
        assertPinnedValidation(PIN, evidence)
        throw new Error('expected a pin mismatch')
      } catch (error) {
        expect(isCredimiAdapterError(error)).toBe(true)
        expect((error as CredimiAdapterError).code).toBe('pin_mismatch')
      }
    }
  })

  test('verifies both the correlation binding and its validation result', () => {
    const correlation = (options: {
      readonly version?: string
      readonly digest?: string
    }): CredimiEvidenceCorrelation =>
      ({
        rulebook: {
          rulebookId: PIN.rulebookId,
          version: options.version ?? PIN.version,
          contentDigest: options.digest ?? PIN.contentDigest,
          attestationType: PIN.attestationType,
        },
        validation: validationEvidence({}),
      }) as unknown as CredimiEvidenceCorrelation

    expect(() => assertPinnedCorrelation(PIN, correlation({}))).not.toThrow()

    try {
      assertPinnedCorrelation(PIN, correlation({ digest: 'c'.repeat(64) }))
      throw new Error('expected a pin mismatch')
    } catch (error) {
      expect((error as CredimiAdapterError).code).toBe('pin_mismatch')
    }
  })

  test('accepts a comparison report that names exactly the pinned selection', () => {
    expect(() => assertPinnedComparison(PIN, comparisonReport())).not.toThrow()

    const mismatch = {
      ...comparisonReport(),
      rulebook: { ...comparisonReport().rulebook, contentDigest: 'c'.repeat(64) },
    }
    try {
      assertPinnedComparison(PIN, mismatch)
      throw new Error('expected a pin mismatch')
    } catch (error) {
      expect((error as CredimiAdapterError).code).toBe('pin_mismatch')
    }
  })
})

function pinnedComparisonSource(): ComparisonEvidenceSource {
  const source = comparisonSource()
  return {
    ...source,
    rulebook: {
      ...source.rulebook,
      rulebookId: PIN.rulebookId,
      version: PIN.version,
      contentDigest: PIN.contentDigest,
      attestationType: PIN.attestationType,
    },
    validation: {
      ...source.validation,
      rulebook: {
        ...source.validation.rulebook,
        id: PIN.rulebookId,
        version: PIN.version,
        digest: PIN.contentDigest,
      },
    },
  }
}

function comparisonReport(
  externalWallet: ExternalWalletObservation | null = externalWalletObservation(),
  captureId = TEST_CAPTURE_ID,
): CredimiHeadlessWalletComparison {
  const report = headlessWalletComparisonSchema.parse(
    buildHeadlessWalletComparison({
      source: pinnedComparisonSource(),
      externalWallet,
      now: () => TEST_COMPARED_AT,
    }),
  )
  return { ...report, capture: { ...report.capture, captureId } }
}

describe('headless-wallet comparison request', () => {
  test('posts the external observation and verifies the returned pin', async () => {
    const report = comparisonReport(externalWalletObservation(), 'capture 1')
    if (report.externalWallet === null) {
      throw new Error('expected the fixture report to carry an external observation')
    }
    const { fetch, calls } = fakeFetch(() => jsonResponse({ data: report }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const result = await client.compareCapture({
      captureId: 'capture 1',
      pin: PIN,
      externalWallet: report.externalWallet,
    })

    expect(result.rulebook.contentDigest).toBe(PIN.contentDigest)
    expect(result.externalWallet?.walletId).toBe(TEST_WALLET_ID)
    const call = firstCall(calls)
    expect(call.init.method).toBe('POST')
    expect(requestUrl(call).pathname).toBe('/api/v1/captures/capture%201/compare')
    const body = requestBody(call) as {
      readonly externalWallet: { readonly walletId: string }
    }
    expect(body.externalWallet.walletId).toBe(TEST_WALLET_ID)
  })

  test('sends an empty body when no external observation is supplied', async () => {
    const report = comparisonReport(null, 'capture-1')
    const { fetch, calls } = fakeFetch(() => jsonResponse({ data: report }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const result = await client.compareCapture({ captureId: 'capture-1', pin: PIN })

    expect(result.externalWallet).toBeNull()
    expect(requestBody(firstCall(calls))).toEqual({})
  })

  test('sends an observation without code and detail unchanged', async () => {
    const report = comparisonReport(undefined, 'capture-1')
    const { fetch, calls } = fakeFetch(() => jsonResponse({ data: report }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })
    const externalWallet: CredimiExternalWalletObservation = {
      walletId: TEST_WALLET_ID,
      observedAt: '2026-11-05T09:48:30Z',
      interaction: 'issuance',
      observations: [{ dimension: 'protocol_conformance', status: 'PASS' }],
    }

    await client.compareCapture({ captureId: 'capture-1', pin: PIN, externalWallet })

    expect(requestBody(firstCall(calls))).toEqual({ externalWallet })
  })

  test('rejects a report that names a different pin', async () => {
    const report = comparisonReport(externalWalletObservation(), 'capture-1')
    const mismatched = {
      ...report,
      rulebook: { ...report.rulebook, contentDigest: 'd'.repeat(64) },
    }
    const { fetch } = fakeFetch(() => jsonResponse({ data: mismatched }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const error = await rejection(client.compareCapture({ captureId: 'capture-1', pin: PIN }))
    expect(error.code).toBe('pin_mismatch')
  })

  test('rejects a report for a different capture identifier', async () => {
    const report = comparisonReport(undefined, 'another-capture')
    const mismatched = {
      ...report,
      capture: { ...report.capture, captureId: 'another-capture' },
    }
    const { fetch } = fakeFetch(() => jsonResponse({ data: mismatched }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const error = await rejection(client.compareCapture({ captureId: 'capture-1', pin: PIN }))
    expect(error.code).toBe('invalid_response')
  })
})

function pinnedConformanceResult(
  overrides: {
    readonly credential?: string
    readonly credentialFormatHint?: string | null
    readonly schemaDocuments?: readonly { readonly uri: string; readonly content: string }[]
    readonly contentDigest?: string
    readonly specVersion?: string
    readonly attestationType?: string
  } = {},
): CredimiConformanceResult {
  return conformanceResultSchema.parse(
    conformanceResult({
      rulebookId: PIN.rulebookId,
      rulebookVersion: PIN.version,
      rulebookDigest: overrides.contentDigest ?? PIN.contentDigest,
      specVersion: overrides.specVersion ?? PIN.specVersion,
      attestationType: overrides.attestationType ?? PIN.attestationType,
      credential: overrides.credential ?? TEST_CREDENTIAL,
      credentialFormatHint: overrides.credentialFormatHint ?? null,
      schemaDocuments: overrides.schemaDocuments ?? [
        { uri: TEST_SCHEMA_URI, content: TEST_SCHEMA_CONTENT },
      ],
    }),
  )
}

describe('reproducible conformance run request', () => {
  test('posts the pinned request and returns the verified stable reference', async () => {
    const result = pinnedConformanceResult()
    const { fetch, calls } = fakeFetch(() => jsonResponse({ data: result }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const returned = await client.runConformance({
      pin: PIN,
      credential: TEST_CREDENTIAL,
      schemaDocuments: [{ uri: TEST_SCHEMA_URI, content: TEST_SCHEMA_CONTENT }],
    })

    expect(returned.resultReference).toBe(result.resultReference)
    expect(returned.input.inputDigest).toBe(result.input.inputDigest)
    const call = firstCall(calls)
    expect(call.init.method).toBe('POST')
    expect(requestUrl(call).pathname).toBe('/api/v1/conformance/runs')
    expect(requestBody(call)).toEqual({
      rulebookId: PIN.rulebookId,
      rulebookVersion: PIN.version,
      attestationType: PIN.attestationType,
      credential: TEST_CREDENTIAL,
      schemaDocuments: [{ uri: TEST_SCHEMA_URI, content: TEST_SCHEMA_CONTENT }],
    })
  })

  test('normalizes a padded format hint and schema URI like the server', async () => {
    const result = pinnedConformanceResult({ credentialFormatHint: 'dc+sd-jwt' })
    const { fetch } = fakeFetch(() => jsonResponse({ data: result }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const returned = await client.runConformance({
      pin: PIN,
      credential: { format: 'dc+sd-jwt ', value: TEST_CREDENTIAL },
      schemaDocuments: [{ uri: `  ${TEST_SCHEMA_URI}  `, content: TEST_SCHEMA_CONTENT }],
    })

    expect(returned.input.credentialFormatHint).toBe('dc+sd-jwt')
    expect(returned.input.schemaDocuments[0]?.uri).toBe(TEST_SCHEMA_URI)
  })

  test('accepts schema documents in the shared code-unit URI order', async () => {
    const schemaDocuments = [
      { uri: 'https://example.org/schemas/a.json', content: '{"a":1}' },
      { uri: 'https://example.org/schemas/B.json', content: '{"b":1}' },
    ]
    const result = pinnedConformanceResult({ schemaDocuments })
    const { fetch } = fakeFetch(() => jsonResponse({ data: result }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const returned = await client.runConformance({
      pin: PIN,
      credential: TEST_CREDENTIAL,
      schemaDocuments,
    })

    expect(returned.input.schemaDocuments.map((document) => document.uri)).toEqual([
      'https://example.org/schemas/B.json',
      'https://example.org/schemas/a.json',
    ])
  })

  test('rejects a result whose format hint differs from the sent request', async () => {
    const result = pinnedConformanceResult({ credentialFormatHint: 'dc+sd-jwt' })
    const { fetch } = fakeFetch(() => jsonResponse({ data: result }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const error = await rejection(client.runConformance({ pin: PIN, credential: TEST_CREDENTIAL }))

    expect(error.code).toBe('invalid_response')
  })

  test('rejects a result whose schema document digest differs from the sent request', async () => {
    const result = pinnedConformanceResult({
      schemaDocuments: [{ uri: TEST_SCHEMA_URI, content: '{"type":"object"}' }],
    })
    const { fetch } = fakeFetch(() => jsonResponse({ data: result }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const error = await rejection(
      client.runConformance({
        pin: PIN,
        credential: TEST_CREDENTIAL,
        schemaDocuments: [{ uri: TEST_SCHEMA_URI, content: TEST_SCHEMA_CONTENT }],
      }),
    )

    expect(error.code).toBe('invalid_response')
  })

  test('accepts a result pinned exactly and rejects a different snapshot digest', () => {
    expect(() => assertPinnedConformance(PIN, pinnedConformanceResult())).not.toThrow()

    try {
      assertPinnedConformance(PIN, pinnedConformanceResult({ contentDigest: 'd'.repeat(64) }))
      throw new Error('expected a pin mismatch')
    } catch (error) {
      expect((error as CredimiAdapterError).code).toBe('pin_mismatch')
    }
  })

  test('rejects a result for a different specification version', async () => {
    const result = pinnedConformanceResult({ specVersion: 'ts12@1.0.0' })
    const { fetch } = fakeFetch(() => jsonResponse({ data: result }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const error = await rejection(client.runConformance({ pin: PIN, credential: TEST_CREDENTIAL }))

    expect(error.code).toBe('pin_mismatch')
  })

  test('rejects a result whose input digest names another credential', async () => {
    const result = pinnedConformanceResult({ credential: 'a-different-credential' })
    const { fetch } = fakeFetch(() => jsonResponse({ data: result }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const error = await rejection(client.runConformance({ pin: PIN, credential: TEST_CREDENTIAL }))

    expect(error.code).toBe('invalid_response')
  })

  test('rejects a malformed conformance response', async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ data: { kind: 'not-a-conformance-result' } }))
    const client = new CredimiAdapter({ baseUrl: BASE_URL, fetch })

    const error = await rejection(client.runConformance({ pin: PIN, credential: TEST_CREDENTIAL }))

    expect(error.code).toBe('invalid_response')
  })
})
