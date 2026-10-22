-- Lowest unique bids. JPEGPE uses 9 decimals (1e9 smallest units per token).
-- Admission only: existing staging bids remain valid for settlement.
SET LOCAL ROLE splash_owner;

-- Bid admission counts every attempt before validation, insertion or contention reads.
CREATE OR REPLACE FUNCTION splash.place_bid(target_submission_id uuid, bid_amount numeric, proposed_username text)
RETURNS TABLE(
  status text, bid_id bigint, round_id bigint, amount numeric, username text,
  placed_at timestamptz, name_contested boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  bidder uuid := identity.current_subject();
  lot_round_id bigint;
  round splash.rounds;
  previous splash.bids;
  placed splash.bids;
  now_at timestamptz;
  name_status text;
  retry integer;
BEGIN
  IF bidder IS NULL THEN
    RAISE EXCEPTION 'Verified subject required' USING ERRCODE = '28000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('splash.attempts', 0));
  DELETE FROM splash.attempt_budgets WHERE expires_at <= clock_timestamp();
  retry := splash.consume_attempt('bid:global', 200, 60);
  IF retry = 0 THEN
    retry := splash.consume_attempt('bid:' || bidder::text || ':' ||
      coalesce(target_submission_id::text, 'none'), 20, 60);
  END IF;
  IF retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited', NULL::bigint, NULL::bigint, NULL::numeric,
      NULL::text, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  IF bid_amount IS NULL OR bid_amount <= 0 OR mod(bid_amount, 1e9) <> 0
     OR bid_amount > 1329227995784915872903807060280344575 THEN
    RETURN QUERY SELECT 'invalid_amount', NULL::bigint, NULL::bigint, NULL::numeric,
      NULL::text, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  SELECT l.round_id INTO lot_round_id FROM splash.lots AS l
    WHERE l.submission_id = target_submission_id AND NOT EXISTS (
      SELECT 1 FROM splash.round_closures AS c WHERE c.round_id = l.round_id
    )
    ORDER BY l.round_id DESC LIMIT 1;
  IF lot_round_id IS NULL THEN
    RETURN QUERY SELECT 'not_on_auction', NULL::bigint, NULL::bigint, NULL::numeric,
      NULL::text, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  -- Shared lock: a closer waits for this bid; after a close this sees the closure.
  SELECT * INTO round FROM splash.rounds AS r WHERE r.round_id = lot_round_id FOR SHARE;
  now_at := clock_timestamp();
  IF now_at < round.starts_at OR now_at >= round.ends_at OR EXISTS (
    SELECT 1 FROM splash.round_closures AS c WHERE c.round_id = lot_round_id
  ) THEN
    RETURN QUERY SELECT 'round_closed', NULL::bigint, lot_round_id, NULL::numeric,
      NULL::text, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  IF splash.author_of(target_submission_id) = bidder THEN
    RETURN QUERY SELECT 'self_bid', NULL::bigint, lot_round_id, NULL::numeric,
      NULL::text, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  name_status := jpegpe.username_status(proposed_username);
  IF name_status <> 'available' THEN
    RETURN QUERY SELECT CASE name_status WHEN 'taken' THEN 'name_taken' ELSE 'invalid_name' END,
      NULL::bigint, lot_round_id, NULL::numeric, NULL::text, NULL::timestamptz, NULL::boolean;
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'splash.bid:' || lot_round_id::text || ':' || target_submission_id::text || ':' || bidder::text, 0));
  SELECT * INTO previous FROM splash.bids AS b
    WHERE b.round_id = lot_round_id AND b.submission_id = target_submission_id
      AND b.bidder_subject_id = bidder
    ORDER BY b.bid_id DESC LIMIT 1;
  now_at := clock_timestamp();
  INSERT INTO splash.bids AS b (
    round_id, submission_id, bidder_subject_id, amount, username, placed_at,
    amount_since, name_chosen_at
  ) VALUES (
    lot_round_id, target_submission_id, bidder, bid_amount, proposed_username, now_at,
    CASE WHEN previous.amount = bid_amount THEN previous.amount_since ELSE now_at END,
    CASE WHEN lower(previous.username) = lower(proposed_username) THEN previous.name_chosen_at ELSE now_at END
  ) RETURNING b.* INTO placed;
  RETURN QUERY SELECT 'placed', placed.bid_id, placed.round_id, placed.amount, placed.username,
    placed.placed_at, EXISTS (
      SELECT 1 FROM splash.active_bids(lot_round_id) AS other
      WHERE other.bidder_subject_id <> bidder
        AND lower(other.username) = lower(proposed_username)
    );
END $$;

-- Unsold frogs leave the pond but retain their public artwork and result.
ALTER TABLE splash.submission_events DROP CONSTRAINT submission_events_state_check;
ALTER TABLE splash.submission_events ADD CONSTRAINT submission_events_state_check
  CHECK (state IN ('in_pond', 'won', 'claimed', 'burned', 'archived'));
