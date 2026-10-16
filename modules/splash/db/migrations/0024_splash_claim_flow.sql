SET LOCAL ROLE splash_owner;

-- Steward only: sets where claim payments go. Every change is kept.
CREATE FUNCTION splash.set_claim_recipient(new_recipient text)
RETURNS TABLE(recipient text, set_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  steward uuid := identity.current_subject();
  saved splash.recipient_settings;
BEGIN
  IF steward IS NULL THEN
    RAISE EXCEPTION 'Verified subject required' USING ERRCODE = '28000';
  END IF;
  IF NOT identity.can_steward_splash() THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  IF new_recipient IS NULL OR new_recipient !~ '^0:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid recipient' USING ERRCODE = '22023';
  END IF;
  INSERT INTO splash.recipient_settings AS s (recipient, set_by_subject_id)
    VALUES (new_recipient, steward) RETURNING s.* INTO saved;
  RETURN QUERY SELECT saved.recipient, saved.set_at;
END $$;

-- Internal: the current claim payment recipient, or null before the first setting.
CREATE FUNCTION splash.claim_recipient()
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT s.recipient FROM splash.recipient_settings AS s ORDER BY s.setting_id DESC LIMIT 1
$$;

-- Internal: the drand Quicknet round whose beacon colours a claimed frog: the
-- first round published after the payment's on-chain time (genesis 1692803367,
-- period 3 s). Nobody can know its randomness when the payment is signed.
CREATE FUNCTION splash.color_round(paid_at timestamptz)
RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT floor((extract(epoch FROM paid_at) - 1692803367) / 3)::bigint + 2
$$;

-- Internal: the earliest payment that settles the claim. It must be paid, by the
-- winner, in JPEGPE, for exactly the winning amount, to the attempt's recipient,
-- from the attempt's sender, for purpose splash:<frog id>, and confirmed on chain
-- strictly before the claim deadline. Processing time does not matter.
CREATE FUNCTION splash.valid_payment(target_submission_id uuid)
RETURNS TABLE(intent_id uuid, paid_on_chain_at timestamptz)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT a.intent_id, p.paid_on_chain_at
  FROM splash.lot_results AS r
  JOIN splash.claim_attempts AS a ON (a.submission_id = r.submission_id)
  CROSS JOIN LATERAL wallet.platform_payment('splash', a.intent_id) AS p
  WHERE r.submission_id = target_submission_id AND r.winner_subject_id IS NOT NULL
    AND p.status = 'paid' AND p.paid_on_chain_at < r.claim_deadline
    AND p.subject_id = r.winner_subject_id AND a.winner_subject_id = r.winner_subject_id
    AND p.token = 'JPEGPE' AND p.amount = r.amount AND a.amount = r.amount
    AND p.recipient = a.recipient AND p.sender = a.sender
    AND p.purpose = 'splash:' || target_submission_id::text
  ORDER BY p.paid_on_chain_at, a.attempt_no
  LIMIT 1
$$;

