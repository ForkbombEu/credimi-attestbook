-- AttestBook registry: durable, append-only publication events (issue #116).
--
-- The publication-event feed is a product API for independent issuers and
-- verifiers: it names the exact immutable version that was published without
-- exposing the rulebook working copy, provider identity or audit metadata.
-- An event is written inside the same transaction as the version publication,
-- so a failed publication leaves neither the status change nor an event behind.
--
-- Every event pins one already-published version: the rulebook, version label,
-- content digest and publication timestamp all come from the frozen version
-- row. The triggers below make the feed append-only and reject an event whose
-- pinned values disagree with that row, so direct SQL cannot create a feed
-- entry a publication did not produce.

CREATE TABLE publication_events (
  -- Monotonic feed position. It is the cursor pagination key, separate from the
  -- stable public event id, and never reused because events are append-only.
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Stable opaque event id returned to clients.
  id TEXT NOT NULL UNIQUE CHECK (length(trim(id)) > 0),
  -- Versioned product shape of this event, so a later shape can coexist.
  format TEXT NOT NULL CHECK (format = 'attestbook.rulebook-publication-event@1'),
  event_type TEXT NOT NULL CHECK (event_type = 'rulebook.published'),
  -- Deleting a rulebook cascades to its rows, but the event DELETE trigger
  -- aborts that statement: an emitted feed entry is never removed. Keeping the
  -- cascade (rather than RESTRICT) makes the published-version immutability
  -- trigger, not a generic foreign-key failure, reject the parent delete.
  rulebook_id TEXT NOT NULL REFERENCES rulebooks (id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES rulebook_versions (id) ON DELETE RESTRICT,
  -- Exact frozen version label, never the rulebook's working copy.
  version TEXT NOT NULL CHECK (length(trim(version)) > 0),
  -- Lowercase hex SHA-256 of the immutable snapshot bytes.
  content_digest TEXT NOT NULL REFERENCES artifacts (digest) ON DELETE RESTRICT
    CHECK (length(content_digest) = 64),
  -- The frozen version's publication timestamp.
  published_at TEXT NOT NULL,
  -- Exactly one event per published version; idempotent re-publication cannot
  -- append a second entry.
  UNIQUE (rulebook_id, version)
);

-- The feed reads one rulebook's events in ascending feed order.
CREATE INDEX publication_events_rulebook_sequence_idx
  ON publication_events (rulebook_id, sequence);

-- An event must name a version that is already published or historical and
-- whose frozen label, digest and timestamp it copies exactly. At insert time
-- the publication transaction has already moved the version out of `draft`.
CREATE TRIGGER publication_events_reference_published_version
BEFORE INSERT ON publication_events
WHEN NOT EXISTS (
  SELECT 1
  FROM rulebook_versions AS version
  WHERE version.id = NEW.version_id
    AND version.rulebook_id = NEW.rulebook_id
    AND version.version = NEW.version
    AND version.content_digest = NEW.content_digest
    AND version.published_at = NEW.published_at
    AND version.status IN ('published', 'historical')
)
BEGIN
  SELECT RAISE(ABORT, 'publication event must reference a published version');
END;

-- Event identity is insert-once. `INSERT OR REPLACE` resolves a conflict by
-- deleting the existing row without firing DELETE triggers, so the identity
-- conflict is rejected before resolution can remove an emitted event.
CREATE TRIGGER publication_events_insert_identity
BEFORE INSERT ON publication_events
WHEN EXISTS (
  SELECT 1 FROM publication_events
  WHERE id = NEW.id
     OR (rulebook_id = NEW.rulebook_id AND version = NEW.version)
)
BEGIN
  SELECT RAISE(ABORT, 'publication event identity already exists');
END;

CREATE TRIGGER publication_events_immutable_update
BEFORE UPDATE ON publication_events
BEGIN
  SELECT RAISE(ABORT, 'publication events are immutable');
END;

CREATE TRIGGER publication_events_immutable_delete
BEFORE DELETE ON publication_events
BEGIN
  SELECT RAISE(ABORT, 'publication events are immutable');
END;
