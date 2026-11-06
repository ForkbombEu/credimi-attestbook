// Publication readiness checks for a stored rulebook version (issue #41).
//
// Readiness is a pre-publication assessment, never a publication or a
// standards-conformance claim. It proves the checks this build can execute:
//
//   1. the version is still a draft (published and historical versions are
//      immutable and cannot be transitioned again);
//   2. the stored snapshot bytes still match the recorded SHA-256 digest;
//   3. the snapshot still matches the rulebook's current working copy, so a
//      publication cannot silently freeze content the provider changed later;
//   4. the snapshot content passes the same structural and TS11 v1.0.1
//      standards validation the editor runs before saving;
//   5. the rulebook defines at least one attestation type, without which no
//      credential can be validated against it.
//
// Remote schema documents, issuer trust, signing and interoperability are not
// verified here; they are listed as explicit limitations instead.

import { validateDraftContent } from '../editor'
import { sha256Hex } from '../registry/digest'
import { isRulebookTransitionAllowed } from '../registry/transitions'
import type { PublicationStatus, RulebookVersion } from '../registry/types'
import type { RulebookVersionDocument } from '../registry/versioning'

export const PUBLICATION_READINESS_CHECK_STATUSES = [
  'pass',
  'fail',
  'warn',
  'not_applicable',
] as const
export type PublicationReadinessCheckStatus = (typeof PUBLICATION_READINESS_CHECK_STATUSES)[number]

/** Stable check identifiers of the readiness contract. */
export const PUBLICATION_READINESS_CHECK_IDS = [
  'draft_version',
  'rulebook_status',
  'snapshot_integrity',
  'snapshot_current',
  'content_valid',
  'standards_profile',
  'attestation_types',
] as const
export type PublicationReadinessCheckId = (typeof PUBLICATION_READINESS_CHECK_IDS)[number]

export interface PublicationReadinessCheck {
  readonly id: PublicationReadinessCheckId
  readonly status: PublicationReadinessCheckStatus
  readonly message: string
}

export interface PublicationReadiness {
  /** True only when no check reports `fail`. */
  readonly ready: boolean
  readonly checks: readonly PublicationReadinessCheck[]
  /** Explicit boundaries of this assessment; never a conformance claim. */
  readonly limitations: readonly string[]
}

export interface PublicationReadinessInput {
  readonly version: RulebookVersion
  /** Current working-copy status of the rulebook that owns the version. */
  readonly rulebookStatus: PublicationStatus
  /** Exact stored snapshot bytes of the version. */
  readonly bytes: Uint8Array
  /** Snapshot bytes the current working copy would freeze under this label. */
  readonly currentBytes: Uint8Array
  readonly document: RulebookVersionDocument
}

const BASE_LIMITATIONS: readonly string[] = [
  'Publication readiness is not a TS11 or ETSI conformance claim.',
  'Remote schema documents, issuer trust, signing and interoperability are not verified by these checks.',
]

function check(
  id: PublicationReadinessCheckId,
  status: PublicationReadinessCheckStatus,
  message: string,
): PublicationReadinessCheck {
  return { id, status, message }
}

/** One-line summary of the validation errors, bounded for the response. */
function summarizeDiagnostics(errors: readonly { readonly code: string }[]): string {
  const codes = [...new Set(errors.map((finding) => finding.code))]
  const shown = codes.slice(0, 5).join(', ')
  const suffix = codes.length > 5 ? ', ...' : ''
  return `${String(errors.length)} validation error(s) [${shown}${suffix}]`
}

/**
 * Assesses whether one stored version may be published now. The function is
 * pure: the caller supplies the stored bytes, the working-copy bytes and the
 * parsed snapshot, so the same inputs always produce the same checks.
 */
export function assessPublicationReadiness(input: PublicationReadinessInput): PublicationReadiness {
  const { version, bytes, currentBytes, document } = input
  const checks: PublicationReadinessCheck[] = []

  checks.push(
    version.status === 'draft'
      ? check('draft_version', 'pass', 'The version is a draft and can be published.')
      : check(
          'draft_version',
          'fail',
          `The version is ${version.status}; only a draft version can be published, and published or historical artifacts are immutable.`,
        ),
  )

  checks.push(
    isRulebookTransitionAllowed(input.rulebookStatus, 'published')
      ? check('rulebook_status', 'pass', 'The rulebook working copy can be published.')
      : check(
          'rulebook_status',
          'fail',
          input.rulebookStatus === 'published'
            ? 'The rulebook is already published; create the next draft version before publishing another draft.'
            : `The rulebook is ${input.rulebookStatus}; its versions cannot be published.`,
        ),
  )

  const actualDigest = sha256Hex(bytes)
  checks.push(
    actualDigest === version.contentDigest
      ? check('snapshot_integrity', 'pass', 'The stored snapshot bytes match the recorded digest.')
      : check(
          'snapshot_integrity',
          'fail',
          `The stored snapshot bytes have digest ${actualDigest}, not the recorded ${version.contentDigest}.`,
        ),
  )

  if (version.status === 'draft') {
    const currentDigest = sha256Hex(currentBytes)
    checks.push(
      currentDigest === version.contentDigest
        ? check('snapshot_current', 'pass', 'The snapshot matches the current working copy.')
        : check(
            'snapshot_current',
            'fail',
            'The snapshot is stale: the working copy changed after the draft version was taken. Refresh the draft version before publishing.',
          ),
    )
  } else {
    checks.push(
      check(
        'snapshot_current',
        'not_applicable',
        'Only a draft version is compared with the working copy; this artifact is frozen.',
      ),
    )
  }

  const report = validateDraftContent({
    name: document.name,
    description: document.description,
    sourceUrl: document.sourceUrl,
    applicableSpec: document.specVersion,
    attestations: document.attestations,
    schemaReferences: document.schemaReferences,
  })
  const errors = report.diagnostics.filter((finding) => finding.severity === 'error')
  checks.push(
    report.valid
      ? check(
          'content_valid',
          'pass',
          'Structural and standards validation found no errors in the snapshot content.',
        )
      : check(
          'content_valid',
          'fail',
          `The snapshot content is not publishable: ${summarizeDiagnostics(errors)}.`,
        ),
  )
  checks.push(
    report.profile === null
      ? check(
          'standards_profile',
          'warn',
          `Standards-level validation did not run for profile "${document.specVersion}"; only structural checks were executed.`,
        )
      : check(
          'standards_profile',
          'pass',
          `Standards-level validation ran against the ${report.profile} baseline.`,
        ),
  )
  checks.push(
    document.attestations.length > 0
      ? check('attestation_types', 'pass', 'The rulebook defines at least one attestation type.')
      : check(
          'attestation_types',
          'fail',
          'A publishable rulebook must define at least one attestation type.',
        ),
  )

  const limitations = [...BASE_LIMITATIONS, ...report.limitations]

  return {
    ready: checks.every((candidate) => candidate.status !== 'fail'),
    checks,
    limitations,
  }
}
