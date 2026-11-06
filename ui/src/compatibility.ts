// Standards-compatibility disclosure for the rulebook detail view (issue #37).
//
// UI-002 asks for standards compatibility, and FR-010/R-18 forbid inferring a
// result: plan Phase 1 reports only structural and attestation-constraint checks
// per credential, and reports every other dimension as NOT_TESTED or
// NOT_APPLICABLE. The table below mirrors the FR-010 dimension catalogue in
// `src/validation/dimensions.ts`; `compatibility.test.ts` compares the two so
// the UI cannot silently claim support the engine does not have. There is no
// persisted rulebook-level compatibility result in Phase 1, so the section is
// always reported as NOT_TESTED for the rulebook itself.

export type EvaluationSupport = 'supported' | 'not_tested' | 'not_applicable'

export interface EvaluationDimension {
  readonly id:
    | 'credential_parsing'
    | 'format_recognition'
    | 'cryptographic_verification'
    | 'schema_validation'
    | 'attestation_constraints'
    | 'issuer_trust'
    | 'protocol_conformance'
    | 'interoperability'
  readonly title: string
  readonly support: EvaluationSupport
  /** Short explanation of what the build actually does for this dimension. */
  readonly detail: string
}

export const EVALUATION_SUPPORT: readonly EvaluationDimension[] = [
  {
    id: 'credential_parsing',
    title: 'Credential parsing',
    support: 'supported',
    detail: 'Per credential, for recognised SD-JWT VC formats.',
  },
  {
    id: 'format_recognition',
    title: 'Credential format recognition',
    support: 'supported',
    detail: 'Per credential, from the artifact or an explicit format hint.',
  },
  {
    id: 'cryptographic_verification',
    title: 'Cryptographic verification',
    support: 'not_tested',
    detail: 'Issuer signatures, KB-JWT proofs and status-list tokens are not verified.',
  },
  {
    id: 'schema_validation',
    title: 'Schema validation',
    support: 'supported',
    detail: 'Per credential, when a schema reference and schema document are supplied.',
  },
  {
    id: 'attestation_constraints',
    title: 'Attestation-specific constraints',
    support: 'supported',
    detail: 'Per credential, against a pinned rulebook version.',
  },
  {
    id: 'issuer_trust',
    title: 'Issuer and trust-policy validation',
    support: 'not_tested',
    detail: 'Issuer trust anchors and revocation policy are not resolved.',
  },
  {
    id: 'protocol_conformance',
    title: 'Protocol conformance',
    support: 'not_applicable',
    detail: 'A single credential artifact contains no issuer or verifier protocol interaction.',
  },
  {
    id: 'interoperability',
    title: 'End-to-end interoperability',
    support: 'not_applicable',
    detail: 'Wallet and verifier interoperability is not exercised by this build.',
  },
]

export const EVALUATION_SUPPORT_LABELS: Readonly<Record<EvaluationSupport, string>> = {
  supported: 'Supported per credential',
  not_tested: 'Not tested',
  not_applicable: 'Not applicable',
}

export const RULEBOOK_COMPATIBILITY_DISCLOSURE =
  'No rulebook-level compatibility result is recorded. Structural checks run per credential against a pinned version and never imply cryptographic, trust, protocol or interoperability success.'
