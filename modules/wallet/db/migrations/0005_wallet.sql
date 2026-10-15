CREATE ROLE wallet_owner NOLOGIN;
CREATE ROLE wallet_service NOLOGIN;
CREATE SCHEMA wallet AUTHORIZATION wallet_owner;
SET LOCAL ROLE wallet_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE wallet.challenges (
  payload text PRIMARY KEY CHECK (payload ~ '^[0-9a-f]{64}$'),
  subject_id uuid NOT NULL,
  domain text NOT NULL CHECK (length(domain) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX challenges_subject_live ON wallet.challenges(subject_id, expires_at)
  WHERE consumed_at IS NULL;
ALTER TABLE wallet.challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet.challenges FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON wallet.challenges TO wallet_owner USING (true) WITH CHECK (true);
CREATE POLICY own_access ON wallet.challenges TO wallet_service
  USING (subject_id = nullif(current_setting('rada.subject_id', true), '')::uuid)
  WITH CHECK (subject_id = nullif(current_setting('rada.subject_id', true), '')::uuid);
REVOKE ALL ON ALL TABLES IN SCHEMA wallet FROM PUBLIC;
GRANT USAGE ON SCHEMA wallet TO wallet_service;
GRANT SELECT, INSERT, UPDATE ON wallet.challenges TO wallet_service;
RESET ROLE;
