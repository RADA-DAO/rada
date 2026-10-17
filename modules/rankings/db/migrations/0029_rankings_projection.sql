SET LOCAL ROLE rankings_owner;
CREATE TABLE rankings.balances (
  subject_id uuid NOT NULL,
  frog_id uuid NOT NULL,
  link_version text NOT NULL,
  token text NOT NULL CHECK (token IN ('TON', 'JPEGPE')),
  amount numeric NOT NULL CHECK (amount >= 0 AND amount = trunc(amount)),
  as_of timestamptz NOT NULL,
  PRIMARY KEY(subject_id, token)
);
CREATE TABLE rankings.state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO rankings.state DEFAULT VALUES;
REVOKE ALL ON ALL TABLES IN SCHEMA rankings FROM PUBLIC;
CREATE FUNCTION rankings.prune() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM rankings.balances b WHERE NOT EXISTS (
    SELECT FROM identity.holder_profiles() p WHERE p.subject_id = b.subject_id
      AND p.frog_id = b.frog_id AND p.link_version = b.link_version);
  UPDATE rankings.state SET revision = revision + 1;
END $$;
CREATE FUNCTION rankings.record(p_subject uuid, p_frog uuid, p_version text,
  p_token text, p_amount text, p_as_of timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_amount !~ '^[0-9]{1,82}$' OR p_as_of IS NULL OR p_as_of > now() THEN
    RAISE EXCEPTION 'Invalid balance' USING ERRCODE = '22023';
  END IF;
  INSERT INTO rankings.balances
    SELECT p.subject_id, p.frog_id, p.link_version, p_token, p_amount::numeric, p_as_of
    FROM identity.holder_profiles() p WHERE p.subject_id = p_subject
      AND p.frog_id = p_frog AND p.link_version = p_version
    ON CONFLICT(subject_id, token) DO UPDATE SET frog_id = EXCLUDED.frog_id,
      link_version = EXCLUDED.link_version, amount = EXCLUDED.amount, as_of = EXCLUDED.as_of;
  UPDATE rankings.state SET revision = revision + 1;
END $$;
CREATE FUNCTION rankings.holders(p_token text, p_limit integer, p_offset integer, p_revision text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE revision text; entries jsonb;
BEGIN
  IF p_token NOT IN ('TON', 'JPEGPE') OR p_limit NOT BETWEEN 1 AND 100
    OR p_offset NOT BETWEEN 0 AND 1000000 THEN
    RAISE EXCEPTION 'Invalid page' USING ERRCODE = '22023';
  END IF;
  SELECT md5(s.revision::text || coalesce((SELECT string_agg(
    p.frog_id::text || p.link_version, ',' ORDER BY p.frog_id)
    FROM identity.holder_profiles() p), '')) INTO revision FROM rankings.state s;
  IF p_revision IS NOT NULL AND p_revision <> revision THEN RETURN NULL; END IF;
  WITH ordered AS (
    SELECT row_number() OVER (ORDER BY b.amount DESC, p.verified_at, b.frog_id) AS rank,
      b.frog_id, p.username, b.amount, b.as_of
    FROM rankings.balances b JOIN identity.holder_profiles() p
      ON (p.subject_id = b.subject_id AND p.frog_id = b.frog_id AND p.link_version = b.link_version)
    WHERE b.token = p_token
  ), page AS (SELECT * FROM ordered ORDER BY rank LIMIT p_limit + 1 OFFSET p_offset)
  SELECT coalesce(jsonb_agg(jsonb_build_object('rank', rank, 'frogId', frog_id,
    'frogName', username, 'amount', amount::text, 'asOf', as_of,
    'stale', as_of < now() - interval '6 hours') ORDER BY rank), '[]'::jsonb)
  INTO entries FROM page;
  RETURN jsonb_build_object('revision', revision, 'entries', entries);
END $$;
REVOKE ALL ON FUNCTION rankings.prune(), rankings.record(uuid, uuid, text, text, text, timestamptz),
  rankings.holders(text, integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rankings.prune(), rankings.record(uuid, uuid, text, text, text, timestamptz) TO rankings_worker;
GRANT EXECUTE ON FUNCTION rankings.holders(text, integer, integer, text) TO rankings_service;
RESET ROLE;
