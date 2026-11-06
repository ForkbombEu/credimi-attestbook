// Bounded parsing and validation of OpenID4VCI Credential Issuer Metadata (FR-006).
//
// The well-known document is untrusted input. URL validation, public-address
// resolution, redirect re-validation, timeouts and the byte cap are handled by
// the shared import transport before this module runs; this module bounds the
// parsed structure (depth/nodes/string length come from the same limits) and
// validates every member discovery relies on. It never evaluates or resolves a
// reference and never treats the issuer document as rulebook content.
//
// Version awareness (R6.2): OpenID4VCI 1.0 uses the
// `credential_configurations_supported` object; earlier drafts used
// `credentials_supported` (array or object). Both shapes are understood, and
// the detected shape is reported so a caller can see which generation was read.

import { MAX_TEXT_LENGTH, MAX_URL_LENGTH } from '../registry/validation'
import { importError, isImportError } from '../import/errors'
import type { ImportLimits } from '../import/limits'
import { isRecord } from '../standards/profiles'
import { validateImportUrl } from '../import/url'

import type {
  ConfigurationSchemaSource,
  ConfigurationTypeIdentifier,
  DiscoveredCredentialConfiguration,
  DiscoveredSchemaReference,
  IssuerDiscoveryDiagnostic,
  IssuerMetadataShape,
  IssuerMetadataSummary,
} from './types'

/** `/.well-known/openid-credential-issuer`, inserted between the host and the issuer path. */
export const ISSUER_METADATA_WELL_KNOWN_PATH = '/.well-known/openid-credential-issuer'

/** Maximum number of configurations accepted from one metadata document. */
export const MAX_ISSUER_CONFIGURATIONS = 200

/** Maximum type identifiers accepted per configuration. */
export const MAX_TYPE_IDENTIFIERS_PER_CONFIGURATION = 32

/** Maximum schema references accepted per configuration. */
export const MAX_SCHEMA_REFERENCES_PER_CONFIGURATION = 16

/** Maximum authorization servers retained from metadata. */
export const MAX_AUTHORIZATION_SERVERS = 16

/** Maximum length of a display name retained for humans. */
export const MAX_DISPLAY_NAME_LENGTH = 200

/** Metadata members some deployments expose as schema references (profile extensions). */
const OPTIONAL_SCHEMA_MEMBERS = [
  'schema',
  'schema_uri',
  'schemaUri',
  'schema_url',
  'schemaUrl',
  'schemaURI',
] as const

/** A validated issuer identifier and the well-known URL discovery will fetch. */
export interface IssuerMetadataTarget {
  readonly issuerIdentifier: string
  readonly metadataUrl: URL
}

function normalizeIssuerIdentifier(url: URL): string {
  const normalized = new URL(url.href)
  normalized.hash = ''
  normalized.search = ''
  if (normalized.pathname.length > 1 && normalized.pathname.endsWith('/')) {
    normalized.pathname = normalized.pathname.slice(0, -1)
  }
  return normalized.href
}

function requireHttpsUrl(value: unknown, field: string, maxLength = MAX_URL_LENGTH): URL {
  if (typeof value !== 'string' || value.trim() === '') {
    throw importError('invalid_issuer_metadata', `${field} must be a non-empty string`, field)
  }
  if (value.length > maxLength) {
    throw importError(
      'invalid_issuer_metadata',
      `${field} must be at most ${maxLength} characters`,
      field,
    )
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw importError('invalid_issuer_metadata', `${field} must be an absolute URL`, field)
  }
  if (url.protocol !== 'https:') {
    throw importError('invalid_issuer_metadata', `${field} must use https`, field)
  }
  if (url.username !== '' || url.password !== '') {
    throw importError('invalid_issuer_metadata', `${field} must not embed credentials`, field)
  }
  url.hash = ''
  return url
}

