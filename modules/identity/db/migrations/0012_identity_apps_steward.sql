SET LOCAL ROLE identity_owner;
-- The authorized steward decides official status. The grant is separate from
-- `apps.reviewer`, so approving versions never implies deciding who is official.
CREATE FUNCTION identity.can_steward_apps() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM identity.role_grants
    WHERE subject_id = identity.current_subject() AND role_name = 'apps.steward'
  )
$$;
REVOKE ALL ON FUNCTION identity.can_steward_apps() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.can_steward_apps() TO apps_owner;
RESET ROLE;
