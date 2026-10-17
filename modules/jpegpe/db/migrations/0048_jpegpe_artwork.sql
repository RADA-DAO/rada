SET LOCAL ROLE jpegpe_owner;
CREATE TABLE jpegpe.artwork (
  frog_id uuid PRIMARY KEY REFERENCES jpegpe.frogs(frog_id),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
  needs_normalization boolean NOT NULL,
  bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 4194304),
  CHECK (needs_normalization = (content_type = 'image/jpeg'))
);
ALTER TABLE jpegpe.artwork ENABLE ROW LEVEL SECURITY;
ALTER TABLE jpegpe.artwork FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON jpegpe.artwork TO jpegpe_owner USING (true) WITH CHECK (true);
CREATE TRIGGER artwork_immutable BEFORE UPDATE OR DELETE ON jpegpe.artwork
  FOR EACH ROW EXECUTE FUNCTION jpegpe.immutable_ownership_event();
CREATE FUNCTION jpegpe.import_artwork(p_id uuid, p_type text, p_pending boolean, p_bytes bytea)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO jpegpe.artwork VALUES (p_id, p_type, p_pending, p_bytes)
$$;
CREATE FUNCTION jpegpe.import_artwork_state(p_id uuid)
RETURNS TABLE(content_type text, needs_normalization boolean, bytes bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT a.content_type, a.needs_normalization, a.bytes FROM jpegpe.artwork a WHERE frog_id = p_id
$$;
REVOKE ALL ON jpegpe.artwork FROM PUBLIC;
REVOKE ALL ON FUNCTION jpegpe.import_artwork(uuid,text,boolean,bytea),
  jpegpe.import_artwork_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jpegpe.import_artwork(uuid,text,boolean,bytea),
  jpegpe.import_artwork_state(uuid) TO legacy_import;
RESET ROLE;
