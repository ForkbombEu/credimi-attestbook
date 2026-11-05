-- AttestBook registry: providers, provider-owned rulebooks, attestation types,
-- schema references, write credentials and an audit trail.
--
-- Internal registry metadata lives in dedicated columns or JSON columns. No
-- column here is ever serialized into a standards-defined document; the
-- standards/shape boundary is documented in docs/registry.md.
--
-- Published-version tables, content-addressed artifacts and digests arrive in
-- issue #29; this migration intentionally covers only the #28 registry slice.

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  -- Opaque account binding used for publication authority. Never inferred from
  -- a remote URL (FR-003); provisioning is an operator action (D-10).
  -- Operator-assigned account binding; case-insensitively unique and
  -- immutable through the service so a provider cannot self-assert another
  -- account's authority.
  publication_authority TEXT NOT NULL COLLATE NOCASE UNIQUE
    CHECK (length(trim(publication_authority)) > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL
);

CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  -- Only the SHA-256 hash of a bearer token is stored. The raw token is
  -- returned once at issuance and never persisted.
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  label TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX auth_tokens_provider_id_idx ON auth_tokens (provider_id);

CREATE TABLE rulebooks (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers (id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  source_url TEXT
    CHECK (source_url IS NULL OR source_url GLOB 'https://*' OR source_url GLOB 'http://*'),
  -- Identifier of the profile the rulebook is authored against, e.g.
  -- "ts11@1.0.1". Kept as extensible text (D-4/D-5), not a closed enum.
  applicable_spec TEXT NOT NULL CHECK (length(trim(applicable_spec)) > 0),
  publication_status TEXT NOT NULL DEFAULT 'draft'
    CHECK (publication_status IN ('draft', 'published', 'historical')),
  provenance_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(provenance_json) AND json_type(provenance_json) = 'object'),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX rulebooks_provider_id_idx ON rulebooks (provider_id);

CREATE TABLE attestations (
  id TEXT PRIMARY KEY,
  rulebook_id TEXT NOT NULL REFERENCES rulebooks (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  -- TS11/ETSI enumerated values are stored as text so newer values survive
  -- (D-5); they are not closed TypeScript unions.
  attestation_los TEXT NOT NULL CHECK (length(trim(attestation_los)) > 0),
  binding_type TEXT NOT NULL CHECK (length(trim(binding_type)) > 0),
  supported_formats_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(supported_formats_json) AND json_type(supported_formats_json) = 'array'),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL,
  UNIQUE (rulebook_id, name),
  -- Parent key for the composite schema_refs foreign key, so a reference can
  -- never point at an attestation that belongs to a different rulebook.
  UNIQUE (id, rulebook_id)
);

CREATE INDEX attestations_rulebook_id_idx ON attestations (rulebook_id);

CREATE TABLE schema_refs (
  id TEXT PRIMARY KEY,
  rulebook_id TEXT NOT NULL REFERENCES rulebooks (id) ON DELETE CASCADE,
  attestation_id TEXT,
  format_identifier TEXT NOT NULL CHECK (length(trim(format_identifier)) > 0),
  uri TEXT NOT NULL
    CHECK (uri GLOB 'https://*' OR uri GLOB 'http://*'),
  integrity TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  created_at TEXT NOT NULL,
  FOREIGN KEY (attestation_id, rulebook_id)
    REFERENCES attestations (id, rulebook_id) ON DELETE CASCADE
);

-- A schema reference is unique in its own scope: one reference per format for
-- a rulebook-level reference, and one per format for each attestation type.
-- Two attestation types may therefore each reference a `dc+sd-jwt` schema.
CREATE UNIQUE INDEX schema_refs_rulebook_format_idx
  ON schema_refs (rulebook_id, format_identifier)
  WHERE attestation_id IS NULL;
CREATE UNIQUE INDEX schema_refs_attestation_format_idx
  ON schema_refs (rulebook_id, attestation_id, format_identifier)
  WHERE attestation_id IS NOT NULL;

CREATE INDEX schema_refs_rulebook_id_idx ON schema_refs (rulebook_id);
CREATE INDEX schema_refs_attestation_id_idx ON schema_refs (attestation_id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  -- NULL for operator/bootstrap actions that have no provider actor.
  actor_provider_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail_json TEXT
    CHECK (detail_json IS NULL OR (json_valid(detail_json) AND json_type(detail_json) = 'object'))
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_log_actor_provider_id_idx ON audit_log (actor_provider_id);
