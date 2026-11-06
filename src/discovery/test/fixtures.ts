// Offline fixtures for issuer discovery tests.
//
// No test performs a real network request: discovery takes the same injected
// transport and DNS resolver as the import pipeline. These documents model the
// OpenID4VCI 1.0 metadata shape and the earlier `credentials_supported` shape.

/** Issuer identifier used by the metadata fixtures. */
export const ISSUER_IDENTIFIER = 'https://issuer.example'

/** An SD-JWT VC type identifier (also the type metadata reference). */
export const PID_VCT = 'https://issuer.example/credentials/pid'

/** An mdoc document type. */
export const MDL_DOCTYPE = 'org.iso.18013.5.1.mDL'

/** A current OpenID4VCI 1.0 credential issuer metadata document. */
export function issuerMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    credential_issuer: ISSUER_IDENTIFIER,
    credential_endpoint: 'https://issuer.example/credential',
    authorization_servers: ['https://issuer.example'],
    credential_configurations_supported: {
      pid: {
        format: 'dc+sd-jwt',
        scope: 'pid',
        vct: PID_VCT,
        display: [{ name: 'Person Identification Data' }],
      },
      mdl: {
        format: 'mso_mdoc',
        scope: 'mdl',
        doctype: MDL_DOCTYPE,
      },
    },
    ...overrides,
  }
}

/** The earlier draft shape: `credentials_supported` as an array. */
export function legacyIssuerMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    credential_issuer: ISSUER_IDENTIFIER,
    credentials_supported: [
      {
        format: 'ldp_vc',
        credential_definition: {
          type: ['VerifiableCredential', 'UniversityDegreeCredential'],
        },
      },
    ],
    ...overrides,
  }
}
