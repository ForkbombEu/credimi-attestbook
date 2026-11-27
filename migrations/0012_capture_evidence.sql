-- Durable capture evidence and rulebook correlations (issue #156, FR-015,
-- FR-019, specification §11 and §15).
--
-- The capture explorer used to keep every normalized envelope, inline artifact
-- and recorded correlation in process memory, so a captured credential
-- validation binding disappeared on restart. These tables make the evidence
-- durable while preserving the two safety invariants the in-memory model
-- already had:
--
--   1. Metadata and raw evidence stay segregated. `capture_evidence` holds the
--      metadata-only JSON envelope and its source description;
--      `capture_evidence_artifacts` holds the decoded inline artifact bytes.
--      A metadata query (list/get without the artifact) never reads the blob.
--   2. Raw evidence is never served, indexed or logged. The API still returns
--      only the default-policy redacted projection computed from the artifact
--      at read time.
--
-- The idempotency key is the SHA-256 of the exact submission bytes the adapter
-- accepted (`docs/capture.md` §7), stored as `submission_digest`. Inserting the
-- same `captureId` with byte-identical bytes is a duplicate; different bytes
-- are a conflict. The service, not SQL, enforces the record bound; SQL enforces
-- identity and lifecycle so a direct write cannot create an impossible row.
--
-- Evidence rows are insert-once: there is no update path, and the trigger below
-- also closes the `INSERT OR REPLACE` hole (SQLite resolves REPLACE conflicts
-- by deleting the replaced row without firing DELETE triggers, which would drop
-- the correlated validation). Correlations are the only mutable rows and are an
-- upsert keyed by `captureId`.

CREATE TABLE capture_evidence (
  -- Stable, opaque capture identifier from the envelope (FR-019).
  capture_id TEXT PRIMARY KEY CHECK (length(trim(capture_id)) > 0),
  -- Metadata-only normalized envelope. It never contains the inline artifact.
  envelope_json TEXT NOT NULL
    CHECK (json_valid(envelope_json) AND json_type(envelope_json) = 'object'),
  -- Configured source the evidence was retrieved from.
  source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
  source_component TEXT NOT NULL
    CHECK (source_component IN ('capture-issuer', 'capture-verifier')),
  source_transport TEXT NOT NULL CHECK (source_transport IN ('mock')),
  source_description TEXT NOT NULL CHECK (length(trim(source_description)) > 0),
  -- AttestBook receipt timestamp, also carried inside the envelope.
  received_at TEXT NOT NULL CHECK (length(trim(received_at)) > 0),
  -- Source-asserted capture time in Unix milliseconds; ordering only.
  captured_at_ms INTEGER NOT NULL CHECK (captured_at_ms >= 0),
  -- SHA-256 over the exact accepted submission bytes (idempotency key).
  submission_digest TEXT NOT NULL CHECK (length(submission_digest) = 64)
);

-- Newest first by capture time, then the capture identifier as the stable
-- tie-breaker. This is the exact order the API exposes.
CREATE INDEX capture_evidence_order_idx
  ON capture_evidence (captured_at_ms DESC, capture_id ASC);

-- The segregated inline artifact. It lives in its own table so every metadata
-- query above can join artifact metadata without reading `bytes`.
CREATE TABLE capture_evidence_artifacts (
  capture_id TEXT PRIMARY KEY REFERENCES capture_evidence (capture_id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK (length(trim(media_type)) > 0),
  encoding TEXT NOT NULL CHECK (encoding IN ('utf8', 'base64')),
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  -- Lowercase hex SHA-256 of the decoded bytes, as recorded in the envelope.
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  bytes BLOB NOT NULL
);

-- One pinned-rulebook correlation per capture. `binding_json` is the exact
-- `CaptureRulebookBinding` returned by the validate route; `validation_json` is
-- the structural validation result it was recorded with. A later correlation
-- replaces both together, so the binding and its findings can never disagree.
CREATE TABLE capture_correlations (
  capture_id TEXT PRIMARY KEY REFERENCES capture_evidence (capture_id) ON DELETE CASCADE,
  binding_json TEXT NOT NULL
    CHECK (json_valid(binding_json) AND json_type(binding_json) = 'object'),
  validation_json TEXT NOT NULL
    CHECK (json_valid(validation_json) AND json_type(validation_json) = 'object'),
  updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
);

-- Evidence identity and normalized metadata are insert-once. This also rejects
-- `INSERT OR REPLACE`, which would otherwise delete the existing row (and its
-- correlation) without firing a DELETE trigger.
CREATE TRIGGER capture_evidence_insert_conflict
BEFORE INSERT ON capture_evidence
WHEN EXISTS (SELECT 1 FROM capture_evidence WHERE capture_id = NEW.capture_id)
BEGIN
  SELECT RAISE(ABORT, 'capture evidence already exists');
END;

CREATE TRIGGER capture_evidence_immutable
BEFORE UPDATE ON capture_evidence
BEGIN
  SELECT RAISE(ABORT, 'capture evidence is immutable');
END;

-- The artifact belongs to its evidence row and is insert-once.
CREATE TRIGGER capture_evidence_artifacts_insert_conflict
BEFORE INSERT ON capture_evidence_artifacts
WHEN EXISTS (
  SELECT 1 FROM capture_evidence_artifacts WHERE capture_id = NEW.capture_id
)
BEGIN
  SELECT RAISE(ABORT, 'capture evidence artifact already exists');
END;

CREATE TRIGGER capture_evidence_artifacts_immutable
BEFORE UPDATE ON capture_evidence_artifacts
BEGIN
  SELECT RAISE(ABORT, 'capture evidence artifacts are immutable');
END;

-- A correlation always points at the evidence it was recorded for; the foreign
-- key enforces this and the trigger prevents re-pointing it at another capture.
CREATE TRIGGER capture_correlations_identity_immutable
BEFORE UPDATE OF capture_id ON capture_correlations
WHEN NEW.capture_id IS NOT OLD.capture_id
BEGIN
  SELECT RAISE(ABORT, 'a capture correlation cannot be re-pointed');
END;
