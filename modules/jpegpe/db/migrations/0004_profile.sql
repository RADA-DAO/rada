SET LOCAL ROLE jpegpe_owner;
ALTER TABLE jpegpe.frogs ADD COLUMN artwork_path text
  CHECK (artwork_path ~ '^/media/jpegpe/[0-9a-f]{64}\.(webp|png)$');
CREATE FUNCTION jpegpe.immutable_frog_artwork() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Frog artwork is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER frog_artwork_immutable BEFORE UPDATE OF artwork_path ON jpegpe.frogs
  FOR EACH ROW EXECUTE FUNCTION jpegpe.immutable_frog_artwork();
CREATE FUNCTION jpegpe.own_frogs()
RETURNS TABLE(frog_id uuid, username text, background_color text, accent_color text, artwork_path text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT f.frog_id, f.username, f.background_color, f.accent_color, f.artwork_path
  FROM jpegpe.frogs AS f
  WHERE f.current_owner_subject_id = identity.current_subject()
  ORDER BY f.username COLLATE "C", f.frog_id
$$;
REVOKE ALL ON FUNCTION jpegpe.own_frogs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jpegpe.own_frogs() TO identity_service, jpegpe_service;
RESET ROLE;
REVOKE ALL ON FUNCTION jpegpe.immutable_frog_artwork() FROM PUBLIC;
