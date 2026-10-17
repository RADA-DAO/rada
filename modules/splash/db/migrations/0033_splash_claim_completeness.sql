SET LOCAL ROLE splash_owner;

-- Choose whole frogs before loading their complete attempt histories.
CREATE OR REPLACE FUNCTION splash.open_claims()
RETURNS TABLE(
  submission_id uuid, winner_subject_id uuid, claim_deadline timestamptz,
  burn_after timestamptz, intent_id uuid, payment_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH batch AS MATERIALIZED (
    SELECT r.* FROM splash.lot_results AS r
    WHERE r.winner_subject_id IS NOT NULL AND splash.current_state(r.submission_id) = 'won'
      AND (EXISTS (SELECT 1 FROM splash.claim_attempts AS a WHERE a.submission_id = r.submission_id)
        OR clock_timestamp() >= r.claim_deadline + interval '30 minutes')
    ORDER BY r.claim_deadline, r.submission_id
    LIMIT 1000
  )
  SELECT r.submission_id, r.winner_subject_id, r.claim_deadline,
    r.claim_deadline + interval '30 minutes', a.intent_id, p.status
  FROM batch AS r
  LEFT JOIN splash.claim_attempts AS a ON (a.submission_id = r.submission_id)
  LEFT JOIN LATERAL wallet.platform_payment('splash', a.intent_id) AS p ON true
  ORDER BY r.claim_deadline, r.submission_id, a.attempt_no
$$;

-- The service keeps this transaction open through reconciliation and settlement.
CREATE FUNCTION splash.lock_claim(target_submission_id uuid)
RETURNS TABLE(
  submission_id uuid, winner_subject_id uuid, claim_deadline timestamptz,
  burn_after timestamptz, intent_id uuid, payment_status text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('splash.claim:' || target_submission_id::text, 0));
  RETURN QUERY
    SELECT r.submission_id, r.winner_subject_id, r.claim_deadline,
      r.claim_deadline + interval '30 minutes', a.intent_id, p.status
    FROM splash.lot_results AS r
    LEFT JOIN splash.claim_attempts AS a ON (a.submission_id = r.submission_id)
    LEFT JOIN LATERAL wallet.platform_payment('splash', a.intent_id) AS p ON true
    WHERE r.submission_id = target_submission_id AND r.winner_subject_id IS NOT NULL
      AND splash.current_state(r.submission_id) = 'won'
    ORDER BY a.attempt_no;
END $$;

-- Unknown attempts need an exhaustive negative scan of their fixed payment window.
CREATE FUNCTION splash.burn_claim(target_submission_id uuid, absent_intents uuid[])
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE win splash.lot_results;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('splash.claim:' || target_submission_id::text, 0));
  SELECT r.* INTO win FROM splash.lot_results AS r
    WHERE r.submission_id = target_submission_id AND r.winner_subject_id IS NOT NULL;
  IF win.round_id IS NULL OR splash.current_state(target_submission_id) <> 'won'
     OR clock_timestamp() < win.claim_deadline + interval '30 minutes'
     OR EXISTS (SELECT 1 FROM splash.valid_payment(target_submission_id))
     OR absent_intents IS NULL
     OR EXISTS (
       SELECT 1 FROM splash.claim_attempts AS a
       LEFT JOIN LATERAL wallet.platform_payment('splash', a.intent_id) AS p ON true
       WHERE a.submission_id = target_submission_id
         AND (p.status IS NULL OR (p.status = 'unknown'
           AND NOT coalesce(a.intent_id = ANY(absent_intents), false)))
     ) THEN
    RETURN false;
  END IF;
  INSERT INTO splash.claim_outcomes(submission_id, outcome) VALUES (target_submission_id, 'burned');
  INSERT INTO splash.submission_events(submission_id, state)
    VALUES (target_submission_id, 'burned');
  PERFORM jpegpe.release_username(target_submission_id);
  RETURN true;
END $$;

-- Older callers cannot authorize a burn with unresolved attempts.
CREATE OR REPLACE FUNCTION splash.burn_claim(target_submission_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT splash.burn_claim(target_submission_id, ARRAY[]::uuid[])
$$;

REVOKE ALL ON FUNCTION splash.lock_claim(uuid), splash.burn_claim(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION splash.lock_claim(uuid), splash.burn_claim(uuid, uuid[]) TO splash_service;
RESET ROLE;
