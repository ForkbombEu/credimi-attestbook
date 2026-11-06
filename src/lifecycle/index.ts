// Public surface of the rulebook lifecycle helpers (issue #41).
//
// - deterministic version comparison (UI-003 "version diff", FR-002);
// - publication readiness checks before a draft version is published.

export {
  compareVersionDocuments,
  VERSION_DIFF_CHANGE_KINDS,
  type JsonValue,
  type VersionContentDiff,
  type VersionDiffChange,
  type VersionDiffChangeKind,
  type VersionDiffSummary,
} from './version-diff'

export {
  assessPublicationReadiness,
  PUBLICATION_READINESS_CHECK_IDS,
  PUBLICATION_READINESS_CHECK_STATUSES,
  type PublicationReadiness,
  type PublicationReadinessCheck,
  type PublicationReadinessCheckId,
  type PublicationReadinessCheckStatus,
  type PublicationReadinessInput,
} from './readiness'
