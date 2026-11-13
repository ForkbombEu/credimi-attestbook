-- Immutable, provider-owned credential schema documents (issue #97).
--
-- Exact document bytes live in the existing content-addressed `artifacts`
-- table, keyed by their SHA-256 digest. This table adds only a provider-owned
-- document association and its creation provenance, so identical content is
-- stored once while each provider keeps its own immutable association and
-- provenance. It is deliberately not a second blob store and not a rulebook
-- version or schema reference: existing `{formatIdentifier, uri, integrity}`
-- references, externally hosted schemas and historical snapshots are
-- untouched (FR-001, FR-002, FR-003, §15).
--
-- `kind` selects one of the two supported profiles and fixes its canonical
-- media type, so a digest can never be served with a media type that disagrees
-- with the document profile. A BEFORE INSERT trigger checks that the referenced
-- artifact was stored with that same media type. The artifact table already
-- rejects UPDATE/DELETE and re-insertion of an existing digest, so the exact
-- bytes behind a document association can never change.
--
-- An association is insert-once: there is no UPDATE path, and DELETE is
-- rejected outright. Provider deletion is restricted while a provider owns a
-- document, matching the rulebook ownership rule in the service.

CREATE TABLE credential_schema_documents (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers (id) ON DELETE RESTRICT,
  content_digest TEXT NOT NULL REFERENCES artifacts (digest) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('json_schema_2020_12', 'sd_jwt_vc_type_metadata')),
  media_type TEXT NOT NULL CHECK (
    (kind = 'json_schema_2020_12' AND media_type = 'application/schema+json')
    OR (kind = 'sd_jwt_vc_type_metadata' AND media_type = 'application/json')
  ),
  provenance_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(provenance_json) AND json_type(provenance_json) = 'object'),
  created_at TEXT NOT NULL,
  -- One provider-owned association per exact content. Different providers may
  -- each associate the same digest; one provider cannot register the same bytes
  -- twice under a different profile.
  UNIQUE (provider_id, content_digest)
);

CREATE INDEX credential_schema_documents_provider_id_idx
  ON credential_schema_documents (provider_id);
CREATE INDEX credential_schema_documents_content_digest_idx
  ON credential_schema_documents (content_digest);

CREATE TRIGGER credential_schema_documents_artifact_media_type
BEFORE INSERT ON credential_schema_documents
WHEN (SELECT media_type FROM artifacts WHERE digest = NEW.content_digest)
  IS NOT NEW.media_type
BEGIN
  SELECT RAISE(ABORT, 'schema document media type does not match its artifact');
END;

-- Identity is insert-once. SQLite resolves REPLACE conflicts by deleting the
-- replaced row without firing DELETE triggers, so `INSERT OR REPLACE` must be
-- rejected before conflict resolution can delete an existing association.
CREATE TRIGGER credential_schema_documents_insert_identity
BEFORE INSERT ON credential_schema_documents
WHEN EXISTS (SELECT 1 FROM credential_schema_documents WHERE id = NEW.id)
  OR EXISTS (
    SELECT 1 FROM credential_schema_documents
    WHERE provider_id = NEW.provider_id AND content_digest = NEW.content_digest
  )
BEGIN
  SELECT RAISE(ABORT, 'credential schema document identity already exists');
END;

CREATE TRIGGER credential_schema_documents_immutable_update
BEFORE UPDATE ON credential_schema_documents
BEGIN
  SELECT RAISE(ABORT, 'credential schema documents are immutable');
END;

CREATE TRIGGER credential_schema_documents_immutable_delete
BEFORE DELETE ON credential_schema_documents
BEGIN
  SELECT RAISE(ABORT, 'credential schema documents are immutable');
END;
