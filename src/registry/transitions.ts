// Rulebook and version lifecycle transition policy (issue #41).
//
// The registry stores both a rulebook's working-copy status and each frozen
// version's status. This module is the single source of truth for the
// transitions that are allowed between those states, so the service methods do
// not each re-implement the immutability rules:
//
//   version:  draft -> published        (publish; a newer publication supersedes it)
//             published -> historical    (internal supersede, never a provider action)
//             historical -> *            never
//   rulebook: draft -> published        (publishing the current draft version)
//             published -> draft         (creating the next draft version)
//             historical -> *            never
//
// Published and historical snapshot rows are additionally protected by SQLite
// triggers (see docs/registry.md); this policy is the service-level contract.

import type { PublicationStatus } from './types'
import { immutable } from './errors'

/** Allowed status changes of a frozen rulebook version. */
export const VERSION_STATUS_TRANSITIONS: Readonly<
  Record<PublicationStatus, readonly PublicationStatus[]>
> = {
  draft: ['published'],
  published: ['historical'],
  historical: [],
}

/** Allowed status changes of a rulebook's working copy. */
export const RULEBOOK_STATUS_TRANSITIONS: Readonly<
  Record<PublicationStatus, readonly PublicationStatus[]>
> = {
  draft: ['published'],
  published: ['draft'],
  historical: [],
}

export function isVersionTransitionAllowed(
  from: PublicationStatus,
  to: PublicationStatus,
): boolean {
  return VERSION_STATUS_TRANSITIONS[from].includes(to)
}

export function isRulebookTransitionAllowed(
  from: PublicationStatus,
  to: PublicationStatus,
): boolean {
  return RULEBOOK_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * Rejects a status change a frozen version may not undergo. The caller keeps
 * its specific not-found/ownership checks; this only enforces the transition.
 */
export function assertVersionTransition(from: PublicationStatus, to: PublicationStatus): void {
  if (!isVersionTransitionAllowed(from, to)) {
    throw immutable(`The version is ${from}; the ${from} -> ${to} transition is not allowed.`)
  }
}

/** Rejects a working-copy status change the rulebook may not undergo. */
export function assertRulebookTransition(from: PublicationStatus, to: PublicationStatus): void {
  if (!isRulebookTransitionAllowed(from, to)) {
    throw immutable(`The rulebook is ${from}; the ${from} -> ${to} transition is not allowed.`)
  }
}
