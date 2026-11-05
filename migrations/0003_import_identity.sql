-- AttestBook registry: stable import identity for safe re-import (issue #31).
--
-- `import_key` is a server-computed, deterministic identity for one external
-- catalog entry: the SHA-256 over the source identity and the entry's own
-- identity. It is import-internal product metadata and never enters a standards
-- document or a version snapshot. A rulebook imported from an external source
-- keeps its key for its lifetime, so re-importing the same entry finds the
-- existing rulebook instead of creating a duplicate, and changed content is
-- reported as a conflict rather than silently overwriting local or published
-- content (FR-004, FR-005).
--
-- The unique partial index makes duplicate detection race-safe at the database
-- boundary, not only in the service. NULL is allowed and excluded from the
-- index so locally authored rulebooks, which have no external identity, are
-- unaffected.

ALTER TABLE rulebooks ADD COLUMN import_key TEXT
  CHECK (import_key IS NULL OR length(import_key) = 64);

CREATE UNIQUE INDEX rulebooks_provider_import_key_idx
  ON rulebooks (provider_id, import_key)
  WHERE import_key IS NOT NULL;
