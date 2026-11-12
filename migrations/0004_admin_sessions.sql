-- Browser administrator sessions for the environment-configured single
-- administrator (issue #88).
--
-- Only the SHA-256 hash of the opaque session identifier is stored; the raw
-- identifier lives only in the browser's HttpOnly cookie and is never logged or
-- returned in a response body. `auth_fingerprint` binds the row to the exact
-- administrator configuration (username, provider and password hash) that
-- created it, so rotating any configured value invalidates outstanding
-- sessions. `expires_at` is an absolute bound; logout sets `revoked_at` and
-- keeps the row until it expires.
--
-- Sessions belong to an existing provider and are deleted with it. The
-- administrator login never creates a provider and never writes `auth_tokens`.

CREATE TABLE admin_sessions (
  session_hash TEXT PRIMARY KEY CHECK (length(session_hash) = 64),
  provider_id TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  auth_fingerprint TEXT NOT NULL CHECK (length(auth_fingerprint) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX admin_sessions_provider_id_idx ON admin_sessions (provider_id);

CREATE INDEX admin_sessions_expires_at_idx ON admin_sessions (expires_at);