/**
 * Derives the `.well-known/openid-credential-issuer` URL from the issuer
 * identifier and validates both under the shared https-only URL policy.
 *
 * OpenID4VCI 1.0 §12.2.2 inserts the well-known string into the Credential
 * Issuer Identifier between the host and the path, so
 * `https://issuer.example/tenant` is served at
 * `https://issuer.example/.well-known/openid-credential-issuer/tenant`.
 * A URL that already names the 1.0-form document is accepted, and the earlier
 * appended-path form (`https://issuer.example/tenant/.well-known/...`) is
 * accepted for older deployments; in both cases the prefix is the identifier.
 */
export function buildIssuerMetadataTarget(
  value: unknown,
  limits: ImportLimits,
): IssuerMetadataTarget {
  let url: URL
  try {
    url = validateImportUrl(value, limits)
  } catch (error) {
    if (isImportError(error)) {
      throw error
    }
    throw importError('invalid_url', 'the credential issuer URL must be an absolute https URL')
  }
  if (url.search !== '') {
    throw importError('invalid_url', 'the credential issuer URL must not contain a query component')
  }
  url.search = ''
  url.hash = ''

  const wellKnown = ISSUER_METADATA_WELL_KNOWN_PATH
  let metadataUrl: URL
  let issuerUrl: URL
  if (url.pathname === wellKnown || url.pathname.startsWith(`${wellKnown}/`)) {
    // Explicit OpenID4VCI 1.0 form: https://host/.well-known/.../tenant
    metadataUrl = new URL(url.href)
    issuerUrl = new URL(url.href)
    const rest = url.pathname.slice(wellKnown.length)
    issuerUrl.pathname = rest === '' ? '/' : rest
  } else if (url.pathname.endsWith(wellKnown)) {
    // Earlier appended-path form: https://host/tenant/.well-known/...
    metadataUrl = new URL(url.href)
    issuerUrl = new URL(url.href)
    const prefix = url.pathname.slice(0, -wellKnown.length)
    issuerUrl.pathname = prefix === '' ? '/' : prefix
  } else {
    // Bare identifier: insert the well-known string between host and path.
    issuerUrl = new URL(url.href)
    metadataUrl = new URL(url.href)
    metadataUrl.pathname = `${wellKnown}${url.pathname.replace(/\/+$/, '')}`
  }
  issuerUrl.search = ''
  issuerUrl.hash = ''
  metadataUrl.search = ''
  metadataUrl.hash = ''

  return {
    issuerIdentifier: normalizeIssuerIdentifier(issuerUrl),
    metadataUrl,
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

function diagnostic(code: string, message: string, path?: string): IssuerDiscoveryDiagnostic {
  return path === undefined ? { code, message } : { code, message, path }
}

function readDisplayName(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null
  }
  for (const entry of value) {
    if (isRecord(entry) && typeof entry['name'] === 'string') {
      const name = entry['name'].trim()
      if (name !== '' && name.length <= MAX_DISPLAY_NAME_LENGTH) {
        return name
      }
    }
  }
  return null
}

interface ConfigurationEntry {
  readonly configurationId: string
  readonly value: unknown
  readonly path: string
}

function readConfigurationEntries(
  record: Record<string, unknown>,
): { readonly shape: IssuerMetadataShape; readonly entries: readonly ConfigurationEntry[] } | null {
  const current = record['credential_configurations_supported']
  if (isRecord(current)) {
    return {
      shape: 'oid4vci_1_0',
      entries: Object.entries(current).map(([configurationId, value]) => ({
        configurationId,
        value,
        path: `credential_configurations_supported.${configurationId}`,
      })),
    }
  }

  const legacy = record['credentials_supported']
  if (Array.isArray(legacy)) {
    return {
      shape: 'oid4vci_legacy',
      entries: legacy.map((value: unknown, index: number) => ({
        configurationId: String(index),
        value,
        path: `credentials_supported[${index}]`,
      })),
    }
  }
  if (isRecord(legacy)) {
    return {
      shape: 'oid4vci_legacy',
      entries: Object.entries(legacy).map(([configurationId, value]) => ({
        configurationId,
        value,
        path: `credentials_supported.${configurationId}`,
      })),
    }
  }
  return null
}

function readTypeIdentifiers(
  entry: Record<string, unknown>,
  format: string,
  diagnostics: IssuerDiscoveryDiagnostic[],
  path: string,
): readonly ConfigurationTypeIdentifier[] | null {
  const identifiers: ConfigurationTypeIdentifier[] = []
  const seen = new Set<string>()
  const add = (kind: ConfigurationTypeIdentifier['kind'], value: string): boolean => {
    if (value.length > MAX_URL_LENGTH || hasControlCharacters(value)) {
      diagnostics.push(
        diagnostic(
          'invalid_configuration',
          `a type identifier must be control-free and at most ${MAX_URL_LENGTH} characters`,
          path,
        ),
      )
      return false
    }
    const key = `${kind}:${value}`
    if (seen.has(key)) {
      return true
    }
    if (identifiers.length >= MAX_TYPE_IDENTIFIERS_PER_CONFIGURATION) {
      diagnostics.push(
        diagnostic(
          'metadata_limit',
          `a configuration declares more than ${MAX_TYPE_IDENTIFIERS_PER_CONFIGURATION} type identifiers`,
          path,
        ),
      )
      return false
    }
    seen.add(key)
    identifiers.push({ kind, value })
    return true
  }

  // SD-JWT VC defines `vct` as a case-sensitive StringOrURI: a URN is a valid
  // type identifier, so it is kept verbatim and is not required to be a URL.
  const vct = entry['vct']
  if (vct !== undefined) {
    if (typeof vct !== 'string') {
      diagnostics.push(
        diagnostic(
          'invalid_configuration',
          'the vct type identifier must be a string',
          `${path}.vct`,
        ),
      )
      return null
    }
    if (vct.trim() === '') {
      diagnostics.push(
        diagnostic(
          'invalid_configuration',
          'the vct type identifier must not be empty',
          `${path}.vct`,
        ),
      )
      return null
    }
    if (!add('vct', vct)) {
      return null
    }
  }

  const declaredDoctype = [entry['doctype'], entry['doctype_value']].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '',
  )
  if (declaredDoctype !== undefined && !add('doctype', declaredDoctype)) {
    return null
  }

  const legacyTypes = entry['types']
  const credentialDefinition = entry['credential_definition']
  const declaredTypes =
    Array.isArray(legacyTypes) && legacyTypes.length > 0
      ? legacyTypes
      : isRecord(credentialDefinition) && Array.isArray(credentialDefinition['type'])
        ? credentialDefinition['type']
        : []

  for (const declared of declaredTypes) {
    if (typeof declared !== 'string' || declared.trim() === '') {
      diagnostics.push(
        diagnostic(
          'invalid_configuration',
          'legacy credential types must be non-empty strings',
          path,
        ),
      )
      return null
    }
    if (!add('type', declared)) {
      return null
    }
  }

  if (identifiers.length === 0) {
    diagnostics.push(
      diagnostic(
        'invalid_configuration',
        `a configuration for format '${format}' declares no type identifier`,
        path,
      ),
    )
    return null
  }
  return identifiers
}

