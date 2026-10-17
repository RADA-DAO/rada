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
  IF bid_amount IS NULL OR bid_amount <= 0 OR bid_amount <> trunc(bid_amount)
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
  IF previous.bid_id IS NOT NULL AND (bid_amount < previous.amount OR (
    bid_amount = previous.amount AND lower(proposed_username) = lower(previous.username)
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

RESET ROLE;
