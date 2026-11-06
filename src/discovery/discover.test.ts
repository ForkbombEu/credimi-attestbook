import { afterEach, describe, expect, test } from 'bun:test'

import { ImportError, type ImportErrorCode } from '../import/errors'
import { createFakeTransport, publicResolver } from '../import/test/fixtures'
import type { Registry } from '../registry/registry'
import { createRegistryFixture, type RegistryFixture } from '../registry/test-support'
import { seedPublishedRulebook } from '../validation/test-support'

import { IssuerDiscovery, type IssuerDiscoveryService } from './discover'
import { MAX_ISSUER_CONFIGURATIONS } from './metadata'
import { issuerMetadata, ISSUER_IDENTIFIER, PID_VCT } from './test/fixtures'

const METADATA_URL = `${ISSUER_IDENTIFIER}/.well-known/openid-credential-issuer`

let fixture: RegistryFixture | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function registryFixture(): RegistryFixture {
  fixture = createRegistryFixture()
  return fixture
}

function discoveryFor(
  registry: Registry,
  transport: ReturnType<typeof createFakeTransport>['transport'],
) {
  return new IssuerDiscovery({
    rulebooks: registry,
    transport,
    resolveHostname: publicResolver,
    now: () => '2026-11-06T10:00:00.000Z',
  })
}

async function expectImportError(
  operation: () => Promise<unknown>,
  code: ImportErrorCode,
): Promise<ImportError> {
  let caught: unknown
  try {
    await operation()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ImportError)
  expect((caught as ImportError).code).toBe(code)
  return caught as ImportError
}

