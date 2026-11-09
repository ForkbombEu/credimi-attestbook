// End-to-end server for the catalog and playground UI tests (issues #36–#38).
//
// It runs the real AttestBook HTTP application with the real registry, the real
// validation engine and the built UI, so the browser tests search, filter and
// validate actual API data rather than a mock. Data is seeded in an in-memory
// SQLite database at startup; the signed credential fixture is real SD-JWT VC
// output from a throwaway test key and is written to a temporary file for the
// browser tests to paste or upload.

import { writeFileSync } from 'node:fs'

import { createApp } from '../../src/app'
import { createMockCaptureExplorer } from '../../src/capture'
import { openDatabase } from '../../src/db/database'
import { applyMigrations } from '../../src/db/migrations'
import { Registry } from '../../src/registry'
import { provisionProvider } from '../../src/registry/bootstrap'
import { sha256Hex } from '../../src/registry/digest'
import type { CreateRulebookInput } from '../../src/registry/types'
import { CredentialValidator } from '../../src/validation'
import { issueTestCredential, seedPublishedRulebook } from '../../src/validation/test-support'

import { AUTHORITY_TOKEN_FIXTURE, EDITOR_TOKEN_FIXTURE, PID_CREDENTIAL_FIXTURE } from './fixtures'

const port = Number(Bun.env.E2E_PORT ?? '4173')
const database = openDatabase(':memory:')
applyMigrations(database)
const registry = new Registry({ database })

const issuer = provisionProvider(database, {
  name: 'Example Issuer',
  publicationAuthority: 'example-issuer',
})
const lab = provisionProvider(database, {
  name: 'Wallet Lab',
  publicationAuthority: 'wallet-lab',
})
const authority = provisionProvider(database, {
  name: 'Digital Identity Authority',
  publicationAuthority: 'digital-identity-authority',
})

/**
 * A pinned, published rulebook for the playground. Its TS11 binding type is
 * valid so a real credential with an issuer-signed `cnf` claim passes the
 * structural dimensions; cryptography, schema validation (no document supplied)
 * and issuer trust stay explicitly not tested.
 */
const playgroundRulebook = seedPublishedRulebook(database, registry, {
  authority: 'playground-authority',
  rulebookName: 'Validator Sandbox Rulebook',
  attestationName: 'Sandbox Credential',
  schemaUri: 'https://example.org/vct/pid',
})

const pidCredential = await issueTestCredential()
writeFileSync(PID_CREDENTIAL_FIXTURE, pidCredential, 'utf8')
writeFileSync(EDITOR_TOKEN_FIXTURE, issuer.token.secret, 'utf8')
writeFileSync(AUTHORITY_TOKEN_FIXTURE, authority.token.secret, 'utf8')

function createPublished(token: string, input: CreateRulebookInput, version: string): string {
  const rulebook = registry.createRulebook(token, input)
  registry.createRulebookVersion(token, rulebook.id, { version })
  registry.publishRulebookVersion(token, rulebook.id, version)
  return rulebook.id
}

const pidId = createPublished(
  issuer.token.secret,
  {
    name: 'PID Rulebook',
    description: 'Person identification data rulebook maintained by the example issuer.',
    sourceUrl: 'https://issuer.example.org/rulebooks/pid',
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: 'Person Identification Data',
        attestationLoS: 'iso_18045_high',
        bindingType: 'cryptographic',
        supportedFormats: ['dc+sd-jwt', 'mso_mdoc'],
        schemaReferences: [
          {
            formatIdentifier: 'dc+sd-jwt',
            uri: 'https://issuer.example.org/schemas/pid',
            integrity: 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
          },
        ],
      },
    ],
  },
  '1.0',
)
registry.createRulebookVersion(issuer.token.secret, pidId, { version: '1.1' })

createPublished(
  authority.token.secret,
  {
    name: 'Mobile Driving Licence Rulebook',
    description: 'Driving licence attestation rulebook published by the identity authority.',
    sourceUrl: 'https://dida.example.org/rulebooks/mdl',
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: 'Mobile Driving Licence',
        attestationLoS: 'iso_18045_high',
        bindingType: 'cryptographic',
        supportedFormats: ['mso_mdoc'],
      },
    ],
  },
  '2.0',
)

