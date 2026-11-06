// HTTP integration tests for issuer discovery (FR-006, issue #43).
//
// The route is exercised through the real Hono application, the real bearer
// middleware and a real temporary SQLite registry. The discovery seam is a
// double so the test stays offline; the discovery service's own tests exercise
// the real bounded transport, extraction and association.

import { afterEach, describe, expect, test } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'

import { createApp } from '../app'
import type { IssuerDiscoveryService } from '../discovery'
import type { IssuerDiscoveryResult } from '../discovery'
import { ImportError } from '../import/errors'
import { provisionProvider } from '../registry/bootstrap'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'

import { componentJsonSchema, type OpenApiComponentName } from './schemas'

const RESULT: IssuerDiscoveryResult = {
  source: {
    issuerIdentifier: 'https://issuer.example/',
    metadataUrl: 'https://issuer.example/.well-known/openid-credential-issuer',
    requestedUrl: 'https://issuer.example/.well-known/openid-credential-issuer',
    finalUrl: 'https://issuer.example/.well-known/openid-credential-issuer',
    retrievedAt: '2026-11-06T10:00:00.000Z',
    contentType: 'application/json',
    status: 200,
    byteLength: 512,
    contentDigest: 'a'.repeat(64),
    redirects: [],
    metadataShape: 'oid4vci_1_0',
  },
  issuer: {
    credentialIssuer: 'https://issuer.example/',
    credentialEndpoint: 'https://issuer.example/credential',
    authorizationServers: ['https://issuer.example/'],
  },
  configurations: [
    {
      configurationId: 'pid',
      format: 'dc+sd-jwt',
      displayName: 'PID',
      typeIdentifiers: [{ kind: 'vct', value: 'https://issuer.example/vct/pid' }],
      schemaReferences: [
        {
          formatIdentifier: 'dc+sd-jwt',
          uri: 'https://issuer.example/vct/pid',
          source: 'vct',
        },
      ],
      mapping: {
        status: 'matched',
        candidates: [
          {
            rulebookId: 'rulebook-pid',
            rulebookName: 'PID Rulebook',
            version: '1.0',
            contentDigest: 'b'.repeat(64),
            specVersion: 'ts11@1.0.1',
          },
        ],
        reason: null,
      },
    },
  ],
  summary: {
    totalConfigurations: 1,
    validConfigurations: 1,
    invalidConfigurations: 0,
    matched: 1,
    ambiguous: 0,
    unmatched: 0,
    mappedRulebooks: 1,
  },
  diagnostics: [],
  limitations: ['Issuer metadata is not an Attestation Rulebook.'],
}

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

interface FakeService {
  readonly service: IssuerDiscoveryService
  readonly calls: unknown[]
}

function fakeService(result: IssuerDiscoveryResult = RESULT): FakeService {
  const calls: unknown[] = []
  return {
    calls,
    service: {
      discover: (credentialIssuer) => {
        calls.push(credentialIssuer)
        return Promise.resolve(result)
      },
    },
  }
}

function failingService(error: Error): IssuerDiscoveryService {
  return { discover: () => Promise.reject(error) }
}

function setup(service?: IssuerDiscoveryService): {
  readonly app: ReturnType<typeof createApp>
  readonly token: string
} {
  fixture = createRegistryFixture()
  const provider = provisionProvider(fixture.database, {
    name: 'Discovery Provider',
    publicationAuthority: 'discovery-authority',
  })
  return {
    app: createApp({
      registry: fixture.registry,
      ...(service === undefined ? {} : { issuerDiscovery: service }),
    }),
    token: provider.token.secret,
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
const validators = new Map<string, ValidateFunction>()

function assertSchema(name: OpenApiComponentName, value: unknown): void {
  let validate = validators.get(name)
  if (validate === undefined) {
    validate = ajv.compile(componentJsonSchema(name))
    validators.set(name, validate)
  }
  expect(validate(value), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true)
}

function jsonHeaders(token?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  }
}

describe('POST /api/v1/issuers/discover', () => {
  test('requires a bearer token before any discovery work', async () => {
    const fake = fakeService()
    const { app } = setup(fake.service)
    const response = await app.request('/api/v1/issuers/discover', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ credentialIssuer: 'https://issuer.example' }),
    })
    expect(response.status).toBe(401)
    expect(fake.calls).toEqual([])
  })

  test('returns the discovery result and passes the issuer identifier', async () => {
    const fake = fakeService()
    const { app, token } = setup(fake.service)
    const response = await app.request('/api/v1/issuers/discover', {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ credentialIssuer: 'https://issuer.example' }),
    })
    expect(response.status).toBe(200)
    expect(fake.calls).toEqual(['https://issuer.example'])

    const body = (await response.json()) as { data: unknown }
    assertSchema('IssuerDiscoveryResponse', body)
    expect(body.data).toMatchObject({
      source: { metadataShape: 'oid4vci_1_0' },
      summary: { matched: 1 },
    })
  })

  test('rejects a body without a credentialIssuer', async () => {
    const fake = fakeService()
    const { app, token } = setup(fake.service)
    const response = await app.request('/api/v1/issuers/discover', {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    expect(fake.calls).toEqual([])
  })

  test('rejects a non-string credentialIssuer', async () => {
    const fake = fakeService()
    const { app, token } = setup(fake.service)
    const response = await app.request('/api/v1/issuers/discover', {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ credentialIssuer: 42 }),
    })
    expect(response.status).toBe(400)
    expect(fake.calls).toEqual([])
  })

  test('maps an invalid issuer URL to a 400 invalid_request', async () => {
    const { app, token } = setup(failingService(new ImportError('invalid_url', 'not https')))
    const response = await app.request('/api/v1/issuers/discover', {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ credentialIssuer: 'http://issuer.example' }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('invalid_request')
  })

  test('maps a fetch failure to a 502 import_fetch_failed', async () => {
    const { app, token } = setup(
      failingService(new ImportError('timeout', 'the request timed out')),
    )
    const response = await app.request('/api/v1/issuers/discover', {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ credentialIssuer: 'https://issuer.example' }),
    })
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('import_fetch_failed')
  })

  test('maps invalid issuer metadata to a 422 import_rejected', async () => {
    const { app, token } = setup(
      failingService(new ImportError('invalid_issuer_metadata', 'bad metadata')),
    )
    const response = await app.request('/api/v1/issuers/discover', {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ credentialIssuer: 'https://issuer.example' }),
    })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('import_rejected')
  })

  test('answers 503 when discovery is not configured', async () => {
    const response = await createApp().request('/api/v1/issuers/discover', {
      method: 'POST',
      headers: jsonHeaders('att_unknown'),
      body: JSON.stringify({ credentialIssuer: 'https://issuer.example' }),
    })
    // Without a registry the central middleware reports the missing service
    // before it can authenticate the token.
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('registry_unavailable')
  })
})
