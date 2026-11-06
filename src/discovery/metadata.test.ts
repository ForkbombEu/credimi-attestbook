import { describe, expect, test } from 'bun:test'

import { ImportError, type ImportErrorCode } from '../import/errors'
import { DEFAULT_IMPORT_LIMITS } from '../import/limits'

import {
  buildIssuerMetadataTarget,
  extractIssuerMetadata,
  ISSUER_METADATA_WELL_KNOWN_PATH,
  MAX_ISSUER_CONFIGURATIONS,
} from './metadata'
import {
  issuerMetadata,
  ISSUER_IDENTIFIER,
  legacyIssuerMetadata,
  MDL_DOCTYPE,
  PID_VCT,
} from './test/fixtures'

const limits = DEFAULT_IMPORT_LIMITS

function target(value: unknown = ISSUER_IDENTIFIER) {
  return buildIssuerMetadataTarget(value, limits)
}

async function expectImportError(
  operation: () => unknown,
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

describe('issuer metadata URL construction', () => {
  test('derives the well-known URL for a root issuer identifier', () => {
    const result = target()
    expect(result.metadataUrl.href).toBe(`https://issuer.example${ISSUER_METADATA_WELL_KNOWN_PATH}`)
    expect(result.issuerIdentifier).toBe('https://issuer.example/')
  })

  test('inserts the well-known path between the host and an identifier path', () => {
    const result = target('https://issuer.example/tenant/')
    expect(result.metadataUrl.href).toBe(
      `https://issuer.example${ISSUER_METADATA_WELL_KNOWN_PATH}/tenant`,
    )
    expect(result.issuerIdentifier).toBe('https://issuer.example/tenant')
  })

  test('derives the same URL without a trailing slash on the identifier', () => {
    const withSlash = target('https://issuer.example/tenant/')
    const withoutSlash = target('https://issuer.example/tenant')
    expect(withoutSlash.metadataUrl.href).toBe(withSlash.metadataUrl.href)
    expect(withoutSlash.issuerIdentifier).toBe('https://issuer.example/tenant')
  })

  test('accepts an explicit OpenID4VCI 1.0 metadata URL', () => {
    const result = target(`https://issuer.example${ISSUER_METADATA_WELL_KNOWN_PATH}/tenant`)
    expect(result.metadataUrl.href).toBe(
      `https://issuer.example${ISSUER_METADATA_WELL_KNOWN_PATH}/tenant`,
    )
    expect(result.issuerIdentifier).toBe('https://issuer.example/tenant')
  })

  test('accepts the earlier appended-path metadata URL', () => {
    const result = target(`https://issuer.example/tenant${ISSUER_METADATA_WELL_KNOWN_PATH}`)
    expect(result.metadataUrl.href).toBe(
      `https://issuer.example/tenant${ISSUER_METADATA_WELL_KNOWN_PATH}`,
    )
    expect(result.issuerIdentifier).toBe('https://issuer.example/tenant')
  })

  test('rejects a non-https issuer URL', async () => {
    await expectImportError(() => target('http://issuer.example'), 'invalid_url')
  })

  test('rejects an issuer URL with a query component', async () => {
    await expectImportError(() => target('https://issuer.example?tenant=1'), 'invalid_url')
  })

  test('rejects a blocked IP-literal issuer address', async () => {
    await expectImportError(() => target('https://127.0.0.1'), 'blocked_address')
  })

  test('rejects a URL with embedded credentials', async () => {
    await expectImportError(() => target('https://user:pass@issuer.example'), 'invalid_url')
  })
})

describe('issuer metadata validation and extraction', () => {
  test('extracts formats, type identifiers, schema references and display names', () => {
    const extracted = extractIssuerMetadata(issuerMetadata(), target())

    expect(extracted.metadataShape).toBe('oid4vci_1_0')
    expect(extracted.invalidConfigurations).toBe(0)
    expect(extracted.issuer).toEqual({
      credentialIssuer: 'https://issuer.example/',
      credentialEndpoint: 'https://issuer.example/credential',
      authorizationServers: ['https://issuer.example/'],
    })

    const pid = extracted.configurations.find(
      (configuration) => configuration.configurationId === 'pid',
    )
    expect(pid).toEqual({
      configurationId: 'pid',
      format: 'dc+sd-jwt',
      displayName: 'Person Identification Data',
      typeIdentifiers: [{ kind: 'vct', value: PID_VCT }],
      schemaReferences: [{ formatIdentifier: 'dc+sd-jwt', uri: PID_VCT, source: 'vct' }],
    })

    const mdl = extracted.configurations.find(
      (configuration) => configuration.configurationId === 'mdl',
    )
    expect(mdl?.format).toBe('mso_mdoc')
    expect(mdl?.typeIdentifiers).toEqual([{ kind: 'doctype', value: MDL_DOCTYPE }])
    expect(mdl?.schemaReferences).toEqual([])
  })

  test('understands the earlier credentials_supported shape', () => {
    const extracted = extractIssuerMetadata(legacyIssuerMetadata(), target())
    expect(extracted.metadataShape).toBe('oid4vci_legacy')
    expect(extracted.configurations).toHaveLength(1)
    expect(extracted.configurations[0]).toMatchObject({
      configurationId: '0',
      format: 'ldp_vc',
      typeIdentifiers: [
        { kind: 'type', value: 'VerifiableCredential' },
        { kind: 'type', value: 'UniversityDegreeCredential' },
      ],
    })
  })

  test('rejects metadata whose credential_issuer does not match the identifier', async () => {
    const metadata = issuerMetadata({ credential_issuer: 'https://other.example' })
    const error = await expectImportError(
      () => extractIssuerMetadata(metadata, target()),
      'invalid_issuer_metadata',
    )
    expect(error.message).toContain('credential_issuer')
  })

  test('rejects a non-object metadata document', async () => {
    await expectImportError(() => extractIssuerMetadata([], target()), 'invalid_issuer_metadata')
  })

  test('rejects metadata without a supported configurations member', async () => {
    const metadata = issuerMetadata()
    delete metadata['credential_configurations_supported']
    await expectImportError(
      () => extractIssuerMetadata(metadata, target()),
      'invalid_issuer_metadata',
    )
  })

  test('rejects metadata that declares too many configurations', async () => {
    const configurations: Record<string, unknown> = {}
    for (let index = 0; index <= MAX_ISSUER_CONFIGURATIONS; index += 1) {
      configurations[`configuration-${index}`] = { format: 'dc+sd-jwt', vct: PID_VCT }
    }
    const metadata = issuerMetadata({ credential_configurations_supported: configurations })
    await expectImportError(() => extractIssuerMetadata(metadata, target()), 'entry_limit')
  })

  test('reports a malformed configuration without hiding the valid ones', () => {
    const metadata = issuerMetadata({
      credential_configurations_supported: {
        broken: 'not-an-object',
        pid: { format: 'dc+sd-jwt', vct: PID_VCT },
        unknown: { format: 'mso_mdoc' },
      },
    })
    const extracted = extractIssuerMetadata(metadata, target())

    expect(extracted.invalidConfigurations).toBe(2)
    expect(extracted.configurations).toHaveLength(1)
    const codes = extracted.diagnostics.map((entry) => entry.code)
    expect(codes).toContain('invalid_configuration')
    expect(extracted.diagnostics.some((entry) => entry.path?.includes('unknown'))).toBe(true)
  })

  test('rejects a vct containing control characters as a configuration error', () => {
    const metadata = issuerMetadata({
      credential_configurations_supported: {
        pid: { format: 'dc+sd-jwt', vct: 'urn:x\u0001' },
      },
    })
    const extracted = extractIssuerMetadata(metadata, target())
    expect(extracted.configurations).toHaveLength(0)
    expect(extracted.invalidConfigurations).toBe(1)
    expect(extracted.diagnostics[0]?.message).toContain('control-free')
  })

  test('rejects a non-string vct at its metadata path', () => {
    const metadata = issuerMetadata({
      credential_configurations_supported: {
        pid: { format: 'dc+sd-jwt', vct: 42 },
      },
    })
    const extracted = extractIssuerMetadata(metadata, target())
    expect(extracted.configurations).toHaveLength(0)
    expect(extracted.invalidConfigurations).toBe(1)
    expect(extracted.diagnostics[0]?.code).toBe('invalid_configuration')
    expect(extracted.diagnostics[0]?.path).toContain('pid.vct')
  })

  test('accepts a URN vct as a case-sensitive StringOrURI', () => {
    const metadata = issuerMetadata({
      credential_configurations_supported: {
        pid: { format: 'dc+sd-jwt', vct: 'urn:eudi:pid:1' },
      },
    })
    const extracted = extractIssuerMetadata(metadata, target())
    expect(extracted.invalidConfigurations).toBe(0)
    expect(extracted.diagnostics).toEqual([])
    expect(extracted.configurations[0]?.typeIdentifiers).toEqual([
      { kind: 'vct', value: 'urn:eudi:pid:1' },
    ])
    expect(extracted.configurations[0]?.schemaReferences).toEqual([])
  })

  test('keeps an https vct verbatim and normalizes only its schema reference', () => {
    const metadata = issuerMetadata({
      credential_configurations_supported: {
        pid: { format: 'dc+sd-jwt', vct: 'https://Example.com/PID' },
      },
    })
    const extracted = extractIssuerMetadata(metadata, target())
    expect(extracted.configurations[0]?.typeIdentifiers).toEqual([
      { kind: 'vct', value: 'https://Example.com/PID' },
    ])
    expect(extracted.configurations[0]?.schemaReferences).toEqual([
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: 'https://example.com/PID',
        source: 'vct',
      },
    ])
  })

  test('extracts an optional extension schema reference', () => {
    const metadata = issuerMetadata({
      credential_configurations_supported: {
        pid: {
          format: 'dc+sd-jwt',
          vct: PID_VCT,
          schema_uri: 'https://issuer.example/schemas/pid.json',
        },
      },
    })
    const extracted = extractIssuerMetadata(metadata, target())
    expect(extracted.configurations[0]?.schemaReferences).toEqual([
      { formatIdentifier: 'dc+sd-jwt', uri: PID_VCT, source: 'vct' },
      {
        formatIdentifier: 'dc+sd-jwt',
        uri: 'https://issuer.example/schemas/pid.json',
        source: 'schema',
      },
    ])
  })

  test('drops invalid authorization servers with a diagnostic', () => {
    const metadata = issuerMetadata({ authorization_servers: ['ftp://issuer.example'] })
    const extracted = extractIssuerMetadata(metadata, target())
    expect(extracted.issuer.authorizationServers).toEqual([])
    expect(extracted.diagnostics[0]?.code).toBe('invalid_metadata_member')
  })

  test('does not resolve or echo untrusted metadata content', () => {
    const metadata = issuerMetadata({
      credential_configurations_supported: {
        pid: { format: 'dc+sd-jwt', vct: PID_VCT },
      },
    })
    const extracted = extractIssuerMetadata(metadata, target())
    expect(JSON.stringify(extracted)).not.toContain('not-an-object')
  })
})
