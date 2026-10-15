CREATE ROLE identity_owner NOLOGIN;
CREATE ROLE identity_auth NOLOGIN;
CREATE ROLE identity_service NOLOGIN;
CREATE ROLE identity_operator NOLOGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA identity AUTHORIZATION identity_owner;
SET LOCAL ROLE identity_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE identity.subjects (
  subject_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  selected_frog_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity.telegram_accounts (
  subject_id uuid PRIMARY KEY REFERENCES identity.subjects(subject_id),
  telegram_user_id bigint NOT NULL UNIQUE CHECK (telegram_user_id > 0),
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity.role_grants (
  subject_id uuid NOT NULL REFERENCES identity.subjects(subject_id),
  role_name text NOT NULL CHECK (role_name ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, role_name)
);
CREATE TABLE identity.consents (
  subject_id uuid NOT NULL REFERENCES identity.subjects(subject_id),
  app_id text NOT NULL CHECK (app_id ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
  capability text NOT NULL CHECK (capability IN (
    'telegram.username.read', 'wallet.address.read', 'wallet.balances.read',
    'jpegpe.collection.read', 'notifications.send'
  )),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz CHECK (revoked_at >= granted_at),
  PRIMARY KEY (subject_id, app_id, capability)
);

CREATE FUNCTION identity.current_subject() RETURNS uuid
LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT nullif(current_setting('rada.subject_id', true), '')::uuid $$;

-- Restricted to the authentication service after server-side Telegram verification.
CREATE FUNCTION identity.resolve_telegram(verified_telegram_user_id bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result uuid;
BEGIN
  IF verified_telegram_user_id IS NULL OR verified_telegram_user_id <= 0 THEN
    RAISE EXCEPTION 'Invalid verified Telegram identity' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(verified_telegram_user_id);
  SELECT subject_id INTO result FROM identity.telegram_accounts
    WHERE telegram_user_id = verified_telegram_user_id;
  IF result IS NULL THEN
    INSERT INTO identity.subjects DEFAULT VALUES RETURNING subject_id INTO result;
    INSERT INTO identity.telegram_accounts(subject_id, telegram_user_id)
      VALUES (result, verified_telegram_user_id);
  END IF;
  RETURN result;
END $$;

ALTER TABLE identity.subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.subjects FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.telegram_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.telegram_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.role_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.role_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.consents FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON identity.subjects TO identity_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON identity.telegram_accounts TO identity_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON identity.role_grants TO identity_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON identity.consents TO identity_owner USING (true) WITH CHECK (true);
CREATE POLICY own_subject ON identity.subjects FOR SELECT TO identity_service
  USING (subject_id = (SELECT identity.current_subject()));
CREATE POLICY own_telegram ON identity.telegram_accounts FOR SELECT TO identity_service
  USING (subject_id = (SELECT identity.current_subject()));
CREATE POLICY own_roles ON identity.role_grants FOR SELECT TO identity_service
  USING (subject_id = (SELECT identity.current_subject()));
CREATE POLICY own_consent ON identity.consents TO identity_service
  USING (subject_id = (SELECT identity.current_subject()))
  WITH CHECK (subject_id = (SELECT identity.current_subject()));
CREATE POLICY operator_roles ON identity.role_grants TO identity_operator
  USING (true) WITH CHECK (true);
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA identity FROM PUBLIC;
GRANT USAGE ON SCHEMA identity TO identity_auth, identity_service, identity_operator;
GRANT EXECUTE ON FUNCTION identity.resolve_telegram(bigint) TO identity_auth;
GRANT EXECUTE ON FUNCTION identity.current_subject() TO identity_service;
GRANT SELECT ON identity.subjects, identity.telegram_accounts, identity.role_grants, identity.consents TO identity_service;
GRANT INSERT, UPDATE ON identity.consents TO identity_service;
GRANT SELECT, INSERT, DELETE ON identity.role_grants TO identity_operator;
RESET ROLE;
