-- Durable publication-delivery outbox (issue #120, FR-008, §13, §15, §17).
--
-- A publication appends one `rulebook.published` event (#116) inside its own
-- transaction. The outbox stores one durable delivery job per
-- `(event, subscription)` pair, created after that transaction commits (and by
-- a restart-safe reconciliation scan), so a temporary subscriber failure or an
-- AttestBook restart never loses a pending notification. Publishing never waits
-- for a callback: the outbox row is the only durable record, and an in-process
-- dispatcher leases it and performs the one-attempt signed delivery from #119.
--
-- The row is the permanent per-(event, subscription) record: the unique key
-- makes enqueue idempotent, and a delivered or failed row is never recreated.
-- Redelivery reads the immutable publication event, so the event id, the signed
-- payload fields and the subscription identity stay the same across attempts;
-- delivery is at-least-once and subscribers deduplicate by event id.
--
-- Attempts, lease ownership and the next-attempt instant are persisted, so an
-- expired lease left by a crashed process can be recovered without a duplicate
-- permanent record. Backoff shape, attempt/age caps and the queue bound live in
-- the dispatcher, not in SQL; SQL enforces identity, lifecycle and lease
-- coherence so a direct write cannot create an impossible job.
--
-- No callback URL, response body, client address, token or signing secret is
-- stored here: the row references the subscription and the published event.

CREATE TABLE webhook_delivery_outbox (
  -- Monotonic insertion position; also the stable order of a status page.
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  -- One durable job per publication event and subscription. The foreign keys
  -- keep a job pointed at an immutable event and a retained subscription row.
  event_id TEXT NOT NULL REFERENCES publication_events (id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'failed')),
  -- Number of claimed attempts. It is incremented atomically on claim, so a
  -- crash mid-attempt still spends one of the bounded attempts.
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0),
  -- Earliest instant the dispatcher may claim the job again.
  next_attempt_at TEXT NOT NULL CHECK (length(next_attempt_at) > 0),
  -- Start of the most recent claimed attempt, or NULL before the first one.
  last_attempt_at TEXT,
  -- Lease pair. Only a pending row may hold one, and both members are written
  -- or cleared together so a half-written lease cannot exist.
  lease_owner TEXT,
  lease_expires_at TEXT,
  -- Last sanitized failure category (a typed reason from the one-attempt
  -- deliverer). Never a response body, URL, address or token.
  last_error_category TEXT,
  -- Why a failed row is terminal: retry cap, age cap, a non-retryable answer
  -- or a subscription that is no longer eligible.
  terminal_reason TEXT
    CHECK (
      terminal_reason IS NULL
      OR terminal_reason IN (
        'max_attempts',
        'max_age',
        'non_retryable',
        'subscription_ineligible',
        'event_missing'
      )
    ),
  delivered_at TEXT,
  terminal_at TEXT,
  -- The outbox identity is insert-once and idempotent under replay.
  UNIQUE (event_id, subscription_id),
  -- A delivered row carries its success instant and only a failed row carries
  -- a terminal instant/reason; a pending row carries neither.
  CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((status = 'failed') = (terminal_at IS NOT NULL)),
  CHECK ((status = 'failed') = (terminal_reason IS NOT NULL)),
  CHECK (status = 'pending' OR (lease_owner IS NULL AND lease_expires_at IS NULL)),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

-- Claims read due pending rows; status pages read one subscription newest first.
CREATE INDEX webhook_delivery_outbox_due_idx
  ON webhook_delivery_outbox (status, next_attempt_at, lease_expires_at);

CREATE INDEX webhook_delivery_outbox_subscription_idx
  ON webhook_delivery_outbox (subscription_id, sequence DESC);

-- The event/subscription pair is immutable: a job cannot be re-pointed at
-- another event or subscriber, and a delivered or failed row stays terminal.
CREATE TRIGGER webhook_delivery_outbox_identity_immutable
BEFORE UPDATE OF event_id, subscription_id, created_at
ON webhook_delivery_outbox
BEGIN
  SELECT RAISE(ABORT, 'webhook delivery outbox identity is immutable');
END;

CREATE TRIGGER webhook_delivery_outbox_terminal_is_final
BEFORE UPDATE OF status
ON webhook_delivery_outbox
WHEN OLD.status IN ('delivered', 'failed') AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'a terminal webhook delivery is final');
END;

CREATE TRIGGER webhook_delivery_outbox_delivered_instant_is_final
BEFORE UPDATE OF delivered_at
ON webhook_delivery_outbox
WHEN OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS NOT OLD.delivered_at
BEGIN
  SELECT RAISE(ABORT, 'a delivered webhook delivery is final');
END;

-- Restart-safe reconciliation cursor. The dispatcher scans publication events
-- after this feed position and inserts the missing outbox rows in the same
-- transaction that advances the cursor, so a crash never skips an event and a
-- replay never duplicates a job. It starts at the newest event that existed
-- when this migration was applied: existing history is not backfilled with
-- notifications a subscriber never expected, while an event published after
-- the upgrade and before its enqueue is still recovered.
CREATE TABLE webhook_delivery_outbox_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_event_sequence >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO webhook_delivery_outbox_state (id, last_event_sequence, updated_at)
SELECT 1, COALESCE(MAX(sequence), 0), '1970-01-01T00:00:00.000Z'
FROM publication_events;

CREATE TRIGGER webhook_delivery_outbox_state_singleton
BEFORE INSERT ON webhook_delivery_outbox_state
WHEN EXISTS (SELECT 1 FROM webhook_delivery_outbox_state)
BEGIN
  SELECT RAISE(ABORT, 'webhook delivery outbox state is a singleton');
END;

CREATE TRIGGER webhook_delivery_outbox_state_is_monotonic
BEFORE UPDATE OF last_event_sequence
ON webhook_delivery_outbox_state
WHEN NEW.last_event_sequence < OLD.last_event_sequence
BEGIN
  SELECT RAISE(ABORT, 'webhook delivery outbox cursor must not move backwards');
END;
