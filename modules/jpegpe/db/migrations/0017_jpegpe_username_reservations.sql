SET LOCAL ROLE jpegpe_owner;
-- Frog usernames are one platform-wide, case-insensitive namespace owned by JPEGPE.
-- A reservation holds a username for a frog that does not exist yet (for example
-- a SPLASH auction win awaiting its claim). It is permanent: the name is never
-- released, and only a frog created with the reserved frog id may use it.
CREATE TABLE jpegpe.username_reservations (
  username_key text PRIMARY KEY CHECK (username_key = lower(username)),
  username text NOT NULL CHECK (username ~ '^[a-zA-Z][a-zA-Z0-9_]{0,31}$'),
  frog_id uuid NOT NULL UNIQUE,
  reserved_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION jpegpe.immutable_username_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Username reservations are permanent' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER username_reservations_immutable BEFORE UPDATE OR DELETE ON jpegpe.username_reservations
  FOR EACH ROW EXECUTE FUNCTION jpegpe.immutable_username_reservation();
ALTER TABLE jpegpe.username_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE jpegpe.username_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON jpegpe.username_reservations TO jpegpe_owner USING (true) WITH CHECK (true);

-- 'invalid' (format), 'taken' (an existing frog or a reservation) or 'available'.
CREATE FUNCTION jpegpe.username_status(candidate text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN candidate IS NULL OR candidate !~ '^[a-zA-Z][a-zA-Z0-9_]{0,31}$' THEN 'invalid'
    WHEN EXISTS (SELECT 1 FROM jpegpe.frogs AS f WHERE lower(f.username) = lower(candidate))
      OR EXISTS (SELECT 1 FROM jpegpe.username_reservations AS r WHERE r.username_key = lower(candidate))
      THEN 'taken'
    ELSE 'available'
  END
$$;

-- Reserves an available username for a future frog id. Returns false when the
-- name is invalid or taken, or the frog id already holds a reservation. The
-- advisory lock is shared with create_frog, so the two cannot race.
CREATE FUNCTION jpegpe.reserve_username(candidate text, future_frog_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF future_frog_id IS NULL OR jpegpe.username_status(candidate) <> 'available' THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('jpegpe.username:' || lower(candidate), 0));
  IF jpegpe.username_status(candidate) <> 'available' OR EXISTS (
    SELECT 1 FROM jpegpe.username_reservations AS r WHERE r.frog_id = future_frog_id
  ) THEN
    RETURN false;
  END IF;
  INSERT INTO jpegpe.username_reservations(username_key, username, frog_id)
    VALUES (lower(candidate), candidate, future_frog_id);
  RETURN true;
END $$;

-- Same behaviour as before, plus: a reserved username belongs to its reserved frog id.
CREATE OR REPLACE FUNCTION jpegpe.create_frog(
  new_frog_id uuid, new_username text, creator_id uuid,
  new_background_color text DEFAULT NULL, new_accent_color text DEFAULT NULL,
  new_background_proof jsonb DEFAULT NULL, new_accent_proof jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('jpegpe.username:' || lower(new_username), 0));
  IF EXISTS (
    SELECT 1 FROM jpegpe.username_reservations AS r
    WHERE r.username_key = lower(new_username) AND r.frog_id <> new_frog_id
  ) THEN
    RAISE EXCEPTION 'Username is reserved' USING ERRCODE = '23505';
  END IF;
  INSERT INTO jpegpe.frogs (
    frog_id, username, creator_subject_id, current_owner_subject_id,
    background_color, accent_color, background_proof, accent_proof
  ) VALUES (
    new_frog_id, new_username, creator_id, creator_id,
    new_background_color, new_accent_color, new_background_proof, new_accent_proof
  );
  INSERT INTO jpegpe.ownership_events(frog_id, from_subject_id, to_subject_id)
    VALUES (new_frog_id, NULL, creator_id);
END $$;

REVOKE ALL ON FUNCTION jpegpe.immutable_username_reservation(),
  jpegpe.username_status(text), jpegpe.reserve_username(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jpegpe.username_status(text), jpegpe.reserve_username(text, uuid)
  TO splash_owner;
RESET ROLE;
