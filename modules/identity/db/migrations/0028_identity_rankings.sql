SET LOCAL ROLE identity_owner;
-- Private platform projection, never exposed directly over HTTP.
CREATE FUNCTION identity.holder_profiles()
RETURNS TABLE(subject_id uuid, frog_id uuid, username text, verified_at timestamptz, link_version text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.subject_id, f.frog_id, f.username, min(w.verified_at),
    md5(string_agg(w.address_raw || ':' || date_part('epoch', w.verified_at)::text, ',' ORDER BY w.address_raw))
  FROM identity.subjects s
  CROSS JOIN LATERAL jpegpe.public_profile_frog(s.subject_id) f
  JOIN identity.wallet_links w ON (w.subject_id = s.subject_id AND w.revoked_at IS NULL)
  GROUP BY s.subject_id, f.frog_id, f.username
$$;
CREATE FUNCTION identity.holder_wallets()
RETURNS TABLE(subject_id uuid, frog_id uuid, link_version text, address text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.subject_id, p.frog_id, p.link_version, w.address_raw
  FROM identity.holder_profiles() p
  JOIN identity.wallet_links w ON (w.subject_id = p.subject_id AND w.revoked_at IS NULL)
  ORDER BY p.subject_id, w.address_raw
$$;
REVOKE ALL ON FUNCTION identity.holder_profiles(), identity.holder_wallets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.holder_profiles() TO rankings_owner;
GRANT EXECUTE ON FUNCTION identity.holder_wallets() TO rankings_worker;
RESET ROLE;
