BEGIN;
CREATE FUNCTION pg_temp.assert_true(value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed'; END IF;
END $$;
SELECT pg_temp.assert_true(current_setting('server_version_num')::integer / 10000 = 17);
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(100001) AS first_subject \gset
SELECT identity.resolve_telegram(100002) AS second_subject \gset
SELECT pg_temp.assert_true(identity.resolve_telegram(100001) = :'first_subject'::uuid);
DO $$ BEGIN
  PERFORM identity.resolve_telegram(0);
  RAISE EXCEPTION 'Accepted invalid Telegram ID';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN
  PERFORM * FROM identity.telegram_accounts;
  RAISE EXCEPTION 'Auth role could read identities';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
DO $$ BEGIN
  INSERT INTO identity.telegram_accounts VALUES (gen_random_uuid(), 100001, now());
  RAISE EXCEPTION 'Duplicate Telegram identity accepted';
EXCEPTION WHEN unique_violation THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO identity.telegram_accounts VALUES (gen_random_uuid(), -1, now());
  RAISE EXCEPTION 'Negative Telegram identity accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
SET LOCAL ROLE identity_service;
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM identity.subjects));
SELECT set_config('rada.subject_id', :'first_subject', true);
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM identity.subjects));
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM identity.telegram_accounts WHERE telegram_user_id = 100002));
SELECT pg_temp.assert_true(NOT pg_has_role(current_user, 'identity_owner', 'MEMBER'));
SELECT pg_temp.assert_true(NOT pg_has_role(current_user, 'identity_auth', 'MEMBER'));
INSERT INTO identity.consents(subject_id, app_id, capability)
  VALUES (:'first_subject', 'fixture.app', 'telegram.username.read');
UPDATE identity.consents SET revoked_at = now() WHERE subject_id = :'first_subject';
SELECT pg_temp.assert_true((SELECT revoked_at IS NOT NULL FROM identity.consents));
SELECT set_config('test.other_subject', :'second_subject', true);
DO $$ BEGIN
  INSERT INTO identity.consents(subject_id, app_id, capability)
    VALUES (current_setting('test.other_subject')::uuid, 'fixture.app', 'telegram.username.read');
  RAISE EXCEPTION 'Wrote another subject consent';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  UPDATE identity.subjects SET selected_frog_id = gen_random_uuid();
  RAISE EXCEPTION 'Unverified frog selection allowed';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  UPDATE identity.telegram_accounts SET telegram_user_id = 100003;
  RAISE EXCEPTION 'Telegram relink allowed';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO identity.role_grants(subject_id, role_name) VALUES (identity.current_subject(), 'admin');
  RAISE EXCEPTION 'Self role grant allowed';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM identity.resolve_telegram(100003);
  RAISE EXCEPTION 'Service could impersonate authentication';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
SELECT set_config('rada.subject_id', :'second_subject', true);
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM identity.consents));
UPDATE identity.consents SET revoked_at = NULL;
RESET ROLE;
SELECT pg_temp.assert_true((SELECT revoked_at IS NOT NULL FROM identity.consents));
SET LOCAL ROLE identity_operator;
INSERT INTO identity.role_grants(subject_id, role_name) VALUES (:'first_subject', 'fixture.reviewer');
RESET ROLE;
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id', :'first_subject', true);
SELECT pg_temp.assert_true((SELECT role_name = 'fixture.reviewer' FROM identity.role_grants));
RESET ROLE;
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM platform_migrations.applied));
ROLLBACK;
