SET LOCAL ROLE splash_owner;

-- Short-lived counters are separate from accepted, append-only history.
CREATE TABLE splash.attempt_budgets (
  budget_key text PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX attempt_budgets_expiry ON splash.attempt_budgets(expires_at);
ALTER TABLE splash.attempt_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE splash.attempt_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON splash.attempt_budgets TO splash_owner
  USING (true) WITH CHECK (true);

-- Called under the admission lock; bounded counters include refused attempts.
CREATE FUNCTION splash.consume_attempt(key text, maximum integer, seconds integer)
RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  budget splash.attempt_budgets;
  now_at timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO budget FROM splash.attempt_budgets WHERE budget_key = key;
  IF budget.attempts >= maximum THEN
    RETURN greatest(1, ceil(extract(epoch FROM (budget.expires_at - now_at)))::integer);
  END IF;
  INSERT INTO splash.attempt_budgets(budget_key, attempts, expires_at)
    VALUES (key, 1, now_at + make_interval(secs => seconds))
    ON CONFLICT (budget_key) DO UPDATE SET attempts = splash.attempt_budgets.attempts + 1;
  RETURN 0;
END $$;

CREATE FUNCTION splash.reserve_submission_attempt()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  subject uuid := identity.current_subject();
  retry integer;
BEGIN
  IF subject IS NULL THEN
    RAISE EXCEPTION 'Verified subject required' USING ERRCODE = '28000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('splash.attempts', 0));
  DELETE FROM splash.attempt_budgets WHERE expires_at <= clock_timestamp();
  retry := splash.consume_attempt('submission:global', 200, 60);
  IF retry > 0 THEN RETURN retry; END IF;
  RETURN splash.consume_attempt('submission:' || subject::text, 10, 86400);
END $$;
REVOKE ALL ON TABLE splash.attempt_budgets FROM PUBLIC;
REVOKE ALL ON FUNCTION splash.consume_attempt(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION splash.reserve_submission_attempt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION splash.reserve_submission_attempt() TO splash_service;
RESET ROLE;
