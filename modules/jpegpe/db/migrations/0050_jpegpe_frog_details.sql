SET LOCAL ROLE jpegpe_owner;
-- Detail is owner-only. People are projected through their currently owned,
-- selected public frog; no identity IDs or private profile fields leave SQL.
CREATE FUNCTION jpegpe.own_frog_details(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'creator', (SELECT username FROM jpegpe.public_profile_frog(f.creator_subject_id)),
    'owner', (SELECT username FROM jpegpe.public_profile_frog(f.current_owner_subject_id)),
    'colour_source', f.colour_source,
    'history', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'at', to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'from', (SELECT username FROM jpegpe.public_profile_frog(e.from_subject_id)),
      'to', (SELECT username FROM jpegpe.public_profile_frog(e.to_subject_id))
    ) ORDER BY e.occurred_at, e.event_id) FROM jpegpe.ownership_events e
      WHERE e.frog_id = f.frog_id), '[]'::jsonb))
  FROM jpegpe.frogs f
  WHERE f.frog_id = p_id AND f.current_owner_subject_id = identity.current_subject()
$$;
REVOKE ALL ON FUNCTION jpegpe.own_frog_details(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jpegpe.own_frog_details(uuid) TO identity_service, jpegpe_service;
RESET ROLE;
