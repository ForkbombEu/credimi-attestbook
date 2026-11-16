// SQL persistence for anonymous webhook subscriptions (issue #117).
//
// This module owns SQL and row mapping only; validation, token authentication
// and quota orchestration live in `service.ts`, so repository code cannot
// accidentally bypass them. No token plaintext, client address or provider
// identity is written here.

import type { Database } from 'bun:sqlite'

import type { SubscriptionRecord, SubscriptionState } from './types'

interface SubscriptionRow {
  readonly id: string
  readonly rulebook_id: string
  readonly callback_url: string
  readonly management_token_hash: string
  readonly state: string
  readonly created_at: string
  readonly updated_at: string
  readonly revoked_at: string | null
  readonly verification_challenge_hash: string | null
  readonly verification_challenge_expires_at: string | null
  readonly verification_window_started_at: string | null
  readonly verification_attempts: number
  readonly verified_at: string | null
  readonly webhook_key_id: string | null
}

function toRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    rulebookId: row.rulebook_id,
    callbackUrl: row.callback_url,
    managementTokenHash: row.management_token_hash,
    // The CHECK constraint restricts this column; the cast keeps the domain
    // type honest without re-selecting the row.
    state: row.state as SubscriptionState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
    verificationChallengeHash: row.verification_challenge_hash,
    verificationChallengeExpiresAt: row.verification_challenge_expires_at,
    verificationWindowStartedAt: row.verification_window_started_at,
    verificationAttempts: row.verification_attempts,
    verifiedAt: row.verified_at,
    webhookKeyId: row.webhook_key_id,
  }
}

export class SubscriptionStore {
  constructor(private readonly database: Database) {}

  insert(record: SubscriptionRecord): void {
    this.database
      .query(
        `INSERT INTO subscriptions (
          id, rulebook_id, callback_url, management_token_hash, state,
          created_at, updated_at, revoked_at, webhook_key_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.rulebookId,
        record.callbackUrl,
        record.managementTokenHash,
        record.state,
        record.createdAt,
        record.updatedAt,
        record.revokedAt,
        record.webhookKeyId,
      )
  }

  get(id: string): SubscriptionRecord | null {
    const row = this.database
      .query<SubscriptionRow, [string]>('SELECT * FROM subscriptions WHERE id = ?')
      .get(id)
    return row === null ? null : toRecord(row)
  }

  /** Live subscriptions of one rulebook: pending or active, never revoked. */
  countLiveByRulebook(rulebookId: string): number {
    return (
      this.database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM subscriptions WHERE rulebook_id = ? AND state != 'revoked'",
        )
        .get(rulebookId)?.count ?? 0
    )
  }

  /**
   * Delivery-eligible subscriptions of one rulebook (#119): exactly the rows
   * that are `active` *and* carry the verification instant SQLite requires for
   * that state and whose stored key fingerprint matches the deployment key
   * that would sign the notification. A subscription registered while delivery
   * was disabled, or under a rotated key, was never given the current secret,
   * so it is skipped rather than sent a notification it cannot verify.
   * Pending, revoked and unrelated-rulebook rows are never returned. The
   * `(rulebook_id, state)` index bounds this read.
   */
  listDeliveryEligibleByRulebook(rulebookId: string, keyId: string): readonly SubscriptionRecord[] {
    return this.database
      .query<SubscriptionRow, [string, string]>(
        `SELECT * FROM subscriptions
         WHERE rulebook_id = ? AND state = 'active' AND verified_at IS NOT NULL
           AND webhook_key_id = ?
         ORDER BY created_at, id`,
      )
      .all(rulebookId, keyId)
      .map(toRecord)
  }

  /**
   * Delivery-eligible subscriptions that existed when one publication event was
   * recorded (#120). It narrows the #119 eligibility rule to rows registered
   * and verified no later than the event's publication instant, so a
   * reconciliation scan cannot send an old event to a subscriber that started
   * following the rulebook afterwards. A subscription verified after the
   * publication is not eligible for that earlier event.
   */
  listDeliveryEligibleForEvent(
    rulebookId: string,
    keyId: string,
    publishedAt: string,
  ): readonly SubscriptionRecord[] {
    return this.database
      .query<SubscriptionRow, [string, string, string, string]>(
        `SELECT * FROM subscriptions
         WHERE rulebook_id = ? AND state = 'active' AND verified_at IS NOT NULL
           AND webhook_key_id = ?
           AND created_at <= ? AND verified_at <= ?
         ORDER BY created_at, id`,
      )
      .all(rulebookId, keyId, publishedAt, publishedAt)
      .map(toRecord)
  }

  /**
   * Marks a live subscription revoked. Revocation is final, so an already
   * revoked row is left untouched and a repeated delete stays idempotent.
   */
  revoke(id: string, revokedAt: string): void {
    this.database
      .query(
        `UPDATE subscriptions
         SET state = 'revoked', revoked_at = ?, updated_at = ?
         WHERE id = ? AND state != 'revoked'`,
      )
      .run(revokedAt, revokedAt, id)
  }

  /**
   * Charges one verification initiation to the current attempt window. Only a
   * pending row can be charged; a revoked or active row is left untouched.
   */
  recordVerificationAttempt(
    id: string,
    windowStartedAt: string,
    attempts: number,
    updatedAt: string,
  ): void {
    this.database
      .query(
        `UPDATE subscriptions
         SET verification_window_started_at = ?, verification_attempts = ?, updated_at = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .run(windowStartedAt, attempts, updatedAt, id)
  }

  /**
   * Atomically claims the single in-flight challenge slot of a pending
   * subscription. A live challenge from another call makes the claim fail, so
   * one subscription cannot have two concurrent handshakes; an expired
   * leftover challenge (for example after a crash) can be replaced.
   */
  beginVerification(id: string, challengeHash: string, expiresAt: string, now: string): boolean {
    const result = this.database
      .query(
        `UPDATE subscriptions
         SET verification_challenge_hash = ?,
             verification_challenge_expires_at = ?,
             updated_at = ?
         WHERE id = ?
           AND state = 'pending'
           AND (verification_challenge_hash IS NULL OR verification_challenge_expires_at <= ?)`,
      )
      .run(challengeHash, expiresAt, now, id, now)
    return result.changes > 0
  }

  /**
   * Activates a pending subscription only while the expected challenge is
   * still the active one, so a stale or superseded handshake cannot activate
   * the record. Clears the challenge in the same statement.
   */
  activate(id: string, challengeHash: string, verifiedAt: string): boolean {
    const result = this.database
      .query(
        `UPDATE subscriptions
         SET state = 'active',
             verified_at = ?,
             verification_challenge_hash = NULL,
             verification_challenge_expires_at = NULL,
             updated_at = ?
         WHERE id = ? AND state = 'pending' AND verification_challenge_hash = ?`,
      )
      .run(verifiedAt, verifiedAt, id, challengeHash)
    return result.changes > 0
  }

  /** Clears only the expected in-flight challenge, leaving a newer one intact. */
  clearVerificationChallenge(id: string, challengeHash: string, updatedAt: string): void {
    this.database
      .query(
        `UPDATE subscriptions
         SET verification_challenge_hash = NULL,
             verification_challenge_expires_at = NULL,
             updated_at = ?
         WHERE id = ? AND verification_challenge_hash = ?`,
      )
      .run(updatedAt, id, challengeHash)
  }
}
