SET LOCAL ROLE splash_owner;

-- A frog that wins an auction leaves the pond. Claim and burn states come later.
ALTER TABLE splash.submission_events DROP CONSTRAINT submission_events_state_check;
ALTER TABLE splash.submission_events ADD CONSTRAINT submission_events_state_check
  CHECK (state IN ('in_pond', 'won'));

-- A 24-hour auction window. At most one round is unclosed at any time.
CREATE TABLE splash.rounds (
  round_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  starts_at timestamptz NOT NULL UNIQUE,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (ends_at > starts_at)
);

-- The frogs on auction in a round: those in the pond when the round started.
CREATE TABLE splash.lots (
  round_id bigint NOT NULL REFERENCES splash.rounds(round_id),
  submission_id uuid NOT NULL REFERENCES splash.submissions(submission_id),
  PRIMARY KEY (round_id, submission_id)
);
CREATE INDEX lots_submission ON splash.lots(submission_id, round_id DESC);

-- Every bid version is kept. A bidder's active bid on a lot is their latest row.
-- amount_since: when the bidder first offered the current amount (tie-break).
-- name_chosen_at: when the bidder first chose the current name (name conflicts).
CREATE TABLE splash.bids (
  bid_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id bigint NOT NULL,
  submission_id uuid NOT NULL,
  bidder_subject_id uuid NOT NULL,
  amount numeric(78, 0) NOT NULL CHECK (amount > 0),
  username text NOT NULL CHECK (char_length(username) BETWEEN 1 AND 32),
  placed_at timestamptz NOT NULL,
  amount_since timestamptz NOT NULL,
  name_chosen_at timestamptz NOT NULL,
  FOREIGN KEY (round_id, submission_id) REFERENCES splash.lots(round_id, submission_id),
  CHECK (amount_since <= placed_at AND name_chosen_at <= placed_at)
);
CREATE INDEX bids_latest ON splash.bids(round_id, submission_id, bidder_subject_id, bid_id DESC);
CREATE INDEX bids_bidder ON splash.bids(bidder_subject_id, round_id DESC);

