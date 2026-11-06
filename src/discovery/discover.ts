// Bounded OpenID4VCI credential issuer metadata discovery (FR-006, issue #43).
//
// Discovery retrieves the issuer's well-known metadata through the same
// untrusted-input transfer controls as rulebook import (https only, public
// address pinning, redirect re-validation, total deadline, per-request timeout,
// response-size cap and JSON depth/node/string bounds), validates the members
// it uses, extracts credential configurations and associates them with exact
// published or historical rulebook versions.
//
// It writes nothing: there is no discovered-issuer persistence and no manual
// mapping store in this slice. That keeps the result a reproducible observation
// of what the issuer declared at retrieval time.

import { sha256Hex } from '../registry/digest'
import { fetchImportDocument, type ImportHttpTransport } from '../import/http'
import { parseBoundedJson } from '../import/json'
import { resolveImportLimits, type ImportLimitOverrides, type ImportLimits } from '../import/limits'
import type { HostResolver } from '../import/url'

import { buildRulebookMappingIndex, mapConfiguration, type RulebookVersionSource } from './mapping'
import { buildIssuerMetadataTarget, extractIssuerMetadata } from './metadata'
import type {
  IssuerCredentialConfiguration,
  IssuerDiscoveryDiagnostic,
  IssuerDiscoveryResult,
  IssuerDiscoverySummary,
} from './types'

/** Transport-independent seam used by the HTTP application. */
export interface IssuerDiscoveryService {
  discover(credentialIssuer: unknown): Promise<IssuerDiscoveryResult>
}

/** Options for one discovery service; tests inject a deterministic transport. */
export interface IssuerDiscoveryOptions {
  readonly rulebooks: RulebookVersionSource
  readonly limits?: ImportLimitOverrides
  readonly transport?: ImportHttpTransport
  readonly resolveHostname?: HostResolver
  readonly now?: () => string
  readonly monotonicNow?: () => number
}

/** Boundaries a consumer of a discovery result must keep in mind. */
export const ISSUER_DISCOVERY_LIMITATIONS: readonly string[] = [
  'Issuer metadata is not an Attestation Rulebook and is never treated as one; an association is a candidate, not a conformance or authorisation result.',
  'Association compares the issuer format and type identifier with the schema-reference URIs frozen in published or historical rulebook versions; a rulebook that records the type identifier elsewhere is reported unmatched.',
  'Only immutable published or historical rulebook versions are mapping targets; a mutable draft is never used.',
  'Signed or JWT-secured issuer metadata is not retrieved or verified; discovery accepts JSON metadata only.',
  'Supported metadata members are the OpenID4VCI 1.0 configuration members and the earlier `credentials_supported` shape; other draft shapes may be reported as unmatched or invalid.',
  'Manual mapping and persistence of discovered issuers are not implemented in this slice; the caller receives the reported candidates only.',
]

const NO_CONFIGURATIONS_DIAGNOSTIC: IssuerDiscoveryDiagnostic = {
  code: 'no_configurations',
  message: 'the credential issuer metadata declares no credential configurations',
}

function summarize(
  configurations: readonly IssuerCredentialConfiguration[],
  invalidConfigurations: number,
): IssuerDiscoverySummary {
  let matched = 0
  let ambiguous = 0
  let unmatched = 0
  const mapped = new Set<string>()
  for (const configuration of configurations) {
    switch (configuration.mapping.status) {
      case 'matched': {
        matched += 1
        const pin = configuration.mapping.candidates[0]
        if (pin !== undefined) {
          mapped.add(`${pin.rulebookId}\u0000${pin.version}`)
        }
        break
      }
      case 'ambiguous':
        ambiguous += 1
        break
      case 'unmatched':
        unmatched += 1
        break
    }
  }
  return {
    totalConfigurations: configurations.length + invalidConfigurations,
    validConfigurations: configurations.length,
    invalidConfigurations,
    matched,
    ambiguous,
    unmatched,
    mappedRulebooks: mapped.size,
  }
}

/**
 * Discovers credential configurations for one issuer identifier. Every network
 * and parse failure is a typed `ImportError` from the shared pipeline, so the
 * HTTP layer maps it like an import failure.
 */
export class IssuerDiscovery implements IssuerDiscoveryService {
  private readonly options: IssuerDiscoveryOptions

  constructor(options: IssuerDiscoveryOptions) {
    this.options = options
  }

  async discover(credentialIssuer: unknown): Promise<IssuerDiscoveryResult> {
    const limits: ImportLimits = resolveImportLimits(this.options.limits)
    const target = buildIssuerMetadataTarget(credentialIssuer, limits)

    const fetched = await fetchImportDocument(target.metadataUrl.href, {
      limits,
      ...(this.options.transport === undefined ? {} : { transport: this.options.transport }),
      ...(this.options.resolveHostname === undefined
        ? {}
        : { resolveHostname: this.options.resolveHostname }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.monotonicNow === undefined
        ? {}
        : { monotonicNow: this.options.monotonicNow }),
    })

    const parsed = parseBoundedJson(fetched.bytes, limits)
    const extracted = extractIssuerMetadata(parsed.value, target)
    const index =
      extracted.configurations.length === 0
        ? { candidates: [], diagnostics: [] }
        : buildRulebookMappingIndex(this.options.rulebooks)

    const configurations: IssuerCredentialConfiguration[] = extracted.configurations.map(
      (configuration) => ({
        ...configuration,
        mapping: mapConfiguration(configuration, index),
      }),
    )

    const diagnostics = [...extracted.diagnostics, ...index.diagnostics]
    if (configurations.length === 0 && extracted.invalidConfigurations === 0) {
      diagnostics.push(NO_CONFIGURATIONS_DIAGNOSTIC)
    }

    const summary = summarize(configurations, extracted.invalidConfigurations)
    return {
      source: {
        issuerIdentifier: target.issuerIdentifier,
        metadataUrl: target.metadataUrl.href,
        requestedUrl: fetched.requestedUrl,
        finalUrl: fetched.finalUrl,
        retrievedAt: fetched.fetchedAt,
        contentType: fetched.contentType,
        status: fetched.status,
        byteLength: fetched.bytes.byteLength,
        contentDigest: sha256Hex(fetched.bytes),
        redirects: fetched.redirects,
        metadataShape: extracted.metadataShape,
      },
      issuer: extracted.issuer,
      configurations,
      summary,
      diagnostics,
      limitations: [...ISSUER_DISCOVERY_LIMITATIONS],
    }
  }
}
