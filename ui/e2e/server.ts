// End-to-end server for the catalog UI tests (issue #36).
//
// It runs the real AttestBook HTTP application with the real registry and the
// built UI, so the browser test searches and filters actual API data rather
// than a mock. Data is seeded in an in-memory SQLite database at startup.

import { createApp } from '../../src/app'
import { openDatabase } from '../../src/db/database'
import { applyMigrations } from '../../src/db/migrations'
import { Registry } from '../../src/registry'
import { provisionProvider } from '../../src/registry/bootstrap'
import type { CreateRulebookInput } from '../../src/registry/types'

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

const app = createApp({ registry, uiRoot: './dist/ui' })

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: app.fetch,
})

console.log(`AttestBook catalog E2E server listening on http://${server.hostname}:${server.port}`)
