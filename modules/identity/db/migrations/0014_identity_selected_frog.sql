SET LOCAL ROLE identity_owner;
-- Published interface for JPEGPE's public profile projection: a profile is public
-- exactly when the subject has selected a frog. Returns only the frog id.
CREATE FUNCTION identity.selected_frog_of(target_subject_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT selected_frog_id FROM identity.subjects WHERE subject_id = target_subject_id
$$;
REVOKE ALL ON FUNCTION identity.selected_frog_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.selected_frog_of(uuid) TO jpegpe_owner;
RESET ROLE;
