-- Anonymous webhook subscriptions for published rulebooks (issue #117).
--
-- A consumer registers without an AttestBook account and manages one
-- subscription with a per-subscription management token. Only the SHA-256 hash
-- of that token is stored; the plaintext is returned exactly once by the
-- registration response and cannot be recovered from the database or the API.
-- This table records the subscriber's normalized callback URL and its
-- pending/active/revoked state. It never causes an outbound request: there is no
-- delivery worker in this slice, and future delivery eligibility is exactly
-- `state = 'active'`.
--
-- Deleting a subscription moves it to `revoked` instead of removing the row, so
-- a repeated authenticated delete stays idempotent while the token binding can
-- still be verified. No IP address, provider identity, personal data or
-- credential is stored for a subscriber.

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  rulebook_id TEXT NOT NULL REFERENCES rulebooks (id) ON DELETE CASCADE,
  callback_url TEXT NOT NULL
    CHECK (length(callback_url) BETWEEN 1 AND 2048),
  management_token_hash TEXT NOT NULL UNIQUE
    CHECK (length(management_token_hash) = 64),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  -- Revocation is the only reason a row leaves an active delivery state, and a
  -- revoked row always carries the instant it was revoked.
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE INDEX subscriptions_rulebook_state_idx
  ON subscriptions (rulebook_id, state);

-- The registration identity and its callback target are insert-once. Only the
-- lifecycle columns may change, so a management token can never be re-pointed
-- at a different callback URL or rulebook.
CREATE TRIGGER subscriptions_identity_immutable
BEFORE UPDATE OF id, rulebook_id, callback_url, management_token_hash, created_at
ON subscriptions
BEGIN
  SELECT RAISE(ABORT, 'subscription registration identity is immutable');
END;

-- Revocation is final: a deleted subscription can never become delivery
-- eligible again.
CREATE TRIGGER subscriptions_revocation_is_final
BEFORE UPDATE OF state, revoked_at ON subscriptions
WHEN OLD.state = 'revoked'
  AND (NEW.state IS NOT 'revoked' OR NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN
  SELECT RAISE(ABORT, 'a revoked subscription is final');
END;