function readSchemaReferences(
  entry: Record<string, unknown>,
  format: string,
  typeIdentifiers: readonly ConfigurationTypeIdentifier[],
  diagnostics: IssuerDiscoveryDiagnostic[],
  path: string,
): readonly DiscoveredSchemaReference[] | null {
  const references: DiscoveredSchemaReference[] = []
  const seen = new Set<string>()
  const add = (uri: string, source: ConfigurationSchemaSource): boolean => {
    if (seen.has(uri)) {
      return true
    }
    if (references.length >= MAX_SCHEMA_REFERENCES_PER_CONFIGURATION) {
      diagnostics.push(
        diagnostic(
          'metadata_limit',
          `a configuration declares more than ${MAX_SCHEMA_REFERENCES_PER_CONFIGURATION} schema references`,
          path,
        ),
      )
      return false
    }
    seen.add(uri)
    references.push({ formatIdentifier: format, uri, source })
    return true
  }

  // For SD-JWT VC an https `vct` is a resolvable type metadata reference. A
  // non-URL StringOrURI (for example the EUDI PID `urn:eudi:pid:1`) is a valid
  // identifier but exposes no fetchable reference, so it is skipped silently.
  const vct = typeIdentifiers.find((identifier) => identifier.kind === 'vct')
  if (vct !== undefined) {
    try {
      const vctUrl = requireHttpsUrl(vct.value, `${path}.vct`)
      if (!add(vctUrl.href, 'vct')) {
        return null
      }
    } catch (error) {
      if (!isImportError(error)) {
        throw error
      }
    }
  }

  for (const member of OPTIONAL_SCHEMA_MEMBERS) {
    const value = entry[member]
    if (value === undefined) {
      continue
    }
    if (typeof value !== 'string' || value.trim() === '') {
      diagnostics.push(
        diagnostic(
          'invalid_configuration',
          `the optional '${member}' schema reference must be a non-empty string`,
          `${path}.${member}`,
        ),
      )
      return null
    }
    let schemaUrl: URL
    try {
      schemaUrl = requireHttpsUrl(value, `${path}.${member}`)
    } catch (error) {
      if (isImportError(error)) {
        diagnostics.push(diagnostic('invalid_configuration', error.message, error.path))
        return null
      }
      throw error
    }
    if (!add(schemaUrl.href, 'schema')) {
      return null
    }
  }

  return references
}

