BEGIN;
CREATE FUNCTION pg_temp.check(value boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Rounds assertion failed: %', label; END IF; END $$;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(620001) AS author \gset
SELECT identity.resolve_telegram(620002) AS bidder_b \gset
SELECT identity.resolve_telegram(620003) AS bidder_c \gset
SELECT identity.resolve_telegram(620004) AS bidder_d \gset
SELECT identity.resolve_telegram(620005) AS bidder_e \gset
RESET ROLE;
-- B has a public profile; a frog named Taken_Name already exists.
SELECT gen_random_uuid() AS b_frog \gset
SET LOCAL ROLE jpegpe_operator;
SELECT jpegpe.create_frog(:'b_frog', 'Bidder_B', :'bidder_b');
SELECT jpegpe.create_frog(gen_random_uuid(), 'Taken_Name', :'bidder_d');
RESET ROLE;
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id', :'bidder_b', true);
SELECT pg_temp.check(identity.select_frog(:'b_frog'), 'select frog');
RESET ROLE;

-- Frogs f1..f3 by the author, f4 by bidder B.
SELECT gen_random_uuid() AS f1, gen_random_uuid() AS f2, gen_random_uuid() AS f3,
  gen_random_uuid() AS f4 \gset
SET LOCAL ROLE splash_service;
SELECT set_config('rada.subject_id', :'author', true);
SELECT splash.submit_frog(:'f1'), splash.submit_frog(:'f2'), splash.submit_frog(:'f3');
SELECT splash.store_image(:'f1', repeat('1', 64), 64, 64, true, '\x01'::bytea);
SELECT splash.store_image(:'f2', repeat('2', 64), 64, 64, true, '\x02'::bytea);
SELECT splash.store_image(:'f3', repeat('3', 64), 64, 64, true, '\x03'::bytea);
SELECT set_config('rada.subject_id', :'bidder_b', true);
SELECT splash.submit_frog(:'f4');
SELECT splash.store_image(:'f4', repeat('4', 64), 64, 64, true, '\x04'::bytea);
RESET ROLE;

-- A short synthetic round (production rounds last 24 hours) holding all four frogs.
INSERT INTO splash.rounds(starts_at, ends_at)
  VALUES (clock_timestamp() - interval '1 hour', clock_timestamp() + interval '3 seconds')
  RETURNING round_id AS r1, ends_at AS r1_end \gset
INSERT INTO splash.lots(round_id, submission_id)
  VALUES (:r1, :'f1'), (:r1, :'f2'), (:r1, :'f3'), (:r1, :'f4');

CREATE FUNCTION pg_temp.bid(who uuid, frog uuid, amount numeric, name text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE result text;
BEGIN
  PERFORM set_config('rada.subject_id', who::text, true);
  SELECT b.status INTO result FROM splash.place_bid(frog, amount * 1e9, name) AS b;
  RETURN result;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.bid(uuid, uuid, numeric, text) TO splash_service;
SET LOCAL ROLE splash_service;
-- Validation and self-bid.
SELECT pg_temp.check(pg_temp.bid(:'author', :'f1', 100, 'Alpha') = 'self_bid', 'author self-bid');
SELECT pg_temp.check(pg_temp.bid(:'bidder_b', :'f4', 100, 'Alpha') = 'self_bid', 'B self-bid');
SELECT pg_temp.check(pg_temp.bid(:'bidder_b', :'f1', 0, 'Alpha') = 'invalid_amount', 'zero');
SELECT pg_temp.check(pg_temp.bid(:'bidder_b', :'f1', -5, 'Alpha') = 'invalid_amount', 'negative');
SELECT pg_temp.check(pg_temp.bid(:'bidder_b', :'f1', 1.5, 'Alpha') = 'invalid_amount', 'fraction');
SELECT pg_temp.check(pg_temp.bid(:'bidder_b', :'f1', 100, 'bad name') = 'invalid_name', 'bad name');
SELECT pg_temp.check(pg_temp.bid(:'bidder_b', :'f1', 100, '1abc') = 'invalid_name', 'digit start');
SELECT pg_temp.check(pg_temp.bid(:'bidder_b', :'f1', 100, 'taken_NAME') = 'name_taken', 'taken');
SELECT pg_temp.check(pg_temp.bid(:'bidder_b', gen_random_uuid(), 100, 'Alpha') = 'not_on_auction', 'unknown');
-- f1: duplicated low amounts lose; B wins at 100, although E bid higher.
SELECT pg_temp.check(pg_temp.bid(:'bidder_b', :'f1', 110, 'Alpha') = 'placed', 'B f1');
SELECT pg_temp.check(pg_temp.bid(:'bidder_c', :'f1', 10, 'Beta') = 'placed', 'C f1');
SELECT pg_temp.check(pg_temp.bid(:'bidder_d', :'f1', 10, 'Gamma') = 'placed', 'duplicate low');
SELECT pg_temp.check(pg_temp.bid(:'bidder_b', :'f1', 100, 'alpha') = 'placed', 'lower accepted');
SELECT pg_temp.check(pg_temp.bid(:'bidder_b', :'f1', 100, 'Alpha') = 'placed', 'same accepted');
SELECT pg_temp.check(pg_temp.bid(:'bidder_e', :'f1', 200, 'Higher') = 'placed', 'higher loses');
-- f2: C wins at 1 but B's frog has more competition, so B gets Alpha.
SELECT set_config('rada.subject_id', :'bidder_c', true);
SELECT pg_temp.check((SELECT name_contested FROM splash.place_bid(:'f2', 1e9, 'alpha')), 'contested');
-- f3: only duplicated amounts: no winner. A lower bid keeps the name choice time.
SELECT pg_temp.check(pg_temp.bid(:'bidder_d', :'f3', 20, 'Delta') = 'placed', 'D f3');
SELECT pg_temp.check(pg_temp.bid(:'bidder_d', :'f3', 10, 'delta') = 'placed', 'D f3 lower');
SELECT pg_temp.check(pg_temp.bid(:'bidder_c', :'f3', 10, 'Echo') = 'placed', 'C f3 duplicate');
SELECT set_config('rada.subject_id', :'bidder_d', true);
SELECT pg_temp.check((SELECT count(*) = 2 FROM splash.my_bids() WHERE status = 'active'), 'D active bids');
SELECT pg_temp.check((SELECT amount = 10e9 FROM splash.my_bids() WHERE submission_id = :'f3'), 'lowered');
SELECT pg_temp.check((SELECT name_contested FROM splash.my_bids() WHERE submission_id = :'f1') = false, 'own flag');
-- Public round exposes no bid amounts or bidder identities, even for public profiles.
SELECT pg_temp.check((SELECT bidder_count = 4 FROM splash.current_round()
  WHERE submission_id = :'f1'), 'f1 count');
SELECT pg_temp.check((SELECT array_agg(key ORDER BY key) = ARRAY[
  'accepting_bids','author_accent_color','author_background_color','author_frog_id',
  'author_username','background_removed','bidder_count','ends_at','height',
  'round_id','starts_at','submission_id','submitted_at','width']
  FROM jsonb_object_keys((SELECT to_jsonb(r) FROM splash.current_round() r LIMIT 1)) key), 'public fields');
SELECT pg_temp.check((SELECT status = 'invalid_amount' FROM splash.place_bid(:'f2', 1500000000, 'Half')), 'fractional token');
SELECT pg_temp.check((SELECT status = 'invalid_amount' FROM splash.place_bid(:'f2', 1, 'Tiny')), 'smallest unit');
-- Not due yet: nothing closes.
SELECT pg_temp.check(splash.advance_rounds() = 0, 'early close');
RESET ROLE;
SELECT pg_temp.check((SELECT count(*) = 3 FROM splash.bids WHERE submission_id = :'f3'), 'history kept');
SELECT pg_temp.check((SELECT amount_since > name_chosen_at FROM splash.bids
  WHERE submission_id = :'f3' AND bidder_subject_id = :'bidder_d' ORDER BY bid_id DESC LIMIT 1), 'times');

SELECT pg_sleep(greatest(0, extract(epoch FROM (:'r1_end'::timestamptz - clock_timestamp())) + 0.2));
SET LOCAL ROLE splash_service;
SELECT pg_temp.check(pg_temp.bid(:'bidder_c', :'f3', 500, 'Late') = 'round_closed', 'late bid');
-- Close once; a second run closes nothing.
SELECT pg_temp.check(splash.advance_rounds() = 1, 'close');
SELECT pg_temp.check(splash.advance_rounds() = 0, 'second close');
DO $$ BEGIN
  PERFORM splash.close_round(1);
  RAISE EXCEPTION 'Service called the internal close';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
SELECT pg_temp.check(NOT splash.close_round(:r1), 'direct second close');
SELECT pg_temp.check((SELECT count(*) = 1 FROM splash.round_closures WHERE round_id = :r1), 'one closure');
SELECT pg_temp.check((SELECT count(*) = 4 FROM splash.lot_results WHERE round_id = :r1), 'four decisions');

-- Decisions.
SELECT pg_temp.check((SELECT winner_subject_id = :'bidder_b' AND amount = 100e9 AND username = 'Alpha'
  AND name_outcome = 'reserved' AND bidder_count = 4 FROM splash.lot_results
  WHERE submission_id = :'f1'), 'lowest unique wins');
SELECT pg_temp.check((SELECT winner_subject_id = :'bidder_c' AND amount = 1e9 AND username IS NULL
  AND requested_username = 'alpha' AND name_outcome = 'conflict'
  AND claim_deadline = :'r1_end'::timestamptz + interval '24 hours'
  FROM splash.lot_results WHERE submission_id = :'f2'), 'f2 conflict');
SELECT pg_temp.check((SELECT winner_subject_id IS NULL AND amount IS NULL AND bidder_count = 2
  FROM splash.lot_results WHERE submission_id = :'f3'), 'no unique bid');
SELECT pg_temp.check((SELECT winner_subject_id IS NULL AND bidder_count = 0
  FROM splash.lot_results WHERE submission_id = :'f4'), 'f4 unsold');

SELECT pg_temp.check(splash.current_state(:'f3') = 'archived'
  AND splash.current_state(:'f4') = 'archived', 'unsold archived');
-- The next round opens without any of the closed frogs.
SELECT pg_temp.check((SELECT count(*) = 1 FROM splash.rounds WHERE round_id > :r1
  AND starts_at = :'r1_end'::timestamptz), 'next round');
SELECT pg_temp.check((SELECT count(*) = 0 FROM splash.lots
  WHERE round_id > :r1), 'next lots');

SET LOCAL ROLE splash_service;
-- Public results: the winner shows only with a public profile; never subject ids.
SELECT pg_temp.check((SELECT winner_frog_id = :'b_frog' AND winner_username = 'Bidder_B'
  FROM splash.round_results(:r1) WHERE submission_id = :'f1'), 'public winner');
SELECT pg_temp.check((SELECT count(*) = 3 FROM splash.round_results(:r1)
  WHERE submission_id <> :'f1' AND winner_frog_id IS NULL), 'private winners');
SELECT pg_temp.check((SELECT count(*) = 0 FROM splash.round_results(:r1 + 1)), 'open round hidden');
SELECT pg_temp.check((SELECT count(*) = 1 FROM splash.submission_image(:'f1')), 'won image');
SELECT pg_temp.check((SELECT count(*) = 0 FROM splash.pond() WHERE submission_id = :'f1'), 'left pond');
-- Own view of the outcome.
SELECT set_config('rada.subject_id', :'bidder_c', true);
SELECT pg_temp.check((SELECT status = 'lost' AND granted_username IS NULL FROM splash.my_bids()
  WHERE submission_id = :'f1'), 'C lost f1');
SELECT pg_temp.check((SELECT status = 'won' AND name_outcome = 'conflict' FROM splash.my_bids()
  WHERE submission_id = :'f2'), 'C won f2');
-- The claim change sees the pending win.
SELECT pg_temp.check((SELECT winner_subject_id = :'bidder_c' AND amount = 1e9 AND username IS NULL
  FROM splash.pending_claim(:'f2')), 'pending claim');
SELECT pg_temp.check((SELECT count(*) = 0 FROM splash.pending_claim(:'f4')), 'no claim');
-- A won name is held until the claim: it cannot be bid again, in any case.
SELECT pg_temp.check(pg_temp.bid(:'bidder_c', :'f4', 5, 'Omega') = 'not_on_auction', 'archived cannot bid');
SELECT pg_temp.check((SELECT count(*) = 1 FROM splash.submission_image(:'f4')), 'archived image');
-- Least privilege.
DO $$ BEGIN
  PERFORM * FROM splash.bids;
  RAISE EXCEPTION 'Service read bids';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM jpegpe.hold_username('Sneaky', gen_random_uuid());
  RAISE EXCEPTION 'Service held a name';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM jpegpe.release_username(gen_random_uuid());
  RAISE EXCEPTION 'Service released a name';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

-- JPEGPE holds the won name for the won frog id only.
SELECT pg_temp.check(jpegpe.username_status('alpha') = 'taken', 'held status');
SELECT pg_temp.check(jpegpe.held_username(:'f1') = 'Alpha', 'held for f1');
DO $$ BEGIN
  PERFORM jpegpe.create_frog(gen_random_uuid(), 'alpha', (SELECT subject_id FROM identity.subjects LIMIT 1));
  RAISE EXCEPTION 'Held name used by another frog';
EXCEPTION WHEN unique_violation THEN NULL; END $$;
SELECT pg_temp.check(NOT jpegpe.hold_username('Gamma2', :'f1'), 'one hold per frog');

-- Decisions are immutable, even for the owner.
SET LOCAL ROLE splash_owner;
DO $$ BEGIN
  UPDATE splash.lot_results SET amount = 1;
  RAISE EXCEPTION 'Result rewritten';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  DELETE FROM splash.round_closures;
  RAISE EXCEPTION 'Closure deleted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  UPDATE splash.bids SET amount = 1;
  RAISE EXCEPTION 'Bid rewritten';
EXCEPTION WHEN check_violation THEN NULL; END $$;
RESET ROLE;
SET LOCAL ROLE jpegpe_owner;
DO $$ BEGIN
  DELETE FROM jpegpe.username_holds;
  RAISE EXCEPTION 'Hold deleted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
RESET ROLE;
-- The bid sheet's live name check relays JPEGPE's rule to the service role.
SET LOCAL ROLE splash_service;
SELECT pg_temp.check(splash.name_status('taken_name') = 'taken', 'name taken');
SELECT pg_temp.check(splash.name_status('Fresh_Name') = 'available', 'name free');
SELECT pg_temp.check(splash.name_status('1bad') = 'invalid', 'name invalid');
RESET ROLE;
ROLLBACK;
