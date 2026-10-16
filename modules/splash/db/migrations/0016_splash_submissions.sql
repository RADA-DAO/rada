CREATE ROLE splash_owner NOLOGIN;
CREATE ROLE splash_service NOLOGIN;
CREATE SCHEMA splash AUTHORIZATION splash_owner;
-- Published interfaces of other modules; no table access is granted.
GRANT USAGE ON SCHEMA identity, jpegpe TO splash_owner;
GRANT EXECUTE ON FUNCTION identity.current_subject() TO splash_owner;
GRANT EXECUTE ON FUNCTION jpegpe.public_profile_frog(uuid) TO splash_owner;
SET LOCAL ROLE splash_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- One row per submitted frog. The author is only a subject id (no personal data).
CREATE TABLE splash.submissions (
  submission_id uuid PRIMARY KEY,
  author_subject_id uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX submissions_author_time ON splash.submissions(author_subject_id, submitted_at);

-- Image bytes live here for now; splash.submission_image() is the only reader,
-- so moving them to object storage changes this table and that function only.
CREATE TABLE splash.submission_images (
  submission_id uuid PRIMARY KEY REFERENCES splash.submissions(submission_id),
  sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL CHECK (content_type = 'image/png'),
  width integer NOT NULL CHECK (width BETWEEN 32 AND 2048),
  height integer NOT NULL CHECK (height BETWEEN 32 AND 2048),
  background_removed boolean NOT NULL,
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 4194304)
);

-- Append-only state history; the current state is the latest event.
CREATE TABLE splash.submission_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES splash.submissions(submission_id),
  state text NOT NULL CHECK (state IN ('in_pond')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX submission_events_latest ON splash.submission_events(submission_id, event_id DESC);

CREATE FUNCTION splash.reject_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Submission history is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER submissions_immutable BEFORE UPDATE OR DELETE ON splash.submissions
  FOR EACH ROW EXECUTE FUNCTION splash.reject_change();
CREATE TRIGGER submission_images_immutable BEFORE UPDATE OR DELETE ON splash.submission_images
  FOR EACH ROW EXECUTE FUNCTION splash.reject_change();
CREATE TRIGGER submission_events_immutable BEFORE UPDATE OR DELETE ON splash.submission_events
  FOR EACH ROW EXECUTE FUNCTION splash.reject_change();

ALTER TABLE splash.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE splash.submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE splash.submission_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE splash.submission_images FORCE ROW LEVEL SECURITY;
ALTER TABLE splash.submission_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE splash.submission_events FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON splash.submissions TO splash_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON splash.submission_images TO splash_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON splash.submission_events TO splash_owner USING (true) WITH CHECK (true);

-- Internal helper, not granted to any login.
CREATE FUNCTION splash.current_state(target_submission_id uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT e.state FROM splash.submission_events AS e
  WHERE e.submission_id = target_submission_id ORDER BY e.event_id DESC LIMIT 1
$$;

-- Rate limit: at most 5 submissions per author in any rolling 24 hours. The
-- advisory lock serialises one author's submissions so concurrent requests
-- cannot exceed it. A refused call inserts nothing and returns the wait time.
CREATE FUNCTION splash.submit_frog(new_submission_id uuid)
RETURNS TABLE(accepted_at timestamptz, retry_after_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  author uuid := identity.current_subject();
  recent integer;
  oldest timestamptz;
BEGIN
  IF author IS NULL THEN
    RAISE EXCEPTION 'Verified subject required' USING ERRCODE = '28000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('splash.submit:' || author::text, 0));
  SELECT count(*), min(s.submitted_at) INTO recent, oldest FROM splash.submissions AS s
    WHERE s.author_subject_id = author AND s.submitted_at > now() - interval '24 hours';
  IF recent >= 5 THEN
    RETURN QUERY SELECT NULL::timestamptz,
      greatest(1, ceil(extract(epoch FROM (oldest + interval '24 hours' - now())))::integer);
    RETURN;
  END IF;
  INSERT INTO splash.submissions AS sub (submission_id, author_subject_id)
    VALUES (new_submission_id, author) RETURNING sub.submitted_at INTO oldest;
  INSERT INTO splash.submission_events(submission_id, state) VALUES (new_submission_id, 'in_pond');
  RETURN QUERY SELECT oldest, 0;
END $$;

-- Attaches the processed image to the caller's own submission, once. A repeated
-- image (same sha256) is a unique violation; the whole transaction then rolls back.
CREATE FUNCTION splash.store_image(
  target_submission_id uuid, image_sha256 text, image_width integer,
  image_height integer, was_background_removed boolean, image_bytes bytea
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM splash.submissions AS s
    WHERE s.submission_id = target_submission_id
      AND s.author_subject_id = identity.current_subject()
  ) THEN
    RAISE EXCEPTION 'Not the author of this submission' USING ERRCODE = '42501';
  END IF;
  INSERT INTO splash.submission_images(
    submission_id, sha256, content_type, width, height, background_removed, bytes
  ) VALUES (
    target_submission_id, image_sha256, 'image/png', image_width, image_height,
    was_background_removed, image_bytes
  );
END $$;

-- Public pond: frogs in the pond, newest first. Author identity is shown only
-- through JPEGPE's public profile projection (the selected frog), never a subject id.
CREATE FUNCTION splash.pond(max_rows integer DEFAULT 100)
RETURNS TABLE(
  submission_id uuid, submitted_at timestamptz, width integer, height integer,
  background_removed boolean, author_frog_id uuid, author_username text,
  author_background_color text, author_accent_color text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.submission_id, s.submitted_at, i.width, i.height, i.background_removed,
    p.frog_id, p.username, p.background_color, p.accent_color
  FROM splash.submissions AS s
  JOIN splash.submission_images AS i USING (submission_id)
  LEFT JOIN LATERAL jpegpe.public_profile_frog(s.author_subject_id) AS p ON true
  WHERE splash.current_state(s.submission_id) = 'in_pond'
  ORDER BY s.submitted_at DESC, s.submission_id
  LIMIT least(greatest(max_rows, 1), 100)
$$;

CREATE FUNCTION splash.my_submissions()
RETURNS TABLE(
  submission_id uuid, state text, submitted_at timestamptz, width integer,
  height integer, background_removed boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.submission_id, splash.current_state(s.submission_id), s.submitted_at,
    i.width, i.height, i.background_removed
  FROM splash.submissions AS s
  JOIN splash.submission_images AS i USING (submission_id)
  WHERE s.author_subject_id = identity.current_subject()
  ORDER BY s.submitted_at DESC, s.submission_id
$$;

-- Only frogs in the pond have a public image.
CREATE FUNCTION splash.submission_image(target_submission_id uuid)
RETURNS TABLE(content_type text, bytes bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT i.content_type, i.bytes FROM splash.submission_images AS i
  WHERE i.submission_id = target_submission_id
    AND splash.current_state(i.submission_id) = 'in_pond'
$$;

-- Server-side only: lets bidding (a later change) refuse a bid by the author.
CREATE FUNCTION splash.author_of(target_submission_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.author_subject_id FROM splash.submissions AS s
  WHERE s.submission_id = target_submission_id
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA splash FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA splash FROM PUBLIC;
GRANT USAGE ON SCHEMA splash TO splash_service;
GRANT EXECUTE ON FUNCTION
  splash.submit_frog(uuid),
  splash.store_image(uuid, text, integer, integer, boolean, bytea),
  splash.pond(integer),
  splash.my_submissions(),
  splash.submission_image(uuid),
  splash.author_of(uuid)
TO splash_service;
RESET ROLE;