describe('issuer discovery service', () => {
  test('discovers configurations and pins a matching rulebook version', async () => {
    const registry = registryFixture()
    const seeded = seedPublishedRulebook(registry.database, registry.registry, {
      schemaUri: PID_VCT,
      rulebookName: 'PID Rulebook',
    })
    const fake = createFakeTransport({
      [METADATA_URL]: { body: JSON.stringify(issuerMetadata()) },
    })
    const discovery: IssuerDiscoveryService = discoveryFor(registry.registry, fake.transport)

    const result = await discovery.discover(ISSUER_IDENTIFIER)

    expect(result.source.issuerIdentifier).toBe('https://issuer.example/')
    expect(result.source.metadataUrl).toBe(METADATA_URL)
    expect(result.source.requestedUrl).toBe(METADATA_URL)
    expect(result.source.finalUrl).toBe(METADATA_URL)
    expect(result.source.retrievedAt).toBe('2026-11-06T10:00:00.000Z')
    expect(result.source.byteLength).toBeGreaterThan(0)
    expect(result.source.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.source.metadataShape).toBe('oid4vci_1_0')
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.address).toBe('93.184.216.34')

    expect(result.summary).toEqual({
      totalConfigurations: 2,
      validConfigurations: 2,
      invalidConfigurations: 0,
      matched: 1,
      ambiguous: 0,
      unmatched: 1,
      mappedRulebooks: 1,
    })

    const pid = result.configurations.find(
      (configuration) => configuration.configurationId === 'pid',
    )
    expect(pid?.format).toBe('dc+sd-jwt')
    expect(pid?.typeIdentifiers).toEqual([{ kind: 'vct', value: PID_VCT }])
    expect(pid?.mapping.status).toBe('matched')
    expect(pid?.mapping.candidates).toEqual([
      {
        rulebookId: seeded.rulebookId,
        rulebookName: 'PID Rulebook',
        version: '1.0',
        contentDigest: seeded.digest,
        specVersion: 'ts11@1.0.1',
      },
    ])

    const mdl = result.configurations.find(
      (configuration) => configuration.configurationId === 'mdl',
    )
    expect(mdl?.mapping.status).toBe('unmatched')
    expect(mdl?.mapping.reason).toContain('no published or historical rulebook version')

    expect(result.limitations.length).toBeGreaterThan(0)
  })

  test('reports an ambiguous configuration when several rulebooks match', async () => {
    const registry = registryFixture()
    const first = seedPublishedRulebook(registry.database, registry.registry, {
      authority: 'authority-1',
      schemaUri: PID_VCT,
      rulebookName: 'PID Rulebook',
    })
    const second = seedPublishedRulebook(registry.database, registry.registry, {
      authority: 'authority-2',
      schemaUri: PID_VCT,
      rulebookName: 'Another PID Rulebook',
    })
    const fake = createFakeTransport({
      [METADATA_URL]: { body: JSON.stringify(issuerMetadata()) },
    })

    const result = await discoveryFor(registry.registry, fake.transport).discover(ISSUER_IDENTIFIER)

    const pid = result.configurations.find(
      (configuration) => configuration.configurationId === 'pid',
    )
    expect(pid?.mapping.status).toBe('ambiguous')
    expect(pid?.mapping.candidates.map((pin) => pin.rulebookId).sort()).toEqual(
      [first.rulebookId, second.rulebookId].sort(),
    )
    expect(result.summary.ambiguous).toBe(1)
  })

  test('discovers the earlier credentials_supported metadata shape', async () => {
    const registry = registryFixture()
    seedPublishedRulebook(registry.database, registry.registry, {
      schemaFormatIdentifier: 'ldp_vc',
      schemaUri: 'https://issuer.example/credentials/degree',
    })
    const fake = createFakeTransport({
      [METADATA_URL]: {
        body: JSON.stringify({
          credential_issuer: ISSUER_IDENTIFIER,
          credentials_supported: [
            {
              format: 'ldp_vc',
              credential_definition: {
                type: ['VerifiableCredential', 'UniversityDegreeCredential'],
              },
            },
          ],
        }),
      },
    })

    const result = await discoveryFor(registry.registry, fake.transport).discover(ISSUER_IDENTIFIER)
    expect(result.source.metadataShape).toBe('oid4vci_legacy')
    expect(result.summary.unmatched).toBe(1)
    expect(result.configurations[0]?.typeIdentifiers).toEqual([
      { kind: 'type', value: 'VerifiableCredential' },
      { kind: 'type', value: 'UniversityDegreeCredential' },
    ])
  })

  test('derives the OpenID4VCI 1.0 metadata URL for a tenant identifier', async () => {
    const registry = registryFixture()
    const fake = createFakeTransport({
      [`${ISSUER_IDENTIFIER}/.well-known/openid-credential-issuer/tenant`]: {
        body: JSON.stringify(issuerMetadata({ credential_issuer: `${ISSUER_IDENTIFIER}/tenant` })),
      },
    })
    const result = await discoveryFor(registry.registry, fake.transport).discover(
      `${ISSUER_IDENTIFIER}/tenant`,
    )
    expect(result.source.metadataUrl).toBe(
      `${ISSUER_IDENTIFIER}/.well-known/openid-credential-issuer/tenant`,
    )
    expect(result.source.issuerIdentifier).toBe(`${ISSUER_IDENTIFIER}/tenant`)
  })

  test('accepts the earlier appended-path metadata URL for an older issuer', async () => {
    const registry = registryFixture()
    const fake = createFakeTransport({
      [`${ISSUER_IDENTIFIER}/tenant/.well-known/openid-credential-issuer`]: {
        body: JSON.stringify(issuerMetadata({ credential_issuer: `${ISSUER_IDENTIFIER}/tenant` })),
      },
    })
    const result = await discoveryFor(registry.registry, fake.transport).discover(
      `${ISSUER_IDENTIFIER}/tenant/.well-known/openid-credential-issuer`,
    )
    expect(result.source.metadataUrl).toBe(
      `${ISSUER_IDENTIFIER}/tenant/.well-known/openid-credential-issuer`,
    )
    expect(result.source.issuerIdentifier).toBe(`${ISSUER_IDENTIFIER}/tenant`)
  })

  test('reports a URN vct as an unmatched configuration, not as invalid', async () => {
    const registry = registryFixture()
    const fake = createFakeTransport({
      [METADATA_URL]: {
        body: JSON.stringify(
          issuerMetadata({
            credential_configurations_supported: {
              pid: { format: 'dc+sd-jwt', vct: 'urn:eudi:pid:1' },
            },
          }),
        ),
      },
    })
    const result = await discoveryFor(registry.registry, fake.transport).discover(ISSUER_IDENTIFIER)
    expect(result.summary.invalidConfigurations).toBe(0)
    expect(result.summary.unmatched).toBe(1)
    const pid = result.configurations.find(
      (configuration) => configuration.configurationId === 'pid',
    )
    expect(pid?.typeIdentifiers).toEqual([{ kind: 'vct', value: 'urn:eudi:pid:1' }])
    expect(pid?.schemaReferences).toEqual([])
    expect(pid?.mapping.status).toBe('unmatched')
  })
})

