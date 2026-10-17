SET LOCAL ROLE splash_owner;

-- Durable, append-only safety hold; a late valid payment may still complete.
CREATE TABLE splash.claim_review_holds (
  submission_id uuid PRIMARY KEY REFERENCES splash.submissions(submission_id),
  state text NOT NULL DEFAULT 'needs_manual_review' CHECK (state = 'needs_manual_review'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER claim_review_holds_immutable BEFORE UPDATE OR DELETE ON splash.claim_review_holds
  FOR EACH ROW EXECUTE FUNCTION splash.reject_change();
ALTER TABLE splash.claim_review_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE splash.claim_review_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON splash.claim_review_holds TO splash_owner USING (true) WITH CHECK (true);
REVOKE ALL ON splash.claim_review_holds FROM PUBLIC;

CREATE FUNCTION splash.review_claim(target_submission_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('splash.claim:' || target_submission_id::text, 0));
  IF splash.current_state(target_submission_id) = 'won' THEN
    INSERT INTO splash.claim_review_holds(submission_id) VALUES (target_submission_id)
      ON CONFLICT DO NOTHING;
  END IF;
END $$;

CREATE FUNCTION splash.claim_reviews()
RETURNS TABLE(submission_id uuid, state text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT coalesce(identity.can_steward_splash(), false) THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT h.submission_id, h.state FROM splash.claim_review_holds AS h
    WHERE splash.current_state(h.submission_id) = 'won'
    ORDER BY h.created_at, h.submission_id;
END $$;

CREATE OR REPLACE FUNCTION splash.open_claims()
RETURNS TABLE(
  submission_id uuid, winner_subject_id uuid, claim_deadline timestamptz,
  burn_after timestamptz, intent_id uuid, payment_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH batch AS MATERIALIZED (
    SELECT r.* FROM splash.lot_results AS r
    WHERE r.winner_subject_id IS NOT NULL AND splash.current_state(r.submission_id) = 'won'
      AND NOT EXISTS (SELECT 1 FROM splash.claim_review_holds AS h WHERE h.submission_id = r.submission_id)
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

CREATE OR REPLACE FUNCTION splash.burn_claim(target_submission_id uuid, absent_intents uuid[])
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
     OR EXISTS (SELECT 1 FROM splash.claim_review_holds AS h WHERE h.submission_id = target_submission_id)
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

CREATE OR REPLACE FUNCTION splash.my_claims(target_submission_id uuid DEFAULT NULL)
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
      WHEN EXISTS (SELECT 1 FROM splash.claim_review_holds AS h WHERE h.submission_id = r.submission_id)
        THEN 'needs_manual_review'
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

REVOKE ALL ON FUNCTION splash.review_claim(uuid), splash.claim_reviews() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION splash.review_claim(uuid), splash.claim_reviews() TO splash_service;
RESET ROLE;
