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
  }
}

export class SubscriptionStore {
  constructor(private readonly database: Database) {}

  insert(record: SubscriptionRecord): void {
    this.database
      .query(
        `INSERT INTO subscriptions (
          id, rulebook_id, callback_url, management_token_hash, state,
          created_at, updated_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
}
