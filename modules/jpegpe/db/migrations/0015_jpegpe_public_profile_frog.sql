SET LOCAL ROLE jpegpe_owner;
-- Public profile projection of any subject: the selected frog, only while that
-- subject still owns it. Same four fields as jpegpe.own_public_frog; no subject ids.
-- Callable only by modules that were explicitly granted execute.
CREATE FUNCTION jpegpe.public_profile_frog(target_subject_id uuid)
RETURNS TABLE(frog_id uuid, username text, background_color text, accent_color text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT f.frog_id, f.username, f.background_color, f.accent_color
  FROM jpegpe.frogs AS f
  WHERE f.frog_id = identity.selected_frog_of(target_subject_id)
    AND f.current_owner_subject_id = target_subject_id
$$;
REVOKE ALL ON FUNCTION jpegpe.public_profile_frog(uuid) FROM PUBLIC;
RESET ROLE;
