CREATE ROLE legacy_import NOLOGIN;
SET LOCAL ROLE ops_owner;
-- Private operational linkage, never exposed by telemetry or public APIs.
CREATE TABLE ops.import_mappings (
  source_system text NOT NULL,
  source_table text NOT NULL,
  source_pk text NOT NULL,
  target_id uuid NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (source_system, source_table, source_pk),
  UNIQUE (source_system, source_table, target_id)
);
CREATE TABLE ops.import_checkpoints (
  source_system text NOT NULL,
  batch_key text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, batch_key)
);
ALTER TABLE ops.import_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.import_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE ops.import_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.import_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY importer ON ops.import_mappings TO legacy_import USING (true) WITH CHECK (true);
CREATE POLICY importer ON ops.import_checkpoints TO legacy_import USING (true) WITH CHECK (true);
REVOKE ALL ON ops.import_mappings, ops.import_checkpoints FROM PUBLIC;
GRANT USAGE ON SCHEMA ops TO legacy_import;
GRANT SELECT, INSERT ON ops.import_mappings, ops.import_checkpoints TO legacy_import;
RESET ROLE;
