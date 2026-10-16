SET LOCAL ROLE jpegpe_owner;
-- A username hold keeps a name for a frog that does not exist yet (a SPLASH win
-- awaiting its paid claim). A hold ends exactly once: 'confirmed' when the frog
-- is issued under the name (frog usernames are immutable, so it is permanent),
-- or 'released' when the claim fails and the name becomes available again.
-- Both tables are append-only. This replaces the permanent reservations.
CREATE TABLE jpegpe.username_holds (
  hold_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username_key text NOT NULL CHECK (username_key = lower(username)),
  username text NOT NULL CHECK (username ~ '^[a-zA-Z][a-zA-Z0-9_]{0,31}$'),
  frog_id uuid NOT NULL,
  held_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX username_holds_key ON jpegpe.username_holds(username_key);
CREATE INDEX username_holds_frog ON jpegpe.username_holds(frog_id);
CREATE TABLE jpegpe.username_hold_ends (
  hold_id bigint PRIMARY KEY REFERENCES jpegpe.username_holds(hold_id),
  outcome text NOT NULL CHECK (outcome IN ('confirmed', 'released')),
  ended_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION jpegpe.immutable_username_hold() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Username hold history is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER username_holds_immutable BEFORE UPDATE OR DELETE ON jpegpe.username_holds
  FOR EACH ROW EXECUTE FUNCTION jpegpe.immutable_username_hold();
CREATE TRIGGER username_hold_ends_immutable BEFORE UPDATE OR DELETE ON jpegpe.username_hold_ends
  FOR EACH ROW EXECUTE FUNCTION jpegpe.immutable_username_hold();
ALTER TABLE jpegpe.username_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE jpegpe.username_holds FORCE ROW LEVEL SECURITY;
ALTER TABLE jpegpe.username_hold_ends ENABLE ROW LEVEL SECURITY;
ALTER TABLE jpegpe.username_hold_ends FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON jpegpe.username_holds TO jpegpe_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON jpegpe.username_hold_ends TO jpegpe_owner USING (true) WITH CHECK (true);

-- Earlier reservations (SPLASH wins before this change) become holds, keeping
-- their time; a reservation whose frog already exists is a confirmed hold.
INSERT INTO jpegpe.username_holds(username_key, username, frog_id, held_at)
  SELECT r.username_key, r.username, r.frog_id, r.reserved_at
  FROM jpegpe.username_reservations AS r ORDER BY r.reserved_at, r.username_key;
INSERT INTO jpegpe.username_hold_ends(hold_id, outcome)
  SELECT h.hold_id, 'confirmed' FROM jpegpe.username_holds AS h
  WHERE EXISTS (SELECT 1 FROM jpegpe.frogs AS f WHERE f.frog_id = h.frog_id);
DROP FUNCTION jpegpe.reserve_username(text, uuid);
DROP TABLE jpegpe.username_reservations;
DROP FUNCTION jpegpe.immutable_username_reservation();

-- The active (not yet ended) hold of a frog id, or null.
CREATE FUNCTION jpegpe.held_username(future_frog_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT h.username FROM jpegpe.username_holds AS h
  WHERE h.frog_id = future_frog_id
    AND NOT EXISTS (SELECT 1 FROM jpegpe.username_hold_ends AS e WHERE e.hold_id = h.hold_id)
  ORDER BY h.hold_id DESC LIMIT 1
$$;

-- 'invalid' (format), 'taken' (an existing frog or an active hold) or 'available'.
CREATE OR REPLACE FUNCTION jpegpe.username_status(candidate text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN candidate IS NULL OR candidate !~ '^[a-zA-Z][a-zA-Z0-9_]{0,31}$' THEN 'invalid'
    WHEN EXISTS (SELECT 1 FROM jpegpe.frogs AS f WHERE lower(f.username) = lower(candidate))
      OR EXISTS (
        SELECT 1 FROM jpegpe.username_holds AS h
        WHERE h.username_key = lower(candidate) AND NOT EXISTS (
          SELECT 1 FROM jpegpe.username_hold_ends AS e WHERE e.hold_id = h.hold_id
        )
      )
      THEN 'taken'
    ELSE 'available'
  END
$$;

-- Holds an available username for a future frog id. Returns false when the name
-- is invalid or taken, the frog exists, or the frog id already holds a name.
-- Lock order everywhere: name, then frog id.
CREATE FUNCTION jpegpe.hold_username(candidate text, future_frog_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF future_frog_id IS NULL OR jpegpe.username_status(candidate) <> 'available' THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('jpegpe.username:' || lower(candidate), 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('jpegpe.hold:' || future_frog_id::text, 0));
  IF jpegpe.username_status(candidate) <> 'available'
     OR jpegpe.held_username(future_frog_id) IS NOT NULL
     OR EXISTS (SELECT 1 FROM jpegpe.frogs AS f WHERE f.frog_id = future_frog_id) THEN
    RETURN false;
  END IF;
  INSERT INTO jpegpe.username_holds(username_key, username, frog_id)
    VALUES (lower(candidate), candidate, future_frog_id);
  RETURN true;
END $$;

-- Ends the active hold of a frog id as released; the name is available again.
-- Returns false when the frog id holds no name.
CREATE FUNCTION jpegpe.release_username(future_frog_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE held bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('jpegpe.hold:' || future_frog_id::text, 0));
  SELECT h.hold_id INTO held FROM jpegpe.username_holds AS h
    WHERE h.frog_id = future_frog_id AND NOT EXISTS (
      SELECT 1 FROM jpegpe.username_hold_ends AS e WHERE e.hold_id = h.hold_id
    );
  IF held IS NULL THEN RETURN false; END IF;
  INSERT INTO jpegpe.username_hold_ends(hold_id, outcome) VALUES (held, 'released');
  RETURN true;
END $$;

-- Issues the frog under its held name (the hold becomes confirmed): created by
-- the creator and transferred to the owner, both recorded as ownership events.
-- Colours and their Color Drop proofs are stored with the frog. Returns the name.
CREATE FUNCTION jpegpe.issue_frog(
  new_frog_id uuid, creator_id uuid, owner_id uuid,
  new_background_color text, new_accent_color text,
  new_background_proof jsonb, new_accent_proof jsonb
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  held_name text := jpegpe.held_username(new_frog_id);
  hold jpegpe.username_holds;
BEGIN
  IF held_name IS NULL OR creator_id IS NULL OR owner_id IS NULL OR creator_id = owner_id THEN
    RAISE EXCEPTION 'Invalid frog issue' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('jpegpe.username:' || lower(held_name), 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('jpegpe.hold:' || new_frog_id::text, 0));
  SELECT h.* INTO hold FROM jpegpe.username_holds AS h
    WHERE h.frog_id = new_frog_id AND NOT EXISTS (
      SELECT 1 FROM jpegpe.username_hold_ends AS e WHERE e.hold_id = h.hold_id
    );
  IF hold.hold_id IS NULL OR hold.username_key <> lower(held_name) THEN
    RAISE EXCEPTION 'Invalid frog issue' USING ERRCODE = '22023';
  END IF;
  INSERT INTO jpegpe.username_hold_ends(hold_id, outcome) VALUES (hold.hold_id, 'confirmed');
  INSERT INTO jpegpe.frogs (
    frog_id, username, creator_subject_id, current_owner_subject_id,
    background_color, accent_color, background_proof, accent_proof
  ) VALUES (
    new_frog_id, hold.username, creator_id, owner_id,
    new_background_color, new_accent_color, new_background_proof, new_accent_proof
  );
  INSERT INTO jpegpe.ownership_events(frog_id, from_subject_id, to_subject_id)
    VALUES (new_frog_id, NULL, creator_id), (new_frog_id, creator_id, owner_id);
  RETURN hold.username;
END $$;

-- Same behaviour as before, except that an actively held name is issued only
-- through jpegpe.issue_frog.
CREATE OR REPLACE FUNCTION jpegpe.create_frog(
  new_frog_id uuid, new_username text, creator_id uuid,
  new_background_color text DEFAULT NULL, new_accent_color text DEFAULT NULL,
  new_background_proof jsonb DEFAULT NULL, new_accent_proof jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('jpegpe.username:' || lower(new_username), 0));
  IF EXISTS (
    SELECT 1 FROM jpegpe.username_holds AS h
    WHERE h.username_key = lower(new_username) AND NOT EXISTS (
      SELECT 1 FROM jpegpe.username_hold_ends AS e WHERE e.hold_id = h.hold_id
    )
  ) THEN
    RAISE EXCEPTION 'Username is held' USING ERRCODE = '23505';
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

REVOKE ALL ON FUNCTION jpegpe.immutable_username_hold(), jpegpe.held_username(uuid),
  jpegpe.username_status(text), jpegpe.hold_username(text, uuid),
  jpegpe.release_username(uuid),
  jpegpe.issue_frog(uuid, uuid, uuid, text, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jpegpe.held_username(uuid), jpegpe.username_status(text),
  jpegpe.hold_username(text, uuid), jpegpe.release_username(uuid),
  jpegpe.issue_frog(uuid, uuid, uuid, text, text, jsonb, jsonb)
  TO splash_owner;
RESET ROLE;
