// Transport seam for the credential validation endpoint (issue #32).
//
// The HTTP application depends on this narrow interface, so route tests can
// exercise the real engine or an intentionally failing double without opening a
// database. `CredentialValidator` satisfies it structurally.

import type { CredentialValidationResult } from './types'

export const CREDENTIAL_VALIDATION_PATH = '/api/credentials/validate'

export interface CredentialValidationService {
  validate(input: unknown): Promise<CredentialValidationResult>
}
