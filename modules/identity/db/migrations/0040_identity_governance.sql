CREATE ROLE governance_owner NOLOGIN;
CREATE ROLE governance_service NOLOGIN;
SET LOCAL ROLE identity_owner;
CREATE FUNCTION identity.can_steward_governance() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM identity.role_grants
    WHERE subject_id = identity.current_subject() AND role_name = 'governance.steward')
$$;
-- Private worker input, never a public projection. Only known verified accounts.
CREATE FUNCTION identity.governance_membership_accounts()
RETURNS TABLE(subject_id uuid, telegram_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT subject_id, telegram_user_id::text FROM identity.telegram_accounts
$$;
REVOKE ALL ON FUNCTION identity.can_steward_governance() FROM PUBLIC;
REVOKE ALL ON FUNCTION identity.governance_membership_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.can_steward_governance() TO governance_owner;
GRANT USAGE ON SCHEMA identity TO governance_service;
GRANT EXECUTE ON FUNCTION identity.governance_membership_accounts() TO governance_service;
RESET ROLE;
