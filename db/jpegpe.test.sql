BEGIN;
CREATE FUNCTION pg_temp.assert_true(value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed'; END IF;
END $$;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(200001) AS first_subject \gset
SELECT identity.resolve_telegram(200002) AS second_subject \gset
RESET ROLE;
SELECT gen_random_uuid() AS first_frog \gset
SELECT gen_random_uuid() AS second_frog \gset
SELECT set_config('test.first_subject', :'first_subject', true);
SET LOCAL ROLE jpegpe_operator;
SELECT jpegpe.create_frog(:'first_frog', 'Blue_Frog', :'first_subject', '#102030', '#AABBCC');
SELECT jpegpe.create_frog(:'second_frog', 'Other_Frog', :'second_subject');
DO $$ BEGIN
  PERFORM jpegpe.create_frog(gen_random_uuid(), 'blue_frog',
    current_setting('test.first_subject')::uuid);
  RAISE EXCEPTION 'Case variant username accepted';
EXCEPTION WHEN unique_violation THEN NULL; END $$;
RESET ROLE;
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id', :'first_subject', true);
SELECT pg_temp.assert_true(identity.select_frog(:'first_frog'));
SELECT pg_temp.assert_true(NOT identity.select_frog(:'second_frog'));
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM jpegpe.own_public_frog(:'first_frog')));
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM jpegpe.own_public_frog(:'second_frog')));
DO $$ BEGIN
  PERFORM * FROM jpegpe.frogs;
  RAISE EXCEPTION 'Service could read module table';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  UPDATE identity.subjects SET selected_frog_id = gen_random_uuid();
  RAISE EXCEPTION 'Service could write selection directly';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
SET LOCAL ROLE jpegpe_operator;
DO $$ BEGIN
  UPDATE jpegpe.ownership_events SET to_subject_id = gen_random_uuid();
  RAISE EXCEPTION 'Operator could rewrite history';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
SELECT jpegpe.transfer_frog(:'first_frog', :'first_subject', :'second_subject');
RESET ROLE;
SELECT pg_temp.assert_true((SELECT selected_frog_id IS NULL FROM identity.subjects
  WHERE subject_id = :'first_subject'));
SELECT pg_temp.assert_true((SELECT count(*) = 2 FROM jpegpe.ownership_events
  WHERE frog_id = :'first_frog'));
SELECT pg_temp.assert_true((SELECT current_owner_subject_id = :'second_subject'
  FROM jpegpe.frogs WHERE frog_id = :'first_frog'));
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id', :'first_subject', true);
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM jpegpe.own_public_frog(:'first_frog')));
SELECT pg_temp.assert_true(NOT identity.select_frog(:'first_frog'));
SELECT set_config('rada.subject_id', :'second_subject', true);
SELECT pg_temp.assert_true(identity.select_frog(:'first_frog'));
RESET ROLE;
SELECT pg_temp.assert_true((SELECT selected_frog_id = :'first_frog' FROM identity.subjects
  WHERE subject_id = :'second_subject'));
DO $$ BEGIN
  UPDATE jpegpe.frogs SET creator_subject_id = current_owner_subject_id;
  RAISE EXCEPTION 'Frog creator changed';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  UPDATE jpegpe.ownership_events SET occurred_at = now();
  RAISE EXCEPTION 'Ownership event changed';
EXCEPTION WHEN check_violation THEN NULL; END $$;
ROLLBACK;
