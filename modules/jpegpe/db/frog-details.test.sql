BEGIN;
CREATE FUNCTION pg_temp.assert_true(value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Frog detail assertion failed'; END IF; END $$;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(930001) AS creator \gset
SELECT identity.resolve_telegram(930002) AS owner \gset
RESET ROLE;
SELECT gen_random_uuid() AS frog, gen_random_uuid() AS public_frog \gset
SET LOCAL ROLE jpegpe_operator;
SELECT jpegpe.create_frog(:'frog', 'DetailFixture', :'creator');
SELECT jpegpe.create_frog(:'public_frog', 'PublicCreatorFixture', :'creator');
SELECT jpegpe.transfer_frog(:'frog', :'creator', :'owner');
RESET ROLE;
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id', :'creator', true);
SELECT pg_temp.assert_true(jpegpe.own_frog_details(:'frog') IS NULL);
SELECT identity.select_frog(:'public_frog');
SELECT set_config('rada.subject_id', :'owner', true);
SELECT pg_temp.assert_true(jpegpe.own_frog_details(:'frog')->>'creator' = 'PublicCreatorFixture');
SELECT pg_temp.assert_true(jpegpe.own_frog_details(:'frog')->>'owner' IS NULL);
SELECT pg_temp.assert_true(jsonb_array_length(jpegpe.own_frog_details(:'frog')->'history') = 2);
SELECT pg_temp.assert_true(jpegpe.own_frog_details(:'frog')->'history'->1->>'from' = 'PublicCreatorFixture');
SELECT pg_temp.assert_true(jpegpe.own_frog_details(:'frog')->'history'->1->>'to' IS NULL);
SELECT pg_temp.assert_true((jpegpe.own_frog_details(:'frog')->'history'->1->>'at')::timestamptz <= now());
SELECT identity.select_frog(:'frog');
SELECT pg_temp.assert_true(jpegpe.own_frog_details(:'frog')->>'owner' = 'DetailFixture');
SELECT set_config('rada.subject_id', :'creator', true);
SELECT identity.select_frog(NULL);
SELECT set_config('rada.subject_id', :'owner', true);
SELECT pg_temp.assert_true(jpegpe.own_frog_details(:'frog')->>'creator' IS NULL);
SELECT pg_temp.assert_true(jpegpe.own_frog_details(:'frog')::text NOT LIKE '%' || :'creator' || '%');
SELECT pg_temp.assert_true(jpegpe.own_frog_details(:'frog')::text NOT LIKE '%' || :'owner' || '%');
SELECT set_config('rada.subject_id', '', true);
SELECT pg_temp.assert_true(jpegpe.own_frog_details(:'frog') IS NULL);
ROLLBACK;
