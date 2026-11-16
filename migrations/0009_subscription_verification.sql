-- Callback verification and activation for anonymous webhook subscriptions
-- (issue #118, FR-003/FR-008, §15).
--
-- Registration stores an inert `pending` subscription; this migration adds only
-- the bookkeeping needed to prove control of the callback endpoint before the
-- record can become `active`. A verification challenge is generated per
-- initiation, sent to the callback URL and stored here only as its SHA-256
-- hash, so a database leak cannot replay it. The plaintext challenge exists
-- only in the outbound request.
--
-- `verification_attempts` and `verification_window_started_at` bound how many
-- callback requests one subscription can trigger in a window even across a
-- restart. `verified_at` records the successful handshake; SQLite triggers keep
-- the activation transition honest: a row is `active` exactly when it has been
-- verified, and an activated row can only become `revoked`.
--
-- Nothing is delivered by this slice. `active` is the future delivery
-- eligibility state; no event exists yet.

ALTER TABLE subscriptions
  ADD COLUMN verification_challenge_hash TEXT
    CHECK (
      verification_challenge_hash IS NULL
      OR length(verification_challenge_hash) = 64
    );

ALTER TABLE subscriptions
  ADD COLUMN verification_challenge_expires_at TEXT;

ALTER TABLE subscriptions
  ADD COLUMN verification_window_started_at TEXT;

ALTER TABLE subscriptions
  ADD COLUMN verification_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (verification_attempts >= 0);

ALTER TABLE subscriptions
  ADD COLUMN verified_at TEXT;

-- The challenge hash and its expiry are written and cleared together; a
-- half-written pair cannot represent a usable challenge.
CREATE TRIGGER subscriptions_verification_challenge_pair
BEFORE UPDATE OF verification_challenge_hash, verification_challenge_expires_at
ON subscriptions
WHEN (NEW.verification_challenge_hash IS NULL) != (NEW.verification_challenge_expires_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a verification challenge requires both a hash and an expiry');
END;

-- `active` means the callback answered the challenge: a pending row cannot
-- carry a verification instant, and an active row cannot lack one. The INSERT
-- triggers keep a direct SQL insert from bypassing the service transition.
CREATE TRIGGER subscriptions_activation_requires_verification
BEFORE UPDATE OF state, verified_at ON subscriptions
WHEN (NEW.state = 'active' AND NEW.verified_at IS NULL)
  OR (NEW.state = 'pending' AND NEW.verified_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'subscription activation requires a verified callback');
END;

CREATE TRIGGER subscriptions_activation_requires_verification_insert
BEFORE INSERT ON subscriptions
WHEN NEW.state = 'active' AND NEW.verified_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'subscription activation requires a verified callback');
END;

CREATE TRIGGER subscriptions_verification_challenge_pair_insert
BEFORE INSERT ON subscriptions
WHEN (NEW.verification_challenge_hash IS NULL) != (NEW.verification_challenge_expires_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'a verification challenge requires both a hash and an expiry');
END;

-- Activation is final apart from revocation, so a verified subscription can
-- never quietly fall back to an unverified delivery-ineligible state.
CREATE TRIGGER subscriptions_activation_is_final
BEFORE UPDATE OF state ON subscriptions
WHEN OLD.state = 'active' AND NEW.state NOT IN ('active', 'revoked')
BEGIN
  SELECT RAISE(ABORT, 'a verified subscription can only be revoked');
END;