describe('issuer discovery bounds and validation', () => {
  test('refuses a non-https issuer URL before any network call', async () => {
    const registry = registryFixture()
    const fake = createFakeTransport({})
    await expectImportError(
      () => discoveryFor(registry.registry, fake.transport).discover('http://issuer.example'),
      'invalid_url',
    )
    expect(fake.requests).toHaveLength(0)
  })

  test('refuses metadata over the byte limit', async () => {
    const registry = registryFixture()
    const fake = createFakeTransport({
      [METADATA_URL]: { body: JSON.stringify(issuerMetadata()).padEnd(2 * 1024 * 1024 + 1, ' ') },
    })
    await expectImportError(
      () => discoveryFor(registry.registry, fake.transport).discover(ISSUER_IDENTIFIER),
      'response_too_large',
    )
  })

  test('refuses a non-JSON content type', async () => {
    const registry = registryFixture()
    const fake = createFakeTransport({
      [METADATA_URL]: {
        body: '<html></html>',
        headers: { 'content-type': 'text/html' },
      },
    })
    await expectImportError(
      () => discoveryFor(registry.registry, fake.transport).discover(ISSUER_IDENTIFIER),
      'unsupported_content_type',
    )
  })

  test('refuses invalid JSON', async () => {
    const registry = registryFixture()
    const fake = createFakeTransport({ [METADATA_URL]: { body: '{not json' } })
    await expectImportError(
      () => discoveryFor(registry.registry, fake.transport).discover(ISSUER_IDENTIFIER),
      'invalid_json',
    )
  })

  test('follows and records a public redirect', async () => {
    const registry = registryFixture()
    const fake = createFakeTransport({
      [METADATA_URL]: {
        status: 302,
        headers: { location: 'https://issuer.example/metadata/v1' },
      },
      'https://issuer.example/metadata/v1': {
        body: JSON.stringify(issuerMetadata()),
      },
    })
    const result = await discoveryFor(registry.registry, fake.transport).discover(ISSUER_IDENTIFIER)
    expect(result.source.finalUrl).toBe('https://issuer.example/metadata/v1')
    expect(result.source.redirects).toEqual(['https://issuer.example/metadata/v1'])
    expect(fake.requests).toHaveLength(2)
  })

  test('re-validates a redirect and never fetches a private target', async () => {
    const registry = registryFixture()
    const fake = createFakeTransport({
      [METADATA_URL]: {
        status: 302,
        headers: { location: 'https://169.254.169.254/latest/meta-data' },
      },
    })
    await expectImportError(
      () => discoveryFor(registry.registry, fake.transport).discover(ISSUER_IDENTIFIER),
      'blocked_address',
    )
    expect(fake.requests).toHaveLength(1)
  })

  test('refuses metadata that does not match the issuer identifier', async () => {
    const registry = registryFixture()
    const fake = createFakeTransport({
      [METADATA_URL]: {
        body: JSON.stringify(issuerMetadata({ credential_issuer: 'https://other.example' })),
      },
    })
    await expectImportError(
      () => discoveryFor(registry.registry, fake.transport).discover(ISSUER_IDENTIFIER),
      'invalid_issuer_metadata',
    )
  })

  test('refuses metadata with too many configurations', async () => {
    const registry = registryFixture()
    const configurations: Record<string, unknown> = {}
    for (let index = 0; index <= MAX_ISSUER_CONFIGURATIONS; index += 1) {
      configurations[`configuration-${index}`] = { format: 'dc+sd-jwt', vct: PID_VCT }
    }
    const fake = createFakeTransport({
      [METADATA_URL]: {
        body: JSON.stringify(
          issuerMetadata({ credential_configurations_supported: configurations }),
        ),
      },
    })
    await expectImportError(
      () => discoveryFor(registry.registry, fake.transport).discover(ISSUER_IDENTIFIER),
      'entry_limit',
    )
  })

  test('reports invalid configurations while keeping the valid ones', async () => {
    const registry = registryFixture()
    const fake = createFakeTransport({
      [METADATA_URL]: {
        body: JSON.stringify(
          issuerMetadata({
            credential_configurations_supported: {
              broken: 'not-an-object',
              pid: { format: 'dc+sd-jwt', vct: PID_VCT },
            },
          }),
        ),
      },
    })
    const result = await discoveryFor(registry.registry, fake.transport).discover(ISSUER_IDENTIFIER)
    expect(result.summary.totalConfigurations).toBe(2)
    expect(result.summary.validConfigurations).toBe(1)
    expect(result.summary.invalidConfigurations).toBe(1)
    expect(result.summary.unmatched).toBe(1)
    expect(result.diagnostics.some((entry) => entry.code === 'invalid_configuration')).toBe(true)
  })
})
