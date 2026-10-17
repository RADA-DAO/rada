BEGIN;
CREATE FUNCTION pg_temp.check(value boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Admission assertion failed: %', label; END IF; END $$;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(629001) AS author \gset
SELECT identity.resolve_telegram(629002) AS bidder \gset
SELECT identity.resolve_telegram(629003) AS other_bidder \gset
RESET ROLE;
SELECT gen_random_uuid() AS frog \gset
SET LOCAL ROLE splash_service;
SELECT set_config('rada.subject_id', :'author', true);
SELECT splash.submit_frog(:'frog');
SELECT splash.store_image(:'frog', repeat('a', 64), 64, 64, false, '\x01'::bytea);
RESET ROLE;
INSERT INTO splash.rounds(starts_at, ends_at)
  VALUES (clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour')
  RETURNING round_id AS round \gset
INSERT INTO splash.lots(round_id, submission_id) VALUES (:round, :'frog');
SET LOCAL ROLE splash_service;
SELECT set_config('rada.subject_id', :'bidder', true);
-- Reserving attempts commits separately from image processing and storage.
SELECT pg_temp.check(splash.reserve_submission_attempt() = 0, 'first processing attempt');
DO $$ BEGIN
  FOR i IN 2..10 LOOP
    PERFORM pg_temp.check(splash.reserve_submission_attempt() = 0, 'processing allowance');
  END LOOP;
  PERFORM pg_temp.check(splash.reserve_submission_attempt() BETWEEN 1 AND 86400, 'processing limit');
END $$;
SELECT pg_temp.check((SELECT status = 'placed' FROM splash.place_bid(
  :'frog', 1329227995784915872903807060280344575, 'Alpha')), 'maximum bid');
SELECT pg_temp.check((SELECT status = 'bid_unchanged' FROM splash.place_bid(
  :'frog', 1329227995784915872903807060280344575, 'alpha')), 'case insensitive equivalent');
SELECT pg_temp.check((SELECT status = 'invalid_amount' FROM splash.place_bid(
  :'frog', 1329227995784915872903807060280344576, 'Beta')), 'above maximum');
SELECT set_config('fixture.frog', :'frog', true);
DO $$ DECLARE result text;
BEGIN
  FOR i IN 4..20 LOOP
    SELECT status INTO result FROM splash.place_bid(current_setting('fixture.frog')::uuid, 0, 'Alpha');
    PERFORM pg_temp.check(result = 'invalid_amount', 'failed attempts counted');
  END LOOP;
  SELECT status INTO result FROM splash.place_bid(current_setting('fixture.frog')::uuid, 1, 'Beta');
  PERFORM pg_temp.check(result = 'rate_limited', 'per subject lot limit');
END $$;
SELECT set_config('rada.subject_id', :'other_bidder', true);
SELECT pg_temp.check((SELECT status = 'placed' FROM splash.place_bid(:'frog', 1, 'Beta')), 'independent bidder');
RESET ROLE;
SELECT pg_temp.check((SELECT count(*) = 2 FROM splash.bids), 'only accepted history');
-- Expired budgets are reclaimed and admission resumes.
UPDATE splash.attempt_budgets SET expires_at = clock_timestamp() - interval '1 second';
SET LOCAL ROLE splash_service;
SELECT set_config('rada.subject_id', :'bidder', true);
SELECT pg_temp.check(splash.reserve_submission_attempt() = 0, 'processing expiry');
SELECT pg_temp.check((SELECT status = 'bid_unchanged' FROM splash.place_bid(
  :'frog', 1329227995784915872903807060280344575, 'ALPHA')), 'bid expiry');
-- Distinct lots cannot bypass the shared budget, even for refused attempts.
DO $$ DECLARE result text;
BEGIN
  FOR i IN 2..200 LOOP
    SELECT status INTO result FROM splash.place_bid(gen_random_uuid(), 0, 'Alpha');
    PERFORM pg_temp.check(result = 'invalid_amount', 'global allowance');
  END LOOP;
  SELECT status INTO result FROM splash.place_bid(gen_random_uuid(), 0, 'Alpha');
  PERFORM pg_temp.check(result = 'rate_limited', 'global limit');
END $$;
DO $$ BEGIN
  PERFORM * FROM splash.attempt_budgets;
  RAISE EXCEPTION 'Service read private counters';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM splash.consume_attempt('bid:global', 9999, 1);
  RAISE EXCEPTION 'Service changed admission terms';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
ROLLBACK;