ALTER TABLE splash.lot_results DROP CONSTRAINT lot_results_check;
ALTER TABLE splash.lot_results ADD CONSTRAINT lot_results_check CHECK (
  (winning_bid_id IS NULL AND winner_subject_id IS NULL
    AND amount IS NULL AND requested_username IS NULL AND username IS NULL
    AND name_outcome IS NULL AND claim_deadline IS NULL)
  OR (winning_bid_id IS NOT NULL AND bidder_count > 0 AND winner_subject_id IS NOT NULL
    AND amount > 0 AND requested_username IS NOT NULL AND name_outcome IS NOT NULL
    AND claim_deadline IS NOT NULL
    AND (username IS NOT NULL) = (name_outcome = 'reserved'))
);

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
    WITH counted AS (
      SELECT b.*, count(*) OVER (PARTITION BY b.submission_id) AS bidders,
        count(*) OVER (PARTITION BY b.submission_id, b.amount) AS amount_count
      FROM splash.active_bids(target_round_id) AS b
    ), winners AS (
      SELECT DISTINCT ON (b.submission_id) b.* FROM counted AS b
      WHERE b.amount_count = 1
      ORDER BY b.submission_id, b.amount
    )
    SELECT * FROM winners AS w
    ORDER BY w.bidders DESC, w.amount, w.name_chosen_at, w.submission_id
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
  -- No unique amount (including no bids): archive, never carry over.
  INSERT INTO splash.lot_results(round_id, submission_id, bidder_count)
    SELECT l.round_id, l.submission_id,
      (SELECT count(*)::integer FROM splash.active_bids(target_round_id) AS b
        WHERE b.submission_id = l.submission_id)
    FROM splash.lots AS l
    WHERE l.round_id = target_round_id AND NOT EXISTS (
      SELECT 1 FROM splash.lot_results AS r
      WHERE r.round_id = l.round_id AND r.submission_id = l.submission_id
    );
  INSERT INTO splash.submission_events(submission_id, state)
    SELECT r.submission_id, 'archived' FROM splash.lot_results AS r
    WHERE r.round_id = target_round_id AND r.winning_bid_id IS NULL;
  RETURN true;
END $$;

-- Public pond contains counts only. Dropping is required to change the result type.
DROP FUNCTION splash.current_round();
CREATE FUNCTION splash.current_round()
RETURNS TABLE(
  round_id bigint, starts_at timestamptz, ends_at timestamptz, accepting_bids boolean,
  submission_id uuid, submitted_at timestamptz, width integer, height integer,
  background_removed boolean, author_frog_id uuid, author_username text,
  author_background_color text, author_accent_color text, bidder_count integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH round AS (
    SELECT r.* FROM splash.rounds AS r
    WHERE NOT EXISTS (SELECT 1 FROM splash.round_closures AS c WHERE c.round_id = r.round_id)
    ORDER BY r.starts_at DESC LIMIT 1
  )
  SELECT round.round_id, round.starts_at, round.ends_at,
    clock_timestamp() >= round.starts_at AND clock_timestamp() < round.ends_at,
    s.submission_id, s.submitted_at, i.width, i.height, i.background_removed,
    a.frog_id, a.username, a.background_color, a.accent_color,
    (SELECT count(*)::integer FROM splash.active_bids(round.round_id) AS b
      WHERE b.submission_id = l.submission_id)
  FROM round
  LEFT JOIN splash.lots AS l ON (l.round_id = round.round_id)
  LEFT JOIN splash.submissions AS s ON (s.submission_id = l.submission_id)
  LEFT JOIN splash.submission_images AS i ON (i.submission_id = l.submission_id)
  LEFT JOIN LATERAL jpegpe.public_profile_frog(s.author_subject_id) AS a ON true
  ORDER BY s.submitted_at, s.submission_id
$$;

DROP FUNCTION splash.my_bids();
CREATE FUNCTION splash.my_bids()
RETURNS TABLE(
  round_id bigint, submission_id uuid, amount numeric, username text,
  placed_at timestamptz, round_ends_at timestamptz, status text,
  granted_username text, name_outcome text, claim_deadline timestamptz, name_contested boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT mine.round_id, mine.submission_id, mine.amount, mine.username, mine.placed_at,
    r.ends_at,
    CASE WHEN res.round_id IS NULL THEN 'active'
      WHEN res.winner_subject_id = mine.bidder_subject_id THEN 'won' ELSE 'lost' END,
    CASE WHEN res.winner_subject_id = mine.bidder_subject_id THEN res.username END,
    CASE WHEN res.winner_subject_id = mine.bidder_subject_id THEN res.name_outcome END,
    CASE WHEN res.winner_subject_id = mine.bidder_subject_id THEN res.claim_deadline END,
    EXISTS (
      SELECT 1 FROM splash.active_bids(mine.round_id) AS other
      WHERE other.bidder_subject_id <> mine.bidder_subject_id
        AND lower(other.username) = lower(mine.username)
    )
  FROM (
    SELECT DISTINCT ON (b.round_id, b.submission_id) b.*
    FROM splash.bids AS b WHERE b.bidder_subject_id = identity.current_subject()
    ORDER BY b.round_id, b.submission_id, b.bid_id DESC
  ) AS mine
  JOIN splash.rounds AS r ON (r.round_id = mine.round_id)
  LEFT JOIN splash.lot_results AS res
    ON (res.round_id = mine.round_id AND res.submission_id = mine.submission_id)
  ORDER BY mine.round_id DESC, mine.placed_at DESC
  LIMIT 200
$$;

CREATE OR REPLACE FUNCTION splash.submission_image(target_submission_id uuid)
RETURNS TABLE(content_type text, bytes bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT i.content_type, i.bytes FROM splash.submission_images AS i
  WHERE i.submission_id = target_submission_id
    AND splash.current_state(i.submission_id) IN ('in_pond', 'won', 'claimed', 'burned', 'archived')
$$;

REVOKE ALL ON FUNCTION splash.current_round(), splash.my_bids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION splash.current_round(), splash.my_bids() TO splash_service;
RESET ROLE;
