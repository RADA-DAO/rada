SET LOCAL ROLE identity_owner;
-- The authorized SPLASH steward decides where claim payments go. Separate from
-- `apps.steward`, so deciding official app status never implies directing revenue.
CREATE FUNCTION identity.can_steward_splash() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM identity.role_grants
    WHERE subject_id = identity.current_subject() AND role_name = 'splash.steward'
  )
$$;
REVOKE ALL ON FUNCTION identity.can_steward_splash() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.can_steward_splash() TO splash_owner;
RESET ROLE;