createPublished(
  authority.token.secret,
  {
    name: 'Health Insurance Card Rulebook',
    description: 'Health insurance attestation rulebook for the national health service.',
    sourceUrl: 'https://dida.example.org/rulebooks/health-insurance',
    applicableSpec: 'ts11@1.0.1',
    attestations: [
      {
        name: 'Health Insurance Card',
        attestationLoS: 'iso_18045_moderate',
        bindingType: 'cryptographic',
        supportedFormats: ['mso_mdoc'],
      },
    ],
  },
  '1.2',
)

registry.createRulebook(lab.token.secret, {
  name: 'Age Verification Rulebook',
  description: 'Proof-of-age rulebook maintained by Wallet Lab.',
  applicableSpec: 'ts11@1.0.1',
  attestations: [
    {
      name: 'Proof of Age',
      attestationLoS: 'iso_18045_moderate',
      bindingType: 'cryptographic',
      supportedFormats: ['dc+sd-jwt'],
    },
  ],
})

const payment = registry.createRulebook(issuer.token.secret, {
  name: 'Payment Account Rulebook',
  description: 'Payment account access and account details rulebook.',
  sourceUrl: 'https://issuer.example.org/rulebooks/payment',
  applicableSpec: 'ts11@1.0.1',
  attestations: [
    {
      name: 'Payment Account',
      attestationLoS: 'iso_18045_high',
      bindingType: 'cryptographic',
      supportedFormats: ['dc+sd-jwt'],
    },
  ],
})
registry.createRulebookVersion(issuer.token.secret, payment.id, { version: '0.1' })

registry.createRulebook(lab.token.secret, {
  name: 'Loyalty Card Rulebook',
  description: 'Loyalty programme attestation rulebook used for local testing.',
  applicableSpec: 'ts11@1.0.1',
  attestations: [
    {
      name: 'Loyalty Card',
      attestationLoS: 'iso_18045_low',
      bindingType: 'cryptographic',
      supportedFormats: ['dc+sd-jwt'],
    },
  ],
})

const validation = new CredentialValidator({ source: registry })

/**
 * A mock capture whose inline artifact is the real signed SD-JWT VC. It is
 * opaque (non-JSON), so the explorer shows it only as a fully redacted
 * projection, while the segregated original bytes let the capture correlation
 * run the real structural validation engine against the playground rulebook.
 */
const captureCredentialBytes = new TextEncoder().encode(pidCredential)
const realCredentialCapture = {
  kind: 'attestbook.capture-artifact@1',
  envelopeVersion: 1,
  captureId: 'e2e-issued-credential-capture',
  correlationId: 'credimi-e2e-correlation-48',
  sourceComponent: 'capture-issuer',
  sourceVersion: '0.0.0-mock',
  capturedAt: '2026-11-05T09:48:23Z',
  interactionType: 'issuance',
  protocol: 'openid4vci',
  credentialFormat: 'dc+sd-jwt',
  artifactType: 'issued-credential',
  artifact: {
    mediaType: 'application/vc+sd-jwt',
    encoding: 'utf8',
    content: pidCredential,
    byteLength: captureCredentialBytes.byteLength,
  },
  integrity: { algorithm: 'sha256', digest: sha256Hex(captureCredentialBytes) },
  party: {
    role: 'issuer',
    identifier: 'https://issuer.example.test',
    name: 'Example Issuer (mock)',
  },
  testExecutionRef: 'credimi-e2e-execution-48',
  metadata: { environment: 'mock', synthetic: true },
}

const captures = createMockCaptureExplorer({
  validation,
  additionalIssuerEnvelopes: [realCredentialCapture],
})

const app = createApp({ registry, validation, captures, uiRoot: './dist/ui' })

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: app.fetch,
})

console.log(
  `AttestBook E2E server listening on http://${server.hostname}:${server.port} ` +
    `(playground rulebook ${playgroundRulebook.rulebookId})`,
)
