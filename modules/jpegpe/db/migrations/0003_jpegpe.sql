CREATE ROLE jpegpe_owner NOLOGIN;
CREATE ROLE jpegpe_service NOLOGIN;
CREATE ROLE jpegpe_operator NOLOGIN;
CREATE SCHEMA jpegpe AUTHORIZATION jpegpe_owner;
GRANT USAGE ON SCHEMA identity TO jpegpe_owner;
GRANT REFERENCES (subject_id) ON identity.subjects TO jpegpe_owner;
SET LOCAL ROLE jpegpe_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE jpegpe.frogs (
  frog_id uuid PRIMARY KEY,
  username text NOT NULL CHECK (username ~ '^[a-zA-Z][a-zA-Z0-9_]{0,31}$'),
  creator_subject_id uuid NOT NULL REFERENCES identity.subjects(subject_id),
  current_owner_subject_id uuid NOT NULL REFERENCES identity.subjects(subject_id),
  background_color text CHECK (background_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color text CHECK (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  background_proof jsonb,
  accent_proof jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (background_proof IS NULL OR jsonb_typeof(background_proof) = 'object'),
  CHECK (accent_proof IS NULL OR jsonb_typeof(accent_proof) = 'object')
);
CREATE UNIQUE INDEX frogs_username_casefold_unique ON jpegpe.frogs (lower(username));
CREATE INDEX frogs_current_owner_idx ON jpegpe.frogs (current_owner_subject_id);
CREATE FUNCTION jpegpe.immutable_frog_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.frog_id IS DISTINCT FROM OLD.frog_id
     OR NEW.username IS DISTINCT FROM OLD.username
     OR NEW.creator_subject_id IS DISTINCT FROM OLD.creator_subject_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Frog identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER frog_identity_immutable BEFORE UPDATE ON jpegpe.frogs
  FOR EACH ROW EXECUTE FUNCTION jpegpe.immutable_frog_identity();

CREATE TABLE jpegpe.ownership_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  frog_id uuid NOT NULL REFERENCES jpegpe.frogs(frog_id),
  from_subject_id uuid REFERENCES identity.subjects(subject_id),
  to_subject_id uuid NOT NULL REFERENCES identity.subjects(subject_id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_subject_id IS DISTINCT FROM to_subject_id)
);
CREATE INDEX ownership_events_frog_idx ON jpegpe.ownership_events(frog_id, event_id);

CREATE FUNCTION jpegpe.immutable_ownership_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Ownership history is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER ownership_events_immutable BEFORE UPDATE OR DELETE ON jpegpe.ownership_events
  FOR EACH ROW EXECUTE FUNCTION jpegpe.immutable_ownership_event();

CREATE FUNCTION jpegpe.create_frog(
  new_frog_id uuid, new_username text, creator_id uuid,
  new_background_color text DEFAULT NULL, new_accent_color text DEFAULT NULL,
  new_background_proof jsonb DEFAULT NULL, new_accent_proof jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
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

CREATE FUNCTION jpegpe.transfer_frog(target_frog_id uuid, expected_owner_id uuid, recipient_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actual_owner uuid;
BEGIN
  SELECT current_owner_subject_id INTO actual_owner FROM jpegpe.frogs
    WHERE frog_id = target_frog_id FOR UPDATE;
  IF actual_owner IS NULL OR actual_owner <> expected_owner_id OR recipient_id IS NULL
     OR recipient_id = actual_owner THEN
    RAISE EXCEPTION 'Invalid ownership transfer' USING ERRCODE = '22023';
  END IF;
  INSERT INTO jpegpe.ownership_events(frog_id, from_subject_id, to_subject_id)
    VALUES (target_frog_id, actual_owner, recipient_id);
  UPDATE jpegpe.frogs SET current_owner_subject_id = recipient_id
    WHERE frog_id = target_frog_id;
  PERFORM identity.clear_selected_frog(target_frog_id, actual_owner);
END $$;


CREATE FUNCTION jpegpe.is_current_owner(target_frog_id uuid, target_subject_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE owns boolean;
BEGIN
  SELECT true INTO owns FROM jpegpe.frogs
    WHERE frog_id = target_frog_id AND current_owner_subject_id = target_subject_id
    FOR UPDATE;
  RETURN coalesce(owns, false);
END $$;

CREATE FUNCTION jpegpe.own_public_frog(target_frog_id uuid)
RETURNS TABLE(frog_id uuid, username text, background_color text, accent_color text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT f.frog_id, f.username, f.background_color, f.accent_color
  FROM jpegpe.frogs AS f
  WHERE f.frog_id = target_frog_id
    AND f.current_owner_subject_id = identity.current_subject()
$$;

ALTER TABLE jpegpe.frogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jpegpe.frogs FORCE ROW LEVEL SECURITY;
ALTER TABLE jpegpe.ownership_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE jpegpe.ownership_events FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON jpegpe.frogs TO jpegpe_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON jpegpe.ownership_events TO jpegpe_owner USING (true) WITH CHECK (true);
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA jpegpe FROM PUBLIC;
GRANT USAGE ON SCHEMA jpegpe TO jpegpe_service, jpegpe_operator, identity_service;
GRANT EXECUTE ON FUNCTION jpegpe.own_public_frog(uuid) TO jpegpe_service, identity_service;
GRANT EXECUTE ON FUNCTION jpegpe.create_frog(uuid,text,uuid,text,text,jsonb,jsonb),
  jpegpe.transfer_frog(uuid,uuid,uuid) TO jpegpe_operator;
GRANT REFERENCES (frog_id) ON jpegpe.frogs TO identity_owner;
GRANT USAGE ON SCHEMA jpegpe TO identity_owner;
RESET ROLE;

SET LOCAL ROLE identity_owner;
ALTER TABLE identity.subjects ADD CONSTRAINT selected_frog_fk
  FOREIGN KEY (selected_frog_id) REFERENCES jpegpe.frogs(frog_id);
CREATE FUNCTION identity.clear_selected_frog(target_frog_id uuid, prior_owner_id uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE identity.subjects SET selected_frog_id = NULL
  WHERE subject_id = prior_owner_id AND selected_frog_id = target_frog_id
$$;
CREATE FUNCTION identity.select_frog(target_frog_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE subject uuid := identity.current_subject();
BEGIN
  IF subject IS NULL THEN RETURN false; END IF;
  IF target_frog_id IS NOT NULL AND NOT jpegpe.is_current_owner(target_frog_id, subject) THEN
    RETURN false;
  END IF;
  UPDATE identity.subjects SET selected_frog_id = target_frog_id WHERE subject_id = subject;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION identity.clear_selected_frog(uuid,uuid), identity.select_frog(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.clear_selected_frog(uuid,uuid) TO jpegpe_owner;
GRANT EXECUTE ON FUNCTION identity.select_frog(uuid) TO identity_service;
RESET ROLE;
GRANT USAGE ON SCHEMA identity TO jpegpe_owner;
GRANT EXECUTE ON FUNCTION identity.current_subject() TO jpegpe_owner;
GRANT EXECUTE ON FUNCTION jpegpe.is_current_owner(uuid,uuid) TO identity_owner;
