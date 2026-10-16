BEGIN;
CREATE FUNCTION pg_temp.check(value boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Holds assertion failed: %', label; END IF; END $$;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(630001) AS creator \gset
SELECT identity.resolve_telegram(630002) AS owner \gset
RESET ROLE;
SELECT gen_random_uuid() AS frog_a, gen_random_uuid() AS frog_b, gen_random_uuid() AS frog_c \gset

-- Hold: one active name per frog id, one frog id per name, ignoring case.
SELECT pg_temp.check(jpegpe.hold_username('Holder', :'frog_a'), 'hold');
SELECT pg_temp.check(jpegpe.username_status('HOLDER') = 'taken', 'held name taken');
SELECT pg_temp.check(jpegpe.held_username(:'frog_a') = 'Holder', 'held name');
SELECT pg_temp.check(NOT jpegpe.hold_username('holder', :'frog_b'), 'name held elsewhere');
SELECT pg_temp.check(NOT jpegpe.hold_username('Second', :'frog_a'), 'frog holds one name');
SELECT pg_temp.check(NOT jpegpe.hold_username('bad name', :'frog_b'), 'invalid name');
DO $$ BEGIN
  PERFORM jpegpe.create_frog(gen_random_uuid(), 'HOLDER', (SELECT subject_id FROM identity.subjects LIMIT 1));
  RAISE EXCEPTION 'Held name created directly';
EXCEPTION WHEN unique_violation THEN NULL; END $$;

-- Release: the name is available again, once.
SELECT pg_temp.check(jpegpe.release_username(:'frog_a'), 'release');
SELECT pg_temp.check(NOT jpegpe.release_username(:'frog_a'), 'release once');
SELECT pg_temp.check(jpegpe.username_status('Holder') = 'available', 'released name free');
SELECT pg_temp.check(jpegpe.held_username(:'frog_a') IS NULL, 'no hold after release');
SELECT pg_temp.check(jpegpe.hold_username('Holder', :'frog_b'), 'released name held again');

-- Confirm: issuing the frog makes the held name permanent, with two ownership events.
DO $$ BEGIN
  PERFORM jpegpe.issue_frog(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), NULL, NULL, NULL, NULL);
  RAISE EXCEPTION 'Issued without a hold';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
SELECT set_config('rada.fixture_frog_b', :'frog_b', true);
SELECT set_config('rada.fixture_creator', :'creator', true);
DO $$ BEGIN
  PERFORM jpegpe.issue_frog(current_setting('rada.fixture_frog_b')::uuid,
    current_setting('rada.fixture_creator')::uuid, current_setting('rada.fixture_creator')::uuid,
    NULL, NULL, NULL, NULL);
  RAISE EXCEPTION 'Issued to its creator';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
SELECT pg_temp.check(jpegpe.issue_frog(:'frog_b', :'creator', :'owner', '#ABCDEF', '#123456',
  '{"purpose":"background"}', '{"purpose":"accent"}') = 'Holder', 'issued');
SELECT pg_temp.check((SELECT username = 'Holder' AND creator_subject_id = :'creator'
  AND current_owner_subject_id = :'owner' AND background_color = '#ABCDEF'
  AND accent_proof->>'purpose' = 'accent' FROM jpegpe.frogs WHERE frog_id = :'frog_b'), 'frog');
SELECT pg_temp.check((SELECT array_agg(coalesce(from_subject_id::text, '-') || '>' || to_subject_id::text
  ORDER BY event_id) = ARRAY['->' || :'creator', :'creator' || '>' || :'owner']
  FROM jpegpe.ownership_events WHERE frog_id = :'frog_b'), 'ownership history');
SELECT pg_temp.check((SELECT outcome FROM jpegpe.username_hold_ends AS e
  JOIN jpegpe.username_holds AS h USING (hold_id) WHERE h.frog_id = :'frog_b') = 'confirmed', 'confirmed');
SELECT pg_temp.check(NOT jpegpe.release_username(:'frog_b'), 'confirmed name is not released');
SELECT pg_temp.check(jpegpe.username_status('holder') = 'taken', 'permanent');
SELECT pg_temp.check(NOT jpegpe.hold_username('Third', :'frog_b'), 'issued frog holds nothing');

-- History is append-only, even for the owner; services cannot hold or release.
SET LOCAL ROLE jpegpe_owner;
DO $$ BEGIN
  UPDATE jpegpe.username_holds SET username = 'Other', username_key = 'other';
  RAISE EXCEPTION 'Hold rewritten';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  DELETE FROM jpegpe.username_hold_ends;
  RAISE EXCEPTION 'Hold end deleted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
RESET ROLE;
SET LOCAL ROLE jpegpe_service;
DO $$ BEGIN
  PERFORM jpegpe.hold_username('Sneaky', gen_random_uuid());
  RAISE EXCEPTION 'Service held a name';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
ROLLBACK;
