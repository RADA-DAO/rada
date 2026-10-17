-- Reuse SPLASH's existing public image visibility without reading its tables.
SET LOCAL ROLE splash_owner;
GRANT USAGE ON SCHEMA splash TO jpegpe_owner;
GRANT EXECUTE ON FUNCTION splash.submission_image(uuid) TO jpegpe_owner;
RESET ROLE;
SET LOCAL ROLE jpegpe_owner;
ALTER TABLE jpegpe.artwork ADD COLUMN sha256 text
  GENERATED ALWAYS AS (encode(sha256(bytes), 'hex')) STORED;
CREATE FUNCTION jpegpe.visible_artwork(p_ids uuid[])
RETURNS TABLE(frog_id uuid, sha256 text, is_public boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT f.frog_id, coalesce(a.sha256, encode(sha256(s.bytes), 'hex')), visibility.is_public
  FROM jpegpe.frogs f LEFT JOIN jpegpe.artwork a USING (frog_id)
  LEFT JOIN LATERAL splash.submission_image(f.frog_id) s ON (a.frog_id IS NULL)
  CROSS JOIN LATERAL (
    SELECT EXISTS (SELECT 1 FROM jpegpe.public_profile_frog(f.current_owner_subject_id) p
                   WHERE p.frog_id = f.frog_id)
      OR EXISTS (SELECT 1 FROM splash.submission_image(f.frog_id)) AS is_public
  ) visibility
  WHERE f.frog_id = ANY(p_ids) AND (a.frog_id IS NOT NULL OR s.bytes IS NOT NULL)
    AND (visibility.is_public OR f.current_owner_subject_id = identity.current_subject())
$$;
CREATE FUNCTION jpegpe.read_artwork(p_id uuid)
RETURNS TABLE(content_type text, needs_normalization boolean, bytes bytea, sha256 text, is_public boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(a.content_type, s.content_type), coalesce(a.needs_normalization, false),
    coalesce(a.bytes, s.bytes), v.sha256, v.is_public
  FROM jpegpe.visible_artwork(ARRAY[p_id]) v LEFT JOIN jpegpe.artwork a USING (frog_id)
  LEFT JOIN LATERAL splash.submission_image(v.frog_id) s ON (a.frog_id IS NULL)
$$;
REVOKE ALL ON FUNCTION jpegpe.visible_artwork(uuid[]), jpegpe.read_artwork(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jpegpe.visible_artwork(uuid[]), jpegpe.read_artwork(uuid)
  TO identity_service, jpegpe_service;
RESET ROLE;
