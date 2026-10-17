CREATE ROLE treasury_owner NOLOGIN;
CREATE ROLE treasury_service NOLOGIN;
CREATE SCHEMA treasury AUTHORIZATION treasury_owner;
GRANT USAGE ON SCHEMA treasury TO treasury_service;
GRANT USAGE ON SCHEMA identity, jpegpe, governance TO treasury_owner;
GRANT EXECUTE ON FUNCTION identity.current_subject(), jpegpe.public_profile_frog(uuid) TO treasury_owner;
SET LOCAL ROLE identity_owner;
CREATE FUNCTION identity.can_steward_treasury() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT EXISTS(SELECT FROM identity.role_grants WHERE subject_id=identity.current_subject() AND role_name='treasury.steward')
$$;
-- Narrow live projection: neither subject IDs nor addresses leave this function.
CREATE FUNCTION identity.treasury_person(address text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT jsonb_build_object('frogId',f.frog_id,'name',f.username)
 FROM identity.wallet_links w CROSS JOIN LATERAL jpegpe.public_profile_frog(w.subject_id) f
 WHERE w.address_raw=address AND w.revoked_at IS NULL AND w.network='-239'
 ORDER BY w.verified_at DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION identity.can_steward_treasury(), identity.treasury_person(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.can_steward_treasury(), identity.treasury_person(text) TO treasury_owner;
RESET ROLE;
