// Deterministic comparison of two stored rulebook version snapshots (issue #41).
//
// A comparison is a structural diff of the snapshot content, not a text diff of
// the stored bytes: the version label, the rulebook identifier and the artifact
// format marker are identity fields of the snapshot rather than rulebook
// content, so they are excluded. That lets two labels with the same content
// compare as identical while a changed profile still shows up.
//
// Determinism: object keys are visited in sorted order and the resulting change
// list is sorted by its JSON Pointer path. The same two snapshots therefore
// always produce the same changes in the same order, independent of insertion
// order or of which version is used as the baseline.

import type { RulebookVersionDocument } from '../registry/versioning'

/** A JSON value. Snapshot documents are plain JSON, including nested arrays. */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export const VERSION_DIFF_CHANGE_KINDS = ['added', 'removed', 'changed'] as const
export type VersionDiffChangeKind = (typeof VERSION_DIFF_CHANGE_KINDS)[number]

/**
 * One structural difference. `path` is a JSON Pointer into the comparable
 * content; `before` is present for `removed`/`changed` and `after` for
 * `added`/`changed`.
 */
export interface VersionDiffChange {
  readonly path: string
  readonly kind: VersionDiffChangeKind
  readonly before?: JsonValue
  readonly after?: JsonValue
}

export interface VersionDiffSummary {
  readonly added: number
  readonly removed: number
  readonly changed: number
}

export interface VersionContentDiff {
  /** True when the comparable content is equal, including for two labels. */
  readonly identical: boolean
  readonly changes: readonly VersionDiffChange[]
  readonly summary: VersionDiffSummary
}

/**
 * The comparable subset of a snapshot: everything a provider authors. The
 * snapshot's `format`, `rulebookId` and `version` are identity, not content.
 */
interface ComparableContent {
  readonly name: string
  readonly description: string
  readonly sourceUrl: string | null
  readonly specVersion: string
  readonly attestations: readonly unknown[]
  readonly schemaReferences: readonly unknown[]
}

function comparableContent(document: RulebookVersionDocument): ComparableContent {
  return {
    name: document.name,
    description: document.description,
    sourceUrl: document.sourceUrl,
    specVersion: document.specVersion,
    attestations: document.attestations,
    schemaReferences: document.schemaReferences,
  }
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value)
}

function deepEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true
  }
  if (isJsonArray(left) || isJsonArray(right)) {
    if (!isJsonArray(left) || !isJsonArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((entry, index) => {
      const other = right[index]
      return other !== undefined && deepEqual(entry, other)
    })
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    if (leftKeys.length !== rightKeys.length) {
      return false
    }
    return leftKeys.every((key, index) => {
      const rightKey = rightKeys[index]
      return rightKey === key && deepEqual(left[key] as JsonValue, right[key] as JsonValue)
    })
  }
  return false
}

/** RFC 6901 escaping of one path segment. */
function escapeSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1')
}

function childPath(parent: string, segment: string): string {
  return `${parent}/${escapeSegment(segment)}`
}

function addMissing(
  changes: VersionDiffChange[],
  path: string,
  kind: 'added' | 'removed',
  value: JsonValue,
): void {
  changes.push(kind === 'added' ? { path, kind, after: value } : { path, kind, before: value })
}

function diffValues(
  left: JsonValue,
  right: JsonValue,
  path: string,
  changes: VersionDiffChange[],
): void {
  if (deepEqual(left, right)) {
    return
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    for (const key of keys) {
      const leftHas = Object.hasOwn(left, key)
      const rightHas = Object.hasOwn(right, key)
      const leftValue = left[key]
      const rightValue = right[key]
      if (leftHas && rightHas && leftValue !== undefined && rightValue !== undefined) {
        diffValues(leftValue, rightValue, childPath(path, key), changes)
      } else if (leftHas && leftValue !== undefined) {
        addMissing(changes, childPath(path, key), 'removed', leftValue)
      } else if (rightHas && rightValue !== undefined) {
        addMissing(changes, childPath(path, key), 'added', rightValue)
      }
    }
    return
  }
  if (isJsonArray(left) && isJsonArray(right)) {
    const length = Math.max(left.length, right.length)
    for (let index = 0; index < length; index += 1) {
      const leftValue = left[index]
      const rightValue = right[index]
      const indexPath = childPath(path, String(index))
      if (leftValue !== undefined && rightValue !== undefined) {
        diffValues(leftValue, rightValue, indexPath, changes)
      } else if (leftValue !== undefined) {
        addMissing(changes, indexPath, 'removed', leftValue)
      } else if (rightValue !== undefined) {
        addMissing(changes, indexPath, 'added', rightValue)
      }
    }
    return
  }
  changes.push({ path, kind: 'changed', before: left, after: right })
}

/** Serializes the comparable content as plain JSON values before diffing. */
function toComparableJson(document: RulebookVersionDocument): JsonValue {
  return JSON.parse(JSON.stringify(comparableContent(document))) as JsonValue
}

/**
 * Compares the authored content of two snapshots. The change list is sorted by
 * path and carries JSON Pointer paths so a client can render it without
 * re-deriving the structure.
 */
export function compareVersionDocuments(
  from: RulebookVersionDocument,
  to: RulebookVersionDocument,
): VersionContentDiff {
  const changes: VersionDiffChange[] = []
  diffValues(toComparableJson(from), toComparableJson(to), '', changes)
  changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

  const counts = { added: 0, removed: 0, changed: 0 }
  for (const change of changes) {
    counts[change.kind] += 1
  }

  return {
    identical: changes.length === 0,
    changes,
    summary: {
      added: counts.added,
      removed: counts.removed,
      changed: counts.changed,
    },
  }
}
