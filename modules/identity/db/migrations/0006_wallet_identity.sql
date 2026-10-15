SET LOCAL ROLE identity_owner;
CREATE TABLE identity.wallet_links (
  subject_id uuid NOT NULL REFERENCES identity.subjects(subject_id),
  address_raw text NOT NULL CHECK (address_raw ~ '^(-1|0):[0-9a-f]{64}$'),
  address_friendly text NOT NULL,
  network text NOT NULL CHECK (network = '-239'),
  verified_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (subject_id, network, address_raw)
);
CREATE TABLE identity.wallet_link_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id uuid NOT NULL REFERENCES identity.subjects(subject_id),
  address_raw text NOT NULL,
  action text NOT NULL CHECK (action IN ('linked', 'revoked')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE identity.wallet_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.wallet_links FORCE ROW LEVEL SECURITY;
ALTER TABLE identity.wallet_link_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.wallet_link_events FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON identity.wallet_links TO identity_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON identity.wallet_link_events TO identity_owner USING (true) WITH CHECK (true);
CREATE FUNCTION identity.wallet_link(p_address_raw text, p_address_friendly text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s uuid := identity.current_subject();
BEGIN
  IF s IS NULL OR p_address_raw !~ '^0:[0-9a-f]{64}$' OR length(p_address_friendly) > 64 THEN
    RAISE EXCEPTION 'Invalid wallet link' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM identity.subjects WHERE subject_id = s FOR UPDATE;
  IF (SELECT count(*) FROM identity.wallet_links WHERE subject_id = s AND revoked_at IS NULL) >= 16
    AND NOT EXISTS (SELECT FROM identity.wallet_links WHERE subject_id = s AND address_raw = p_address_raw AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Wallet link limit reached' USING ERRCODE = '54000';
  END IF;
  INSERT INTO identity.wallet_links(subject_id, address_raw, address_friendly, network)
    VALUES (s, p_address_raw, p_address_friendly, '-239')
    ON CONFLICT (subject_id, network, address_raw) DO UPDATE SET
      address_friendly = EXCLUDED.address_friendly, verified_at = now(), revoked_at = NULL;
  INSERT INTO identity.wallet_link_events(subject_id, address_raw, action) VALUES (s, p_address_raw, 'linked');
END $$;
CREATE FUNCTION identity.wallet_revoke(p_address_raw text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s uuid := identity.current_subject(); old_address text;
BEGIN
  IF s IS NULL OR p_address_raw !~ '^0:[0-9a-f]{64}$' THEN RETURN false; END IF;
  PERFORM 1 FROM identity.subjects WHERE subject_id = s FOR UPDATE;
  UPDATE identity.wallet_links SET revoked_at = now()
    WHERE subject_id = s AND address_raw = p_address_raw AND network = '-239'
      AND revoked_at IS NULL RETURNING address_raw INTO old_address;
  IF old_address IS NULL THEN RETURN false; END IF;
  INSERT INTO identity.wallet_link_events(subject_id, address_raw, action) VALUES (s, old_address, 'revoked');
  RETURN true;
END $$;
CREATE FUNCTION identity.own_wallet()
RETURNS TABLE(address_raw text, address_friendly text, network text, verified_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT w.address_raw, w.address_friendly, w.network, w.verified_at
  FROM identity.wallet_links w WHERE w.subject_id = identity.current_subject() AND w.revoked_at IS NULL
  ORDER BY w.verified_at DESC, w.address_raw
$$;
CREATE FUNCTION identity.own_wallet_history()
RETURNS TABLE(address_raw text, action text, occurred_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT e.address_raw, e.action, e.occurred_at
  FROM identity.wallet_link_events e WHERE e.subject_id = identity.current_subject()
  ORDER BY e.event_id DESC LIMIT 100
$$;
CREATE FUNCTION identity.wallet_consent(p_app_id text, p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS(SELECT 1 FROM identity.consents c
    WHERE c.subject_id = identity.current_subject() AND c.app_id = p_app_id
      AND c.capability = p_capability AND c.revoked_at IS NULL)
$$;
REVOKE ALL ON FUNCTION identity.wallet_link(text, text), identity.wallet_revoke(text),
  identity.own_wallet(), identity.own_wallet_history(), identity.wallet_consent(text, text) FROM PUBLIC;
GRANT USAGE ON SCHEMA identity TO wallet_service;
GRANT EXECUTE ON FUNCTION identity.current_subject(), identity.wallet_link(text, text),
  identity.wallet_revoke(text), identity.own_wallet(), identity.own_wallet_history(),
  identity.wallet_consent(text, text) TO wallet_service;
RESET ROLE;
