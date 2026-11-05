-- AttestBook registry: immutable rulebook versions and content-addressed
-- artifacts (issue #29).
--
-- A rulebook version is a frozen snapshot of the rulebook it belongs to. The
-- exact snapshot bytes live in `artifacts`, keyed by their SHA-256 digest; a
-- version row only points at those bytes. Published and historical versions,
-- and every artifact, are immutable in the database itself, not only in the
-- service: the triggers below reject UPDATE/DELETE and identity re-insertion
-- even for a caller that bypasses the TypeScript layer. The only permitted
-- mutation of a published version is its transition to `historical` when a
-- newer version is published.
--
-- `INSERT OR REPLACE`/`UPDATE OR REPLACE` need explicit guards: SQLite resolves
-- REPLACE conflicts by deleting the replaced row *without* firing DELETE
-- triggers. A plain BEFORE INSERT/UPDATE identity check (below) rejects the
-- statement before conflict resolution can delete a published row or an
-- artifact.

CREATE TABLE artifacts (
  -- Lowercase hex SHA-256 over the exact `bytes` column (decision D-6).
  digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
  media_type TEXT NOT NULL CHECK (length(trim(media_type)) > 0),
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- An artifact is stored once. Without this guard, INSERT OR REPLACE would swap
-- the bytes behind an existing digest and leave them disagreeing with the key.
CREATE TRIGGER artifacts_insert_conflict
BEFORE INSERT ON artifacts
WHEN EXISTS (SELECT 1 FROM artifacts WHERE digest = NEW.digest)
BEGIN
  SELECT RAISE(ABORT, 'artifact digest already exists');
END;

CREATE TRIGGER artifacts_immutable_update
BEFORE UPDATE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifacts are immutable');
END;

CREATE TRIGGER artifacts_immutable_delete
BEFORE DELETE ON artifacts
BEGIN
  SELECT RAISE(ABORT, 'artifacts are immutable');
END;

CREATE TABLE rulebook_versions (
  id TEXT PRIMARY KEY,
  rulebook_id TEXT NOT NULL REFERENCES rulebooks (id) ON DELETE CASCADE,
  version TEXT NOT NULL CHECK (length(trim(version)) > 0),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'historical')),
  -- The version's digest is the artifact key, so a version can never point at
  -- bytes that disagree with its recorded digest.
  content_digest TEXT NOT NULL REFERENCES artifacts (digest) ON DELETE RESTRICT,
  -- The profile the snapshot was authored against (for example "ts11@1.0.1").
  spec_version TEXT NOT NULL CHECK (length(trim(spec_version)) > 0),
  -- Version provenance is registry-internal and never enters the snapshot bytes
  -- or a standards document.
  provenance_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(provenance_json) AND json_type(provenance_json) = 'object'),
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (rulebook_id, version),
  CHECK (
    (status = 'draft' AND published_at IS NULL)
    OR (status IN ('published', 'historical') AND published_at IS NOT NULL)
  )
);

CREATE INDEX rulebook_versions_rulebook_id_idx ON rulebook_versions (rulebook_id);
CREATE INDEX rulebook_versions_content_digest_idx ON rulebook_versions (content_digest);

-- Version identity is insert-once. `INSERT OR REPLACE` would otherwise delete a
-- published row (its DELETE trigger does not run) and insert a new one.
CREATE TRIGGER rulebook_versions_insert_identity
BEFORE INSERT ON rulebook_versions
WHEN EXISTS (
  SELECT 1 FROM rulebook_versions
  WHERE id = NEW.id
     OR (rulebook_id = NEW.rulebook_id AND version = NEW.version)
)
BEGIN
  SELECT RAISE(ABORT, 'rulebook version identity already exists');
END;

-- The same guard for `UPDATE OR REPLACE`: an update may not claim the id or
-- version label of a different row, because REPLACE would delete that row
-- without firing its DELETE trigger.
CREATE TRIGGER rulebook_versions_update_identity
BEFORE UPDATE ON rulebook_versions
WHEN EXISTS (SELECT 1 FROM rulebook_versions WHERE id = NEW.id AND id <> OLD.id)
  OR EXISTS (
    SELECT 1 FROM rulebook_versions
    WHERE id <> OLD.id
      AND rulebook_id = NEW.rulebook_id
      AND version = NEW.version
  )
BEGIN
  SELECT RAISE(ABORT, 'rulebook version identity already exists');
END;

-- Once a version has been published, only its transition to `historical` is
-- allowed. Every other update (content, provenance, identity, timestamps) is
-- rejected, including a downgrade back to `draft`.
CREATE TRIGGER rulebook_versions_published_update
BEFORE UPDATE ON rulebook_versions
WHEN OLD.status IN ('published', 'historical')
  AND NOT (
    OLD.status = 'published'
    AND NEW.status = 'historical'
    AND NEW.id = OLD.id
    AND NEW.rulebook_id = OLD.rulebook_id
    AND NEW.version = OLD.version
    AND NEW.content_digest = OLD.content_digest
    AND NEW.spec_version = OLD.spec_version
    AND NEW.provenance_json = OLD.provenance_json
    AND NEW.created_at = OLD.created_at
    AND NEW.published_at = OLD.published_at
  )
BEGIN
  SELECT RAISE(ABORT, 'published rulebook versions are immutable');
END;

CREATE TRIGGER rulebook_versions_published_delete
BEFORE DELETE ON rulebook_versions
WHEN OLD.status IN ('published', 'historical')
BEGIN
  SELECT RAISE(ABORT, 'published rulebook versions are immutable');
END;
