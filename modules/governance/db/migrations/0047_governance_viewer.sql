SET LOCAL ROLE governance_owner;
-- A caller can inspect only their own effective role, never the role roster.
CREATE FUNCTION governance.viewer() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT jsonb_build_object('steward', identity.can_steward_governance())
$$;
REVOKE ALL ON FUNCTION governance.viewer() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION governance.viewer() TO governance_service;
RESET ROLE;
