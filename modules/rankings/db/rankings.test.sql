BEGIN;
CREATE FUNCTION pg_temp.assert_true(value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed'; END IF;
END $$;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(926001) AS first_subject \gset
SELECT identity.resolve_telegram(926002) AS second_subject \gset
SELECT identity.resolve_telegram(926003) AS private_subject \gset
RESET ROLE;
SELECT '00000000-0000-4000-8000-000000000001' AS first_frog \gset
SELECT '00000000-0000-4000-8000-000000000002' AS second_frog \gset
SET LOCAL ROLE jpegpe_operator;
SELECT jpegpe.create_frog(:'first_frog', 'RankingFirst', :'first_subject');
SELECT jpegpe.create_frog(:'second_frog', 'RankingSecond', :'second_subject');
RESET ROLE;
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id', :'first_subject', true);
SELECT identity.select_frog(:'first_frog');
SELECT set_config('rada.subject_id', :'second_subject', true);
SELECT identity.select_frog(:'second_frog');
RESET ROLE;
SELECT pg_temp.assert_true(NOT EXISTS (SELECT FROM identity.holder_profiles()));
SET LOCAL ROLE wallet_service;
SELECT set_config('rada.subject_id', :'first_subject', true);
SELECT identity.wallet_link('0:' || repeat('1',64), 'fixture1');
SELECT identity.wallet_link('0:' || repeat('2',64), 'fixture2');
SELECT set_config('rada.subject_id', :'second_subject', true);
SELECT identity.wallet_link('0:' || repeat('3',64), 'fixture3');
SELECT set_config('rada.subject_id', :'private_subject', true);
SELECT identity.wallet_link('0:' || repeat('4',64), 'fixture4');
RESET ROLE;
-- Earliest active verified link wins even when its frog UUID sorts later.
UPDATE identity.wallet_links SET verified_at = now() - interval '2 days' WHERE subject_id = :'second_subject';
SET LOCAL ROLE rankings_worker;
SELECT pg_temp.assert_true((SELECT count(*) = 3 FROM identity.holder_wallets()));
SELECT pg_temp.assert_true(NOT EXISTS (SELECT FROM identity.holder_wallets() WHERE subject_id = :'private_subject'));
RESET ROLE;
SELECT link_version AS first_version FROM identity.holder_profiles() WHERE subject_id = :'first_subject' \gset
SELECT link_version AS second_version FROM identity.holder_profiles() WHERE subject_id = :'second_subject' \gset
SET LOCAL ROLE rankings_worker;
SELECT rankings.record(:'first_subject', :'first_frog', :'first_version', 'TON', '10000000000000000001', now());
SELECT rankings.record(:'second_subject', :'second_frog', :'second_version', 'TON', '10000000000000000001', now() - interval '7 hours');
SELECT rankings.record(:'first_subject', :'first_frog', :'first_version', 'JPEGPE', '0', now() - interval '6 hours');
RESET ROLE;
SET LOCAL ROLE rankings_service;
SELECT rankings.holders('TON', 1, 0, NULL) AS first_page \gset
SELECT pg_temp.assert_true((:'first_page'::jsonb #>> '{entries,0,frogId}') = :'second_frog');
SELECT pg_temp.assert_true((:'first_page'::jsonb #>> '{entries,0,amount}') = '10000000000000000001');
SELECT pg_temp.assert_true((:'first_page'::jsonb #>> '{entries,0,stale}')::boolean);
SELECT pg_temp.assert_true(jsonb_array_length(:'first_page'::jsonb -> 'entries') = 2);
SELECT pg_temp.assert_true((SELECT count(*) = 6 FROM jsonb_object_keys(:'first_page'::jsonb #> '{entries,0}')));
SELECT pg_temp.assert_true((rankings.holders('TON', 1, 1, :'first_page'::jsonb ->> 'revision') #>> '{entries,0,rank}') = '2');
SELECT pg_temp.assert_true(NOT (rankings.holders('JPEGPE', 50, 0, NULL) #>> '{entries,0,stale}')::boolean);
DO $$ BEGIN
  PERFORM * FROM rankings.balances;
  RAISE EXCEPTION 'Reader could read private table';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM * FROM identity.holder_wallets();
  RAISE EXCEPTION 'Reader could enumerate addresses';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM rankings.prune();
  RAISE EXCEPTION 'Reader could write projection';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
-- Equal amounts and verification timestamps fall back to frog UUID.
UPDATE identity.wallet_links SET verified_at = now() - interval '2 days' WHERE subject_id = :'first_subject';
SELECT link_version AS first_version FROM identity.holder_profiles() WHERE subject_id = :'first_subject' \gset
SET LOCAL ROLE rankings_worker;
SELECT rankings.prune();
SELECT rankings.record(:'first_subject', :'first_frog', :'first_version', 'TON', '10000000000000000001', now());
RESET ROLE;
SET LOCAL ROLE rankings_service;
SELECT pg_temp.assert_true((rankings.holders('TON', 50, 0, NULL) #>> '{entries,0,frogId}') = :'first_frog');
SELECT pg_temp.assert_true(rankings.holders('TON', 1, 1, :'first_page'::jsonb ->> 'revision') IS NULL);
RESET ROLE;
-- A revoked wallet invalidates the previous multi-wallet sum, including late writes.
SET LOCAL ROLE wallet_service;
SELECT set_config('rada.subject_id', :'first_subject', true);
SELECT identity.wallet_revoke('0:' || repeat('2',64));
RESET ROLE;
SET LOCAL ROLE rankings_worker;
SELECT rankings.record(:'first_subject', :'first_frog', :'first_version', 'TON', '999', now());
RESET ROLE;
SET LOCAL ROLE rankings_service;
SELECT pg_temp.assert_true(jsonb_array_length(rankings.holders('TON', 50, 0, NULL) -> 'entries') = 1);
RESET ROLE;
SELECT link_version AS first_version FROM identity.holder_profiles() WHERE subject_id = :'first_subject' \gset
SET LOCAL ROLE rankings_worker;
SELECT rankings.record(:'first_subject', :'first_frog', :'first_version', 'TON', '100', now());
RESET ROLE;
-- Clearing selection removes cached rows in the next projection, even on failures.
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id', :'first_subject', true);
SELECT identity.select_frog(NULL);
RESET ROLE;
SET LOCAL ROLE rankings_worker;
SELECT rankings.prune();
RESET ROLE;
SELECT pg_temp.assert_true(NOT EXISTS (SELECT FROM rankings.balances WHERE subject_id = :'first_subject'));
SET LOCAL ROLE rankings_service;
SELECT pg_temp.assert_true(jsonb_array_length(rankings.holders('TON', 50, 0, NULL) -> 'entries') = 1);
RESET ROLE;
-- Ownership loss removes the remaining person without needing a successful chain read.
SET LOCAL ROLE jpegpe_operator;
SELECT jpegpe.transfer_frog(:'second_frog', :'second_subject', :'private_subject');
RESET ROLE;
SET LOCAL ROLE rankings_service;
SELECT pg_temp.assert_true(jsonb_array_length(rankings.holders('TON', 50, 0, NULL) -> 'entries') = 0);
RESET ROLE;
SET LOCAL ROLE rankings_worker;
SELECT rankings.prune();
RESET ROLE;
SELECT pg_temp.assert_true(NOT EXISTS (SELECT FROM rankings.balances));
ROLLBACK;
