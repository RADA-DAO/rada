SET LOCAL ROLE splash_owner;

-- Claimed (paid) and burned (unpaid by the deadline) frogs keep their history.
ALTER TABLE splash.submission_events DROP CONSTRAINT submission_events_state_check;
ALTER TABLE splash.submission_events ADD CONSTRAINT submission_events_state_check
  CHECK (state IN ('in_pond', 'won', 'claimed', 'burned'));

-- Where claim payments go, decided by the SPLASH steward. Append-only; the
-- current recipient is the latest row. Raw mainnet address form only.
CREATE TABLE splash.recipient_settings (
  setting_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipient text NOT NULL CHECK (recipient ~ '^0:[0-9a-f]{64}$'),
  set_by_subject_id uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Each payment attempt of a claim is one wallet intent; its terms (winner,
-- amount, recipient, sender) are fixed when the attempt starts.
CREATE TABLE splash.claim_attempts (
  submission_id uuid NOT NULL REFERENCES splash.submissions(submission_id),
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 50),
  intent_id uuid NOT NULL UNIQUE,
  winner_subject_id uuid NOT NULL,
  amount numeric(78, 0) NOT NULL CHECK (amount > 0),
  recipient text NOT NULL CHECK (recipient ~ '^0:[0-9a-f]{64}$'),
  sender text NOT NULL CHECK (sender ~ '^0:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (submission_id, attempt_no)
);

-- The one final outcome of a won frog; the primary key makes it exactly-once.
CREATE TABLE splash.claim_outcomes (
  submission_id uuid PRIMARY KEY REFERENCES splash.submissions(submission_id),
  outcome text NOT NULL CHECK (outcome IN ('claimed', 'burned')),
  intent_id uuid UNIQUE REFERENCES splash.claim_attempts(intent_id),
  username text,
  background_color text,
  accent_color text,
  paid_on_chain_at timestamptz,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (outcome = 'claimed' AND intent_id IS NOT NULL AND username IS NOT NULL
      AND background_color IS NOT NULL AND accent_color IS NOT NULL
      AND paid_on_chain_at IS NOT NULL)
    OR (outcome = 'burned' AND intent_id IS NULL AND username IS NULL
      AND background_color IS NULL AND accent_color IS NULL AND paid_on_chain_at IS NULL)
  )
);

CREATE TRIGGER recipient_settings_immutable BEFORE UPDATE OR DELETE ON splash.recipient_settings
  FOR EACH ROW EXECUTE FUNCTION splash.reject_change();
CREATE TRIGGER claim_attempts_immutable BEFORE UPDATE OR DELETE ON splash.claim_attempts
  FOR EACH ROW EXECUTE FUNCTION splash.reject_change();
CREATE TRIGGER claim_outcomes_immutable BEFORE UPDATE OR DELETE ON splash.claim_outcomes
  FOR EACH ROW EXECUTE FUNCTION splash.reject_change();
ALTER TABLE splash.recipient_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE splash.recipient_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE splash.claim_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE splash.claim_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE splash.claim_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE splash.claim_outcomes FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON splash.recipient_settings TO splash_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON splash.claim_attempts TO splash_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON splash.claim_outcomes TO splash_owner USING (true) WITH CHECK (true);

-- Round close as before, except that a winning name is held, not made permanent.
-- Internal: closes one due round, once. The row lock waits for bids in flight
-- (they hold a share lock), and the closure primary key rejects a second close.
-- Winner per lot: highest amount; tie -> earliest amount_since, then lowest bid id.
-- Names: winners are taken in order of amount (higher first), then earlier
-- name_chosen_at, then bid id; each holds its name in JPEGPE until the paid claim
-- ('reserved'). A winner whose name is already taken keeps the frog and gets no
-- name ('conflict' if a winner of this round took it, otherwise 'unavailable').
CREATE OR REPLACE FUNCTION splash.close_round(target_round_id bigint)
RETURNS boolean LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  round splash.rounds;
  winner record;
  granted boolean;
BEGIN
  SELECT * INTO round FROM splash.rounds AS r WHERE r.round_id = target_round_id FOR UPDATE;
  IF NOT FOUND OR round.ends_at > clock_timestamp() OR EXISTS (
    SELECT 1 FROM splash.round_closures AS c WHERE c.round_id = target_round_id
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO splash.round_closures(round_id) VALUES (target_round_id);
  FOR winner IN
    SELECT * FROM (
      SELECT DISTINCT ON (b.submission_id) b.*,
        count(*) OVER (PARTITION BY b.submission_id) AS bidders
      FROM splash.active_bids(target_round_id) AS b
      ORDER BY b.submission_id, b.amount DESC, b.amount_since, b.bid_id
    ) AS w
    ORDER BY w.amount DESC, w.name_chosen_at, w.bid_id
  LOOP
    granted := jpegpe.hold_username(winner.username, winner.submission_id);
    INSERT INTO splash.lot_results(
      round_id, submission_id, bidder_count, winning_bid_id, winner_subject_id,
      amount, requested_username, username, name_outcome, claim_deadline
    ) VALUES (
      target_round_id, winner.submission_id, winner.bidders, winner.bid_id,
      winner.bidder_subject_id, winner.amount, winner.username,
      CASE WHEN granted THEN winner.username END,
      CASE
        WHEN granted THEN 'reserved'
        WHEN EXISTS (
          SELECT 1 FROM splash.lot_results AS r
          WHERE r.round_id = target_round_id AND lower(r.username) = lower(winner.username)
        ) THEN 'conflict'
        ELSE 'unavailable'
      END,
      -- The claim window is the next round: it ends 24 hours after this one.
      round.ends_at + interval '24 hours'
    );
    INSERT INTO splash.submission_events(submission_id, state)
      VALUES (winner.submission_id, 'won');
  END LOOP;
  -- Frogs without bids stay in the pond and join the next round.
  INSERT INTO splash.lot_results(round_id, submission_id, bidder_count)
    SELECT l.round_id, l.submission_id, 0 FROM splash.lots AS l
    WHERE l.round_id = target_round_id AND NOT EXISTS (
      SELECT 1 FROM splash.lot_results AS r
      WHERE r.round_id = l.round_id AND r.submission_id = l.submission_id
    );
  RETURN true;
END $$;

-- Results keep showing every decided frog, so its image stays public after the claim or burn.
CREATE OR REPLACE FUNCTION splash.submission_image(target_submission_id uuid)
RETURNS TABLE(content_type text, bytes bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT i.content_type, i.bytes FROM splash.submission_images AS i
  WHERE i.submission_id = target_submission_id
    AND splash.current_state(i.submission_id) IN ('in_pond', 'won', 'claimed', 'burned')
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA splash FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA splash FROM PUBLIC;
RESET ROLE;