-- Internal: a Color Drop v1 proof bound to this frog, payment and round.
CREATE FUNCTION splash.proof_matches(
  proof jsonb, drop_purpose text, frog uuid, request uuid, drop_round bigint
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT coalesce(jsonb_typeof(proof) = 'object'
    AND proof->>'purpose' = drop_purpose
    AND proof->>'frogId' = frog::text
    AND proof->>'requestId' = request::text
    AND proof->>'round' = drop_round::text
    AND proof->>'chainHash' = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'
    AND proof->>'protocolVersion' = '1'
    AND proof->>'derivationVersion' = 'JPEGPE_COLOR_V1'
    AND proof->>'colorHex' ~ '^#[0-9A-F]{6}$'
    AND proof->>'randomness' ~ '^[0-9a-f]{64}$'
    AND proof->>'signature' ~ '^[0-9a-f]{96}$', false)
$$;

-- Starts (or resumes) the caller's claim of a won frog. Returns a status instead
-- of raising for expected refusals. A winner without a name chooses one here; it
-- is held at once under JPEGPE's rule. Starting closes 5 minutes before the
-- deadline; signing closes 2 minutes before it (sign_before).
CREATE FUNCTION splash.prepare_claim(target_submission_id uuid, proposed_username text)
RETURNS TABLE(
  status text, amount numeric, recipient text, username text,
  claim_deadline timestamptz, sign_before timestamptz, next_attempt integer,
  open_intent_id uuid, open_sender text, open_recipient text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  caller uuid := identity.current_subject();
  win splash.lot_results;
  latest splash.claim_attempts;
  pay_to text;
  held text;
  refusal text;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Verified subject required' USING ERRCODE = '28000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('splash.claim:' || target_submission_id::text, 0));
  SELECT r.* INTO win FROM splash.lot_results AS r
    WHERE r.submission_id = target_submission_id AND r.winner_subject_id IS NOT NULL;
  pay_to := splash.claim_recipient();
  held := jpegpe.held_username(target_submission_id);
  refusal := CASE
    WHEN win.round_id IS NULL THEN 'not_found'
    WHEN win.winner_subject_id <> caller THEN 'not_winner'
    WHEN splash.current_state(target_submission_id) = 'claimed' THEN 'already_claimed'
    WHEN splash.current_state(target_submission_id) = 'burned' THEN 'burned'
    WHEN clock_timestamp() >= win.claim_deadline - interval '5 minutes' THEN 'claim_expired'
    WHEN pay_to IS NULL THEN 'recipient_unset'
    WHEN held IS NOT NULL AND proposed_username IS NOT NULL
      AND lower(proposed_username) <> lower(held) THEN 'name_fixed'
    WHEN held IS NULL AND proposed_username IS NULL THEN 'name_required'
    WHEN held IS NULL AND jpegpe.username_status(proposed_username) = 'invalid' THEN 'invalid_name'
    WHEN held IS NULL AND NOT jpegpe.hold_username(proposed_username, target_submission_id)
      THEN 'name_taken'
  END;
  IF refusal IS NOT NULL THEN
    RETURN QUERY SELECT refusal, NULL::numeric, NULL::text, NULL::text, NULL::timestamptz,
      NULL::timestamptz, NULL::integer, NULL::uuid, NULL::text, NULL::text;
    RETURN;
  END IF;
  SELECT a.* INTO latest FROM splash.claim_attempts AS a
    WHERE a.submission_id = target_submission_id ORDER BY a.attempt_no DESC LIMIT 1;
  RETURN QUERY SELECT 'ready', win.amount, pay_to, jpegpe.held_username(target_submission_id),
    win.claim_deadline, win.claim_deadline - interval '2 minutes',
    coalesce(latest.attempt_no, 0) + 1, latest.intent_id, latest.sender, latest.recipient;
END $$;

-- Records the wallet intent of the caller's next claim attempt after checking that
-- its terms are exactly the claim's. 'recorded' (also on a repeat), or a refusal.
CREATE FUNCTION splash.record_claim_attempt(
  target_submission_id uuid, new_attempt_no integer, new_intent_id uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  caller uuid := identity.current_subject();
  win splash.lot_results;
  existing splash.claim_attempts;
  pay_intent uuid;
  pay_subject uuid;
  pay_token text;
  pay_amount numeric;
  pay_recipient text;
  pay_sender text;
  pay_purpose text;
  pay_status text;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Verified subject required' USING ERRCODE = '28000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('splash.claim:' || target_submission_id::text, 0));
  SELECT r.* INTO win FROM splash.lot_results AS r
    WHERE r.submission_id = target_submission_id AND r.winner_subject_id IS NOT NULL;
  IF win.round_id IS NULL OR win.winner_subject_id <> caller
     OR splash.current_state(target_submission_id) <> 'won' THEN
    RETURN 'not_claimable';
  END IF;
  IF clock_timestamp() >= win.claim_deadline - interval '5 minutes' THEN
    RETURN 'claim_expired';
  END IF;
  SELECT a.* INTO existing FROM splash.claim_attempts AS a
    WHERE a.submission_id = target_submission_id AND a.attempt_no = new_attempt_no;
  IF existing.intent_id IS NOT NULL THEN
    RETURN CASE WHEN existing.intent_id = new_intent_id THEN 'recorded' ELSE 'conflict' END;
  END IF;
  IF new_attempt_no <> 1 + coalesce((SELECT max(a.attempt_no) FROM splash.claim_attempts AS a
       WHERE a.submission_id = target_submission_id), 0) THEN
    RETURN 'conflict';
  END IF;
  SELECT p.intent_id, p.subject_id, p.token, p.amount, p.recipient, p.sender, p.purpose, p.status
    INTO pay_intent, pay_subject, pay_token, pay_amount, pay_recipient, pay_sender,
      pay_purpose, pay_status
    FROM wallet.platform_payment('splash', new_intent_id) AS p;
  IF pay_intent IS NULL OR pay_subject <> caller OR pay_token <> 'JPEGPE'
     OR pay_amount <> win.amount OR pay_recipient IS DISTINCT FROM splash.claim_recipient()
     OR pay_purpose <> 'splash:' || target_submission_id::text OR pay_status = 'cancelled' THEN
    RETURN 'terms_mismatch';
  END IF;
  INSERT INTO splash.claim_attempts(
    submission_id, attempt_no, intent_id, winner_subject_id, amount, recipient, sender
  ) VALUES (
    target_submission_id, new_attempt_no, new_intent_id, caller, win.amount,
    pay_recipient, pay_sender
  );
  RETURN 'recorded';
END $$;

-- Server: the payment that settles a claim and the committed colour round.
CREATE FUNCTION splash.claim_payment(target_submission_id uuid)
RETURNS TABLE(intent_id uuid, paid_on_chain_at timestamptz, color_round bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT v.intent_id, v.paid_on_chain_at, splash.color_round(v.paid_on_chain_at)
  FROM splash.valid_payment(target_submission_id) AS v
$$;

-- Server: completes a paid claim exactly once. The frog is issued in JPEGPE
-- under its held name (now permanent), created by the author and transferred to
-- the winner, with Color Drop colours bound to the payment. Returns 'claimed',
-- 'already_claimed', 'burned', 'unpaid' or 'not_found'.
CREATE FUNCTION splash.complete_claim(
  target_submission_id uuid, background_proof jsonb, accent_proof jsonb
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  win splash.lot_results;
  decided text;
  paid_intent uuid;
  paid_at timestamptz;
  issued text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('splash.claim:' || target_submission_id::text, 0));
  SELECT o.outcome INTO decided FROM splash.claim_outcomes AS o
    WHERE o.submission_id = target_submission_id;
  IF decided IS NOT NULL THEN
    RETURN CASE decided WHEN 'claimed' THEN 'already_claimed' ELSE 'burned' END;
  END IF;
  SELECT r.* INTO win FROM splash.lot_results AS r
    WHERE r.submission_id = target_submission_id AND r.winner_subject_id IS NOT NULL;
  IF win.round_id IS NULL OR splash.current_state(target_submission_id) <> 'won' THEN
    RETURN 'not_found';
  END IF;
  SELECT v.intent_id, v.paid_on_chain_at INTO paid_intent, paid_at
    FROM splash.valid_payment(target_submission_id) AS v;
  IF paid_intent IS NULL THEN RETURN 'unpaid'; END IF;
  IF NOT splash.proof_matches(background_proof, 'background', target_submission_id,
       paid_intent, splash.color_round(paid_at))
     OR NOT splash.proof_matches(accent_proof, 'accent', target_submission_id,
       paid_intent, splash.color_round(paid_at)) THEN
    RAISE EXCEPTION 'Invalid colour proof' USING ERRCODE = '22023';
  END IF;
  issued := jpegpe.issue_frog(target_submission_id, splash.author_of(target_submission_id),
    win.winner_subject_id, background_proof->>'colorHex', accent_proof->>'colorHex',
    background_proof, accent_proof);
  INSERT INTO splash.claim_outcomes(
    submission_id, outcome, intent_id, username, background_color, accent_color, paid_on_chain_at
  ) VALUES (
    target_submission_id, 'claimed', paid_intent, issued, background_proof->>'colorHex',
    accent_proof->>'colorHex', paid_at
  );
  INSERT INTO splash.submission_events(submission_id, state)
    VALUES (target_submission_id, 'claimed');
  RETURN 'claimed';
END $$;

-- Server: burns a won frog that was not paid in time, exactly once. Allowed only
-- 30 minutes after the deadline (late chain confirmation of an in-time payment)
-- and never while a payment confirmed before the deadline exists. The service
-- re-checks every signed attempt on chain right before calling this. The held
-- name is released; history stays.
CREATE FUNCTION splash.burn_claim(target_submission_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE win splash.lot_results;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('splash.claim:' || target_submission_id::text, 0));
  SELECT r.* INTO win FROM splash.lot_results AS r
    WHERE r.submission_id = target_submission_id AND r.winner_subject_id IS NOT NULL;
  IF win.round_id IS NULL OR splash.current_state(target_submission_id) <> 'won'
     OR clock_timestamp() < win.claim_deadline + interval '30 minutes'
     OR EXISTS (SELECT 1 FROM splash.valid_payment(target_submission_id)) THEN
    RETURN false;
  END IF;
  INSERT INTO splash.claim_outcomes(submission_id, outcome) VALUES (target_submission_id, 'burned');
  INSERT INTO splash.submission_events(submission_id, state)
    VALUES (target_submission_id, 'burned');
  PERFORM jpegpe.release_username(target_submission_id);
  RETURN true;
END $$;

-- Server, for the timer: unsettled wins with an attempt or past the burn time,
-- one row per attempt (intent_id null when there is none).
CREATE FUNCTION splash.open_claims()
RETURNS TABLE(
  submission_id uuid, winner_subject_id uuid, claim_deadline timestamptz,
  burn_after timestamptz, intent_id uuid, payment_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.submission_id, r.winner_subject_id, r.claim_deadline,
    r.claim_deadline + interval '30 minutes', a.intent_id, p.status
  FROM splash.lot_results AS r
  LEFT JOIN splash.claim_attempts AS a ON (a.submission_id = r.submission_id)
  LEFT JOIN LATERAL wallet.platform_payment('splash', a.intent_id) AS p ON true
  WHERE r.winner_subject_id IS NOT NULL AND splash.current_state(r.submission_id) = 'won'
    AND (a.intent_id IS NOT NULL OR clock_timestamp() >= r.claim_deadline + interval '30 minutes')
  ORDER BY r.claim_deadline, r.submission_id, a.attempt_no
  LIMIT 1000
$$;

-- The caller's wins with their claim state, newest first; one frog with a target.
CREATE FUNCTION splash.my_claims(target_submission_id uuid DEFAULT NULL)
RETURNS TABLE(
  submission_id uuid, round_id bigint, amount numeric, username text,
  name_outcome text, claim_deadline timestamptz, state text,
  background_color text, accent_color text, intent_id uuid, payment_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.submission_id, r.round_id, r.amount,
    coalesce(o.username, jpegpe.held_username(r.submission_id)), r.name_outcome,
    r.claim_deadline,
    CASE WHEN o.outcome IS NOT NULL THEN o.outcome
      WHEN clock_timestamp() >= r.claim_deadline THEN 'expired' ELSE 'open' END,
    o.background_color, o.accent_color, a.intent_id, p.status
  FROM splash.lot_results AS r
  LEFT JOIN splash.claim_outcomes AS o ON (o.submission_id = r.submission_id)
  LEFT JOIN LATERAL (
    SELECT x.intent_id FROM splash.claim_attempts AS x
    WHERE x.submission_id = r.submission_id ORDER BY x.attempt_no DESC LIMIT 1
  ) AS a ON true
  LEFT JOIN LATERAL wallet.platform_payment('splash', a.intent_id) AS p ON true
  WHERE r.winner_subject_id = identity.current_subject()
    AND (target_submission_id IS NULL OR r.submission_id = target_submission_id)
  ORDER BY r.claim_deadline DESC, r.submission_id
  LIMIT 200
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA splash FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA splash FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  splash.set_claim_recipient(text),
  splash.prepare_claim(uuid, text),
  splash.record_claim_attempt(uuid, integer, uuid),
  splash.claim_payment(uuid),
  splash.complete_claim(uuid, jsonb, jsonb),
  splash.burn_claim(uuid),
  splash.open_claims(),
  splash.my_claims(uuid)
TO splash_service;
RESET ROLE;
