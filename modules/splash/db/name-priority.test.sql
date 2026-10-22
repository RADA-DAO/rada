BEGIN;
CREATE FUNCTION pg_temp.check(value boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Name priority assertion failed: %', label; END IF; END $$;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(621001) AS author \gset
SELECT identity.resolve_telegram(621002) AS bidder_b \gset
SELECT identity.resolve_telegram(621003) AS bidder_c \gset
SELECT identity.resolve_telegram(621004) AS bidder_d \gset
RESET ROLE;
-- Deterministic ids exercise the final name priority, independent of bid id.
CREATE TEMP TABLE fixture_frogs(n integer, id uuid);
INSERT INTO fixture_frogs SELECT n,
  ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
  FROM generate_series(1, 8) n;
INSERT INTO splash.submissions(submission_id, author_subject_id)
  SELECT id, :'author' FROM fixture_frogs;
INSERT INTO splash.submission_events(submission_id, state)
  SELECT id, 'in_pond' FROM fixture_frogs;
INSERT INTO splash.rounds(starts_at, ends_at)
  VALUES (now() - interval '2 days', now() - interval '1 day')
  RETURNING round_id AS round \gset
INSERT INTO splash.lots SELECT :round, id FROM fixture_frogs;
-- Each pair requests one name; one criterion decides its priority.
-- Legacy smallest-unit rows deliberately remain settleable after migration.
INSERT INTO splash.bids(round_id, submission_id, bidder_subject_id, amount,
  username, placed_at, amount_since, name_chosen_at)
  SELECT :round, id, :'bidder_b', CASE n WHEN 1 THEN 1 WHEN 2 THEN 9
    WHEN 3 THEN 9 WHEN 4 THEN 1 ELSE 5 END,
    CASE WHEN n <= 2 THEN 'Competition' WHEN n <= 4 THEN 'Amount'
      WHEN n <= 6 THEN 'ChoiceTime' ELSE 'FrogId' END,
    now(), now(), CASE WHEN n = 6 THEN now() - interval '1 hour' ELSE now() END
  FROM fixture_frogs ORDER BY CASE n WHEN 7 THEN 8 WHEN 8 THEN 7 ELSE n END;
-- More competition beats the lower winning amount and earlier choice.
INSERT INTO splash.bids(round_id, submission_id, bidder_subject_id, amount,
  username, placed_at, amount_since, name_chosen_at)
  SELECT :round, id, :'bidder_c', 20, 'Other', now(), now(), now()
  FROM fixture_frogs WHERE n = 2;
-- In the final pair, frog 7 has the lower id despite frog 8's earlier bid id.
-- Frog 7 should get the name (all other criteria equal).
SELECT pg_temp.check(splash.close_round(:round), 'closed');
SELECT pg_temp.check((SELECT count(*) = 4 FROM splash.lot_results r
  JOIN fixture_frogs f ON f.id = r.submission_id
  WHERE f.n IN (2,4,6,7) AND r.name_outcome = 'reserved'), 'all priority criteria');
SELECT pg_temp.check((SELECT count(*) = 4 FROM splash.lot_results r
  JOIN fixture_frogs f ON f.id = r.submission_id
  WHERE f.n IN (1,3,5,8) AND r.name_outcome = 'conflict'
    AND r.winner_subject_id = :'bidder_b'), 'name losers still win frogs');
SELECT pg_temp.check((SELECT amount = 9 AND bidder_count = 2
  FROM splash.lot_results r JOIN fixture_frogs f ON f.id = r.submission_id
  WHERE f.n = 2), 'legacy non-whole bids settle');
ROLLBACK;