function readConfiguration(
  entry: ConfigurationEntry,
  diagnostics: IssuerDiscoveryDiagnostic[],
): DiscoveredCredentialConfiguration | null {
  if (!isRecord(entry.value)) {
    diagnostics.push(
      diagnostic(
        'invalid_configuration',
        'a credential configuration must be an object',
        entry.path,
      ),
    )
    return null
  }

  if (
    entry.configurationId.trim() === '' ||
    entry.configurationId.length > MAX_TEXT_LENGTH ||
    hasControlCharacters(entry.configurationId)
  ) {
    diagnostics.push(
      diagnostic(
        'invalid_configuration',
        `a configuration identifier must be non-empty, control-free and at most ${MAX_TEXT_LENGTH} characters`,
        entry.path,
      ),
    )
    return null
  }

  const rawFormat = entry.value['format']
  if (
    typeof rawFormat !== 'string' ||
    rawFormat.trim() === '' ||
    rawFormat.length > MAX_TEXT_LENGTH ||
    hasControlCharacters(rawFormat)
  ) {
    diagnostics.push(
      diagnostic(
        'invalid_configuration',
        `a configuration must declare a non-empty 'format' of at most ${MAX_TEXT_LENGTH} characters`,
        `${entry.path}.format`,
      ),
    )
    return null
  }
  const format = rawFormat

  const typeIdentifiers = readTypeIdentifiers(entry.value, format, diagnostics, entry.path)
  if (typeIdentifiers === null) {
    return null
  }
  const schemaReferences = readSchemaReferences(
    entry.value,
    format,
    typeIdentifiers,
    diagnostics,
    entry.path,
  )
  if (schemaReferences === null) {
    return null
  }

  return {
    configurationId: entry.configurationId,
    format,
    displayName: readDisplayName(entry.value['display']),
    typeIdentifiers,
    schemaReferences,
  }
}

/** The result of validating and extracting one metadata document. */
export interface ExtractedIssuerMetadata {
  readonly metadataShape: IssuerMetadataShape
  readonly issuer: IssuerMetadataSummary
  readonly configurations: readonly DiscoveredCredentialConfiguration[]
  readonly invalidConfigurations: number
  readonly diagnostics: readonly IssuerDiscoveryDiagnostic[]
}

