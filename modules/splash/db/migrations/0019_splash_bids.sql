SET LOCAL ROLE splash_owner;

-- Places or replaces the caller's bid on a frog of the open round. Returns a
-- status instead of raising for expected refusals; nothing is written unless
-- status = 'placed'. A replacement may not lower the amount; the same amount is
-- accepted only with a different name.
CREATE FUNCTION splash.place_bid(target_submission_id uuid, bid_amount numeric, proposed_username text)
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
BEGIN
  IF bidder IS NULL THEN
    RAISE EXCEPTION 'Verified subject required' USING ERRCODE = '28000';
  END IF;
  IF bid_amount IS NULL OR bid_amount <= 0 OR bid_amount <> trunc(bid_amount)
     OR bid_amount >= 1e78 THEN
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
  IF previous.bid_id IS NOT NULL AND (bid_amount < previous.amount OR (
    bid_amount = previous.amount AND proposed_username = previous.username
  )) THEN
    RETURN QUERY SELECT CASE WHEN bid_amount < previous.amount THEN 'bid_too_low' ELSE 'bid_unchanged' END,
      previous.bid_id, lot_round_id, previous.amount, previous.username, previous.placed_at, NULL::boolean;
    RETURN;
  END IF;
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
      WHERE other.submission_id <> target_submission_id
        AND lower(other.username) = lower(proposed_username)
    );
END $$;

-- The latest unclosed round with its frogs. Per frog: the top amount, the number
-- of bidders, and the leader only through the public profile rule (a selected,
-- still-owned frog); otherwise null. A round without frogs yields one row with
-- a null submission_id.
CREATE FUNCTION splash.current_round()
RETURNS TABLE(
  round_id bigint, starts_at timestamptz, ends_at timestamptz, accepting_bids boolean,
  submission_id uuid, submitted_at timestamptz, width integer, height integer,
  background_removed boolean, author_frog_id uuid, author_username text,
  author_background_color text, author_accent_color text, top_amount numeric,
  bidder_count integer, leader_frog_id uuid, leader_username text,
  leader_background_color text, leader_accent_color text
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
    top.amount, coalesce(top.bidders, 0)::integer,
    p.frog_id, p.username, p.background_color, p.accent_color
  FROM round
  LEFT JOIN splash.lots AS l ON (l.round_id = round.round_id)
  LEFT JOIN splash.submissions AS s ON (s.submission_id = l.submission_id)
  LEFT JOIN splash.submission_images AS i ON (i.submission_id = l.submission_id)
  LEFT JOIN LATERAL jpegpe.public_profile_frog(s.author_subject_id) AS a ON true
  LEFT JOIN LATERAL (
    SELECT b.amount, b.bidder_subject_id, count(*) OVER () AS bidders
    FROM splash.active_bids(round.round_id) AS b
    WHERE b.submission_id = l.submission_id
    ORDER BY b.amount DESC, b.amount_since, b.bid_id LIMIT 1
  ) AS top ON true
  LEFT JOIN LATERAL jpegpe.public_profile_frog(top.bidder_subject_id) AS p ON true
  ORDER BY s.submitted_at, s.submission_id
$$;

-- The caller's active bid per lot (latest version), newest rounds first, with
-- the outcome once the round is closed.
CREATE FUNCTION splash.my_bids()
RETURNS TABLE(
  round_id bigint, submission_id uuid, amount numeric, username text,
  placed_at timestamptz, round_ends_at timestamptz, status text,
  granted_username text, name_outcome text, claim_deadline timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT mine.round_id, mine.submission_id, mine.amount, mine.username, mine.placed_at,
    r.ends_at,
    CASE WHEN res.round_id IS NULL THEN 'active'
      WHEN res.winner_subject_id = mine.bidder_subject_id THEN 'won' ELSE 'lost' END,
    CASE WHEN res.winner_subject_id = mine.bidder_subject_id THEN res.username END,
    CASE WHEN res.winner_subject_id = mine.bidder_subject_id THEN res.name_outcome END,
    CASE WHEN res.winner_subject_id = mine.bidder_subject_id THEN res.claim_deadline END
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

-- Public results of a closed round (no rows for unknown or unclosed rounds). The
-- winner appears only through the public profile rule; subject ids never do.
CREATE FUNCTION splash.round_results(target_round_id bigint)
RETURNS TABLE(
  round_id bigint, starts_at timestamptz, ends_at timestamptz, closed_at timestamptz,
  submission_id uuid, width integer, height integer, background_removed boolean,
  bidder_count integer, amount numeric, username text, name_outcome text,
  claim_deadline timestamptz, winner_frog_id uuid, winner_username text,
  winner_background_color text, winner_accent_color text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT r.round_id, r.starts_at, r.ends_at, c.closed_at, res.submission_id,
    i.width, i.height, i.background_removed, res.bidder_count, res.amount,
    res.username, res.name_outcome, res.claim_deadline,
    p.frog_id, p.username, p.background_color, p.accent_color
  FROM splash.round_closures AS c
  JOIN splash.rounds AS r ON (r.round_id = c.round_id)
  LEFT JOIN splash.lot_results AS res ON (res.round_id = c.round_id)
  LEFT JOIN splash.submission_images AS i ON (i.submission_id = res.submission_id)
  LEFT JOIN LATERAL jpegpe.public_profile_frog(res.winner_subject_id) AS p ON true
  WHERE c.round_id = target_round_id
  ORDER BY res.amount DESC NULLS LAST, res.submission_id
$$;

-- Server-side only, for the claim change: the pending win of a frog, if any.
CREATE FUNCTION splash.pending_claim(target_submission_id uuid)
RETURNS TABLE(
  round_id bigint, winner_subject_id uuid, amount numeric, username text,
  name_outcome text, claim_deadline timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT res.round_id, res.winner_subject_id, res.amount, res.username,
    res.name_outcome, res.claim_deadline
  FROM splash.lot_results AS res
  WHERE res.submission_id = target_submission_id AND res.winner_subject_id IS NOT NULL
    AND splash.current_state(target_submission_id) = 'won'
$$;

-- Won frogs keep a public image (results show them); other states stay private.
CREATE OR REPLACE FUNCTION splash.submission_image(target_submission_id uuid)
RETURNS TABLE(content_type text, bytes bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT i.content_type, i.bytes FROM splash.submission_images AS i
  WHERE i.submission_id = target_submission_id
    AND splash.current_state(i.submission_id) IN ('in_pond', 'won')
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA splash FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA splash FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  splash.place_bid(uuid, numeric, text),
  splash.current_round(),
  splash.my_bids(),
  splash.round_results(bigint),
  splash.pending_claim(uuid)
TO splash_service;
RESET ROLE;