-- One row per closed round; its primary key makes a second close impossible.
CREATE TABLE splash.round_closures (
  round_id bigint PRIMARY KEY REFERENCES splash.rounds(round_id),
  closed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The decision for every lot of a closed round, written once at close.
CREATE TABLE splash.lot_results (
  round_id bigint NOT NULL REFERENCES splash.round_closures(round_id),
  submission_id uuid NOT NULL,
  bidder_count integer NOT NULL CHECK (bidder_count >= 0),
  winning_bid_id bigint UNIQUE REFERENCES splash.bids(bid_id),
  winner_subject_id uuid,
  amount numeric(78, 0),
  requested_username text,
  username text,
  name_outcome text CHECK (name_outcome IN ('reserved', 'conflict', 'unavailable')),
  claim_deadline timestamptz,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (round_id, submission_id),
  FOREIGN KEY (round_id, submission_id) REFERENCES splash.lots(round_id, submission_id),
  CHECK (
    (winning_bid_id IS NULL AND bidder_count = 0 AND winner_subject_id IS NULL
      AND amount IS NULL AND requested_username IS NULL AND username IS NULL
      AND name_outcome IS NULL AND claim_deadline IS NULL)
    OR (winning_bid_id IS NOT NULL AND bidder_count > 0 AND winner_subject_id IS NOT NULL
      AND amount > 0 AND requested_username IS NOT NULL AND name_outcome IS NOT NULL
      AND claim_deadline IS NOT NULL
      AND (username IS NOT NULL) = (name_outcome = 'reserved'))
  )
);
CREATE INDEX lot_results_winner ON splash.lot_results(submission_id) WHERE winner_subject_id IS NOT NULL;

CREATE TRIGGER rounds_immutable BEFORE UPDATE OR DELETE ON splash.rounds
  FOR EACH ROW EXECUTE FUNCTION splash.reject_change();
CREATE TRIGGER lots_immutable BEFORE UPDATE OR DELETE ON splash.lots
  FOR EACH ROW EXECUTE FUNCTION splash.reject_change();
CREATE TRIGGER bids_immutable BEFORE UPDATE OR DELETE ON splash.bids
  FOR EACH ROW EXECUTE FUNCTION splash.reject_change();
CREATE TRIGGER round_closures_immutable BEFORE UPDATE OR DELETE ON splash.round_closures
  FOR EACH ROW EXECUTE FUNCTION splash.reject_change();
CREATE TRIGGER lot_results_immutable BEFORE UPDATE OR DELETE ON splash.lot_results
  FOR EACH ROW EXECUTE FUNCTION splash.reject_change();

ALTER TABLE splash.rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE splash.rounds FORCE ROW LEVEL SECURITY;
ALTER TABLE splash.lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE splash.lots FORCE ROW LEVEL SECURITY;
ALTER TABLE splash.bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE splash.bids FORCE ROW LEVEL SECURITY;
ALTER TABLE splash.round_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE splash.round_closures FORCE ROW LEVEL SECURITY;
ALTER TABLE splash.lot_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE splash.lot_results FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON splash.rounds TO splash_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON splash.lots TO splash_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON splash.bids TO splash_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON splash.round_closures TO splash_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON splash.lot_results TO splash_owner USING (true) WITH CHECK (true);

-- Internal: each bidder's latest bid version per lot of a round.
CREATE FUNCTION splash.active_bids(target_round_id bigint)
RETURNS SETOF splash.bids LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT DISTINCT ON (b.submission_id, b.bidder_subject_id) b.*
  FROM splash.bids AS b WHERE b.round_id = target_round_id
  ORDER BY b.submission_id, b.bidder_subject_id, b.bid_id DESC
$$;

-- Internal: closes one due round, once. The row lock waits for bids in flight
-- (they hold a share lock), and the closure primary key rejects a second close.
-- Winner per lot: highest amount; tie -> earliest amount_since, then lowest bid id.
-- Names: winners are taken in order of amount (higher first), then earlier
-- name_chosen_at, then bid id; each reserves its name in JPEGPE. A winner whose
-- name is already reserved keeps the frog and gets no name ('conflict'
-- if a winner of this round took it, otherwise 'unavailable').
CREATE FUNCTION splash.close_round(target_round_id bigint)
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
    granted := jpegpe.reserve_username(winner.username, winner.submission_id);
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

-- Internal: opens the round for the current UTC day when no round is unclosed.
-- Its lots are the frogs in the pond (with an image) submitted before it starts.
CREATE FUNCTION splash.open_current_round()
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  day_start timestamptz := date_trunc('day', clock_timestamp(), 'UTC');
  opens timestamptz;
  new_round_id bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM splash.rounds AS r
    WHERE NOT EXISTS (SELECT 1 FROM splash.round_closures AS c WHERE c.round_id = r.round_id)
  ) THEN
    RETURN;
  END IF;
  SELECT greatest(day_start, coalesce(max(r.ends_at), day_start)) INTO opens FROM splash.rounds AS r;
  INSERT INTO splash.rounds AS r (starts_at, ends_at)
    VALUES (opens, day_start + interval '24 hours') RETURNING r.round_id INTO new_round_id;
  INSERT INTO splash.lots(round_id, submission_id)
    SELECT new_round_id, s.submission_id FROM splash.submissions AS s
    JOIN splash.submission_images AS i USING (submission_id)
    WHERE s.submitted_at < opens AND splash.current_state(s.submission_id) = 'in_pond';
END $$;

-- The round job: closes every due round in order, then opens the current one.
-- The advisory lock serialises concurrent callers; returns rounds closed now.
CREATE FUNCTION splash.advance_rounds()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  due bigint;
  closed integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('splash.rounds', 0));
  FOR due IN
    SELECT r.round_id FROM splash.rounds AS r
    WHERE r.ends_at <= clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM splash.round_closures AS c WHERE c.round_id = r.round_id)
    ORDER BY r.starts_at
  LOOP
    IF splash.close_round(due) THEN closed := closed + 1; END IF;
  END LOOP;
  PERFORM splash.open_current_round();
  RETURN closed;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA splash FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA splash FROM PUBLIC;
GRANT EXECUTE ON FUNCTION splash.advance_rounds() TO splash_service;
RESET ROLE;
