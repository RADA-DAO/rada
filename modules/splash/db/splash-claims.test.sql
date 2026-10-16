BEGIN;
CREATE FUNCTION pg_temp.check(value boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Claims assertion failed: %', label; END IF; END $$;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(640001) AS author \gset
SELECT identity.resolve_telegram(640002) AS winner \gset
SELECT identity.resolve_telegram(640003) AS other \gset
SELECT identity.resolve_telegram(640004) AS steward \gset
RESET ROLE;
SELECT '0:' || repeat('7', 64) AS wallet, '0:' || repeat('9', 64) AS pay_to,
  '0:' || repeat('8', 64) AS old_pay_to \gset
SELECT jpegpe.create_frog(gen_random_uuid(), 'Taken_Claim', :'other');

-- Five frogs by the author. Round 0 ended 25 hours ago (claim deadline passed an
-- hour ago), round 1 just ended (deadline tomorrow), round 2 ended 24 h 10 min ago
-- (deadline passed 10 minutes ago, still within the burn grace period).
SELECT gen_random_uuid() AS f1, gen_random_uuid() AS f2, gen_random_uuid() AS f3,
  gen_random_uuid() AS f4, gen_random_uuid() AS f5 \gset
INSERT INTO splash.submissions(submission_id, author_subject_id, submitted_at)
  SELECT id, :'author', now() - interval '3 days'
  FROM unnest(ARRAY[:'f1', :'f2', :'f3', :'f4', :'f5']::uuid[]) AS id;
INSERT INTO splash.submission_images
  SELECT id, md5(id::text) || md5(id::text), 'image/png', 64, 64, true, '\x01'::bytea
  FROM unnest(ARRAY[:'f1', :'f2', :'f3', :'f4', :'f5']::uuid[]) AS id;
INSERT INTO splash.submission_events(submission_id, state)
  SELECT id, 'in_pond' FROM unnest(ARRAY[:'f1', :'f2', :'f3', :'f4', :'f5']::uuid[]) AS id;
INSERT INTO splash.rounds(starts_at, ends_at) VALUES
  (clock_timestamp() - interval '49 hours', clock_timestamp() - interval '25 hours')
  RETURNING round_id AS r0 \gset
INSERT INTO splash.rounds(starts_at, ends_at) VALUES
  (clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 second')
  RETURNING round_id AS r1 \gset
INSERT INTO splash.rounds(starts_at, ends_at) VALUES
  (clock_timestamp() - interval '48 hours 10 minutes', clock_timestamp() - interval '24 hours 10 minutes')
  RETURNING round_id AS r2 \gset
INSERT INTO splash.lots VALUES (:r0, :'f1'), (:r0, :'f2'), (:r1, :'f3'), (:r1, :'f4'), (:r2, :'f5');
INSERT INTO splash.bids(round_id, submission_id, bidder_subject_id, amount, username,
  placed_at, amount_since, name_chosen_at) VALUES
  (:r0, :'f1', :'winner', 500, 'ClaimOne', now(), now(), now()),
  (:r0, :'f2', :'winner', 500, 'ClaimTwo', now(), now(), now()),
  (:r1, :'f3', :'winner', 500, 'ClaimThree', now(), now(), now()),
  (:r1, :'f4', :'winner', 500, 'Taken_Claim', now(), now(), now()),
  (:r2, :'f5', :'winner', 500, 'ClaimFive', now(), now(), now());
SELECT pg_temp.check(splash.close_round(:r0) AND splash.close_round(:r1) AND splash.close_round(:r2), 'closed');
SELECT claim_deadline AS d0 FROM splash.lot_results WHERE submission_id = :'f1' \gset
SELECT claim_deadline AS d1 FROM splash.lot_results WHERE submission_id = :'f3' \gset

-- At close a winning name is held, not permanent; a taken name leaves none.
SELECT pg_temp.check(jpegpe.held_username(:'f3') = 'ClaimThree', 'name held at close');
SELECT pg_temp.check((SELECT name_outcome = 'unavailable' FROM splash.lot_results WHERE submission_id = :'f4'), 'f4 unavailable');
SELECT pg_temp.check(jpegpe.held_username(:'f4') IS NULL, 'f4 holds nothing');
SELECT pg_temp.check((SELECT count(*) = 0 FROM jpegpe.frogs WHERE frog_id = :'f3'), 'no frog before claim');

SET LOCAL ROLE splash_service;
-- Only the steward sets the recipient; every change is kept.
SELECT set_config('rada.subject_id', :'winner', true);
SELECT pg_temp.check((SELECT status = 'recipient_unset' FROM splash.prepare_claim(:'f3', NULL)), 'no recipient yet');
DO $$ BEGIN
  PERFORM splash.set_claim_recipient('0:' || repeat('6', 64));
  RAISE EXCEPTION 'Non-steward changed the recipient';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
INSERT INTO identity.role_grants(subject_id, role_name) VALUES (:'steward', 'splash.steward');
SET LOCAL ROLE splash_service;
SELECT set_config('rada.subject_id', :'steward', true);
DO $$ BEGIN
  PERFORM splash.set_claim_recipient('EQ-not-raw');
  RAISE EXCEPTION 'Invalid recipient accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
SELECT pg_temp.check((SELECT recipient = :'old_pay_to' FROM splash.set_claim_recipient(:'old_pay_to')), 'first recipient');
SELECT pg_temp.check((SELECT recipient = :'pay_to' FROM splash.set_claim_recipient(:'pay_to')), 'second recipient');

-- Start refusals.
SELECT set_config('rada.subject_id', :'other', true);
SELECT pg_temp.check((SELECT status = 'not_winner' FROM splash.prepare_claim(:'f3', NULL)), 'not winner');
SELECT pg_temp.check((SELECT status = 'not_found' FROM splash.prepare_claim(gen_random_uuid(), NULL)), 'unknown frog');
SELECT set_config('rada.subject_id', :'winner', true);
SELECT pg_temp.check((SELECT status = 'claim_expired' FROM splash.prepare_claim(:'f1', NULL)), 'expired');
SELECT pg_temp.check((SELECT status = 'name_fixed' FROM splash.prepare_claim(:'f3', 'Other')), 'held name fixed');
SELECT pg_temp.check((SELECT status = 'ready' AND amount = 500 AND recipient = :'pay_to'
  AND username = 'ClaimThree' AND next_attempt = 1 AND open_intent_id IS NULL
  AND sign_before = :'d1'::timestamptz - interval '2 minutes'
  FROM splash.prepare_claim(:'f3', 'claimthree')), 'f3 ready');
-- A winner without a name chooses one at claim, under JPEGPE's rule.
SELECT pg_temp.check((SELECT status = 'name_required' FROM splash.prepare_claim(:'f4', NULL)), 'name required');
SELECT pg_temp.check((SELECT status = 'invalid_name' FROM splash.prepare_claim(:'f4', 'bad name')), 'invalid');
SELECT pg_temp.check((SELECT status = 'name_taken' FROM splash.prepare_claim(:'f4', 'taken_claim')), 'taken');
SELECT pg_temp.check((SELECT status = 'name_taken' FROM splash.prepare_claim(:'f4', 'CLAIMTHREE')), 'held elsewhere');
SELECT pg_temp.check((SELECT status = 'ready' AND username = 'ClaimFour' FROM splash.prepare_claim(:'f4', 'ClaimFour')), 'chosen');
SELECT pg_temp.check((SELECT status = 'name_fixed' FROM splash.prepare_claim(:'f4', 'Different')), 'chosen is fixed');
RESET ROLE;
SELECT pg_temp.check(jpegpe.held_username(:'f4') = 'ClaimFour', 'chosen name held');

-- Wallet platform intents as the wallet would create them; the wrong ones differ in one term.
CREATE FUNCTION pg_temp.intent(payer uuid, idem text, pay_amount numeric, pay_purpose text,
  is_platform boolean DEFAULT true, pay_to text DEFAULT '0:' || repeat('9', 64)) RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO wallet.payment_intents(intent_id, subject_id, app_id, idempotency_key, token,
    amount, recipient, sender, purpose, platform, sign_before)
  VALUES (gen_random_uuid(), payer, 'splash', idem, 'JPEGPE', pay_amount, pay_to,
    '0:' || repeat('7', 64), pay_purpose, is_platform,
    CASE WHEN is_platform THEN now() + interval '1 day' END)
  RETURNING intent_id
$$;
SELECT pg_temp.intent(:'winner', 'claim-f3-a', 499, 'splash:' || :'f3') AS low,
  pg_temp.intent(:'winner', 'claim-f3-b', 500, 'splash:' || :'f4') AS wrong_purpose,
  pg_temp.intent(:'winner', 'claim-f3-c', 500, 'splash:' || :'f3', false) AS not_platform,
  pg_temp.intent(:'other', 'claim-f3-d', 500, 'splash:' || :'f3') AS foreign_intent,
  pg_temp.intent(:'winner', 'claim-f3-e', 500, 'splash:' || :'f3', true, :'old_pay_to') AS old_recipient,
  pg_temp.intent(:'winner', 'claim-f3-1', 500, 'splash:' || :'f3') AS good3,
  pg_temp.intent(:'winner', 'claim-f4-1', 500, 'splash:' || :'f4') AS good4,
  pg_temp.intent(:'winner', 'claim-f1-1', 500, 'splash:' || :'f1') AS good1,
  pg_temp.intent(:'winner', 'claim-f2-1', 500, 'splash:' || :'f2') AS good2 \gset

SET LOCAL ROLE splash_service;
SELECT set_config('rada.subject_id', :'winner', true);
SELECT pg_temp.check(splash.record_claim_attempt(:'f3', 1, :'low') = 'terms_mismatch', 'wrong amount');
SELECT pg_temp.check(splash.record_claim_attempt(:'f3', 1, :'wrong_purpose') = 'terms_mismatch', 'wrong purpose');
SELECT pg_temp.check(splash.record_claim_attempt(:'f3', 1, :'not_platform') = 'terms_mismatch', 'not platform');
SELECT pg_temp.check(splash.record_claim_attempt(:'f3', 1, :'foreign_intent') = 'terms_mismatch', 'other payer');
SELECT pg_temp.check(splash.record_claim_attempt(:'f3', 1, :'old_recipient') = 'terms_mismatch', 'old recipient');
SELECT pg_temp.check(splash.record_claim_attempt(:'f3', 2, :'good3') = 'conflict', 'attempt gap');
SELECT pg_temp.check(splash.record_claim_attempt(:'f3', 1, :'good3') = 'recorded', 'recorded');
SELECT pg_temp.check(splash.record_claim_attempt(:'f3', 1, :'good3') = 'recorded', 'repeat recorded');
SELECT pg_temp.check(splash.record_claim_attempt(:'f3', 1, :'good4') = 'conflict', 'attempt taken');
SELECT pg_temp.check(splash.record_claim_attempt(:'f4', 1, :'good4') = 'recorded', 'f4 recorded');
SELECT pg_temp.check((SELECT open_intent_id = :'good3' AND next_attempt = 2 AND open_sender = :'wallet'
  FROM splash.prepare_claim(:'f3', NULL)), 'resume attempt');
SELECT set_config('rada.subject_id', :'other', true);
SELECT pg_temp.check(splash.record_claim_attempt(:'f3', 2, :'foreign_intent') = 'not_claimable', 'stranger');
-- Unpaid claims do not complete.
SELECT pg_temp.check(splash.complete_claim(:'f3', '{}', '{}') = 'unpaid', 'unpaid');
RESET ROLE;
-- Attempts recorded in time for the frogs of round 0 (their deadline has passed since).
INSERT INTO splash.claim_attempts(submission_id, attempt_no, intent_id, winner_subject_id, amount, recipient, sender)
  VALUES (:'f1', 1, :'good1', :'winner', 500, :'pay_to', :'wallet'),
         (:'f2', 1, :'good2', :'winner', 500, :'pay_to', :'wallet');
-- Paid: f3 now; f1 one second before its deadline; f2 exactly at its deadline (late).
UPDATE wallet.payment_intents SET status = 'paid', receipt_hash = md5(intent_id::text) || md5(intent_id::text),
  paid_on_chain_at = CASE intent_id WHEN :'good3' THEN now()
    WHEN :'good1' THEN :'d0'::timestamptz - interval '1 second' ELSE :'d0'::timestamptz END
  WHERE intent_id IN (:'good3', :'good1', :'good2');

CREATE FUNCTION pg_temp.proof(drop_purpose text, frog uuid, intent uuid, hex text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('purpose', drop_purpose, 'frogId', frog::text, 'requestId', intent::text,
    'round', (SELECT splash.color_round(paid_on_chain_at) FROM wallet.payment_intents WHERE intent_id = intent)::text,
    'chainHash', '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
    'protocolVersion', 1, 'derivationVersion', 'JPEGPE_COLOR_V1', 'taxonomyVersion', 1,
    'colorHex', hex, 'colorClass', 'fixture', 'randomness', repeat('a', 64), 'signature', repeat('b', 96))
$$;
SELECT pg_temp.proof('background', :'f3', :'good3', '#AABBCC') AS bg3,
  pg_temp.proof('accent', :'f3', :'good3', '#112233') AS ac3,
  pg_temp.proof('background', :'f1', :'good1', '#ABCDEF') AS bg1,
  pg_temp.proof('accent', :'f1', :'good1', '#FEDCBA') AS ac1 \gset
SELECT pg_temp.check((SELECT color_round = splash.color_round(paid_on_chain_at) AND intent_id = :'good3'
  FROM splash.claim_payment(:'f3')), 'claim payment');

SELECT set_config('rada.fixture_f3', :'f3', true), set_config('rada.fixture_bg3', :'bg3', true),
  set_config('rada.fixture_ac3', :'ac3', true), set_config('rada.fixture_bg1', :'bg1', true);
SET LOCAL ROLE splash_service;
-- Proofs must be bound to this frog, this payment and the committed round.
DO $$ BEGIN
  PERFORM splash.complete_claim(current_setting('rada.fixture_f3')::uuid, '{"purpose":"background"}', '{}');
  RAISE EXCEPTION 'Unbound proof accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN
  PERFORM splash.complete_claim(current_setting('rada.fixture_f3')::uuid,
    current_setting('rada.fixture_ac3')::jsonb, current_setting('rada.fixture_bg3')::jsonb);
  RAISE EXCEPTION 'Swapped proofs accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
DO $$ BEGIN
  PERFORM splash.complete_claim(current_setting('rada.fixture_f3')::uuid,
    current_setting('rada.fixture_bg1')::jsonb, current_setting('rada.fixture_ac3')::jsonb);
  RAISE EXCEPTION 'Proof of another frog accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
SELECT pg_temp.check(splash.complete_claim(:'f3', :'bg3', :'ac3') = 'claimed', 'claimed');
SELECT pg_temp.check(splash.complete_claim(:'f3', :'bg3', :'ac3') = 'already_claimed', 'double confirmation');
SELECT pg_temp.check(NOT splash.burn_claim(:'f3'), 'claimed never burns');
-- Deadline boundary: paid one second before the deadline wins although processed after it.
SELECT pg_temp.check(NOT splash.burn_claim(:'f1'), 'paid in time blocks burn');
SELECT pg_temp.check(splash.complete_claim(:'f1', :'bg1', :'ac1') = 'claimed', 'late processing');
-- Paid exactly at the deadline is late: no claim, the frog burns once.
SELECT pg_temp.check(splash.complete_claim(:'f2', '{}', '{}') = 'unpaid', 'paid at deadline');
SELECT pg_temp.check(splash.burn_claim(:'f2'), 'burned');
SELECT pg_temp.check(NOT splash.burn_claim(:'f2'), 'burn once');
SELECT pg_temp.check(splash.complete_claim(:'f2', '{}', '{}') = 'burned', 'no claim after burn');
-- Within the grace period after the deadline nothing burns yet.
SELECT pg_temp.check(NOT splash.burn_claim(:'f5'), 'grace period');
SELECT pg_temp.check(NOT splash.burn_claim(:'f4'), 'open claim');
SELECT pg_temp.check((SELECT array_agg(DISTINCT submission_id) = ARRAY[:'f4'::uuid] FROM splash.open_claims()
  WHERE submission_id IN (:'f1', :'f2', :'f3', :'f4', :'f5')), 'open claims');
SELECT pg_temp.check((SELECT count(*) = 1 FROM splash.submission_image(:'f2')), 'burned image kept');
SELECT set_config('rada.subject_id', :'winner', true);
SELECT pg_temp.check((SELECT status = 'already_claimed' FROM splash.prepare_claim(:'f3', NULL)), 'double claim');
SELECT pg_temp.check((SELECT string_agg(submission_id::text || '=' || state, ',' ORDER BY submission_id) =
  (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(ARRAY[:'f1' || '=claimed', :'f2' || '=burned',
    :'f3' || '=claimed', :'f4' || '=open', :'f5' || '=expired']) AS x)
  FROM splash.my_claims()), 'my claims');
SELECT pg_temp.check((SELECT username = 'ClaimThree' AND background_color = '#AABBCC'
  AND payment_status = 'paid' FROM splash.my_claims(:'f3')), 'claimed view');
SELECT set_config('rada.subject_id', :'other', true);
SELECT pg_temp.check((SELECT count(*) = 0 FROM splash.my_claims()), 'own only');
-- Least privilege: no tables, no internal or foreign functions.
DO $$ BEGIN
  PERFORM * FROM splash.claim_attempts;
  RAISE EXCEPTION 'Service read attempts';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM * FROM splash.valid_payment(gen_random_uuid());
  RAISE EXCEPTION 'Service ran the internal check';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM * FROM wallet.platform_payment('splash', gen_random_uuid());
  RAISE EXCEPTION 'Service read wallet intents';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

-- Ownership moved from the author to the winner; names: permanent, released.
SELECT pg_temp.check((SELECT username = 'ClaimThree' AND creator_subject_id = :'author'
  AND current_owner_subject_id = :'winner' AND background_color = '#AABBCC'
  AND accent_proof->>'requestId' = :'good3' FROM jpegpe.frogs WHERE frog_id = :'f3'), 'frog issued');
SELECT pg_temp.check((SELECT count(*) = 2 FROM jpegpe.ownership_events WHERE frog_id = :'f3'), 'ownership events');
SELECT pg_temp.check(jpegpe.username_status('claimtwo') = 'available', 'burned name released');
SELECT pg_temp.check(jpegpe.username_status('claimthree') = 'taken', 'claimed name permanent');
SELECT pg_temp.check((SELECT array_agg(state ORDER BY event_id) = ARRAY['in_pond', 'won', 'burned']
  FROM splash.submission_events WHERE submission_id = :'f2'), 'burn history');
SELECT pg_temp.check((SELECT count(*) = 2 FROM splash.recipient_settings), 'recipient history');

-- History is immutable, even for the owner.
SET LOCAL ROLE splash_owner;
DO $$ BEGIN
  UPDATE splash.claim_outcomes SET outcome = 'burned';
  RAISE EXCEPTION 'Outcome rewritten';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  DELETE FROM splash.claim_attempts;
  RAISE EXCEPTION 'Attempt deleted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  UPDATE splash.recipient_settings SET recipient = '0:' || repeat('5', 64);
  RAISE EXCEPTION 'Recipient history rewritten';
EXCEPTION WHEN check_violation THEN NULL; END $$;
RESET ROLE;
ROLLBACK;