/**
 * Validates an issuer metadata document and extracts the credential
 * configurations discovery can use. Throws an `ImportError` when the document
 * is not a supported OpenID4VCI metadata object; per-configuration problems are
 * reported as diagnostics so one malformed entry does not hide the rest.
 */
export function extractIssuerMetadata(
  value: unknown,
  target: IssuerMetadataTarget,
): ExtractedIssuerMetadata {
  if (!isRecord(value)) {
    throw importError(
      'invalid_issuer_metadata',
      'the credential issuer metadata is not a JSON object',
    )
  }

  const credentialIssuer = requireHttpsUrl(
    value['credential_issuer'],
    'credential_issuer',
    MAX_URL_LENGTH,
  )
  if (normalizeIssuerIdentifier(credentialIssuer) !== target.issuerIdentifier) {
    throw importError(
      'invalid_issuer_metadata',
      'the metadata credential_issuer does not match the discovered issuer identifier',
      'credential_issuer',
    )
  }

  const diagnostics: IssuerDiscoveryDiagnostic[] = []

  let credentialEndpoint: string | null = null
  const rawEndpoint = value['credential_endpoint']
  if (rawEndpoint !== undefined) {
    try {
      credentialEndpoint = requireHttpsUrl(rawEndpoint, 'credential_endpoint', MAX_URL_LENGTH).href
    } catch (error) {
      if (isImportError(error)) {
        diagnostics.push(diagnostic('invalid_metadata_member', error.message, error.path))
      } else {
        throw error
      }
    }
  }

  const authorizationServers: string[] = []
  const rawServers = value['authorization_servers']
  if (rawServers !== undefined) {
    if (!Array.isArray(rawServers)) {
      diagnostics.push(
        diagnostic(
          'invalid_metadata_member',
          'authorization_servers must be an array',
          'authorization_servers',
        ),
      )
    } else {
      for (const [index, server] of rawServers.slice(0, MAX_AUTHORIZATION_SERVERS).entries()) {
        try {
          authorizationServers.push(
            requireHttpsUrl(server, `authorization_servers[${index}]`, MAX_URL_LENGTH).href,
          )
        } catch (error) {
          if (isImportError(error)) {
            diagnostics.push(diagnostic('invalid_metadata_member', error.message, error.path))
          } else {
            throw error
          }
        }
      }
      if (rawServers.length > MAX_AUTHORIZATION_SERVERS) {
        diagnostics.push(
          diagnostic(
            'metadata_limit',
            `authorization_servers is truncated to ${MAX_AUTHORIZATION_SERVERS} entries`,
            'authorization_servers',
          ),
        )
      }
    }
  }

  const read = readConfigurationEntries(value)
  if (read === null) {
    throw importError(
      'invalid_issuer_metadata',
      "the credential issuer metadata has no 'credential_configurations_supported' object or legacy 'credentials_supported' member",
    )
  }
  if (read.entries.length > MAX_ISSUER_CONFIGURATIONS) {
    throw importError(
      'entry_limit',
      `the credential issuer metadata declares more than ${MAX_ISSUER_CONFIGURATIONS} configurations`,
      read.shape === 'oid4vci_1_0'
        ? 'credential_configurations_supported'
        : 'credentials_supported',
    )
  }

  const configurations: DiscoveredCredentialConfiguration[] = []
  let invalidConfigurations = 0
  for (const entry of read.entries) {
    const configuration = readConfiguration(entry, diagnostics)
    if (configuration === null) {
      invalidConfigurations += 1
      continue
    }
    configurations.push(configuration)
  }

  return {
    metadataShape: read.shape,
    issuer: {
      credentialIssuer: credentialIssuer.href,
      credentialEndpoint,
      authorizationServers,
    },
    configurations,
    invalidConfigurations,
    diagnostics,
  }
}
