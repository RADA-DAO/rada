CREATE SCHEMA governance AUTHORIZATION governance_owner;
GRANT USAGE ON SCHEMA identity, jpegpe TO governance_owner;
GRANT EXECUTE ON FUNCTION identity.current_subject() TO governance_owner;
GRANT EXECUTE ON FUNCTION jpegpe.public_profile_frog(uuid) TO governance_owner;
SET LOCAL ROLE governance_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE FUNCTION governance.valid_text(value text, maximum integer) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT value IS NOT NULL AND char_length(btrim(value)) BETWEEN 1 AND maximum
    AND value !~ '[[:cntrl:]]' -- Multiline bodies are normalized by the API.
$$;
CREATE FUNCTION governance.reject_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'immutable' USING ERRCODE = '23514'; END $$;
CREATE TABLE governance.settings (
  version bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor uuid,
  reason text NOT NULL CHECK (governance.valid_text(reason, 2000)),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rules jsonb NOT NULL
);
CREATE FUNCTION governance.valid_rules(r jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
 SELECT coalesce(jsonb_typeof(r) = 'object' AND
   (SELECT count(*) = 7 FROM jsonb_object_keys(r)) AND
   r->>'who_opens' IN ('steward-opens','author-opens') AND
   jsonb_typeof(r->'duration_hours') = 'number' AND
   (r->>'duration_hours')::numeric BETWEEN 1 AND 720 AND
   jsonb_typeof(r->'decision_days') = 'number' AND
   (r->>'decision_days')::numeric BETWEEN 1 AND 365 AND
   jsonb_typeof(r->'allow_vote_changes') = 'boolean' AND
   jsonb_typeof(r->'require_membership_at_open') = 'boolean' AND
   jsonb_typeof(r->'keep_departed_votes') = 'boolean' AND
   jsonb_typeof(r->'allow_majority_override') = 'boolean', false)
$$;
ALTER TABLE governance.settings ADD CHECK (governance.valid_rules(rules));
INSERT INTO governance.settings(reason,rules) VALUES ('Initial defaults',
 '{"who_opens":"steward-opens","duration_hours":48,"decision_days":7,
   "allow_vote_changes":true,"require_membership_at_open":false,
   "keep_departed_votes":true,"allow_majority_override":true}');
CREATE TABLE governance.proposals (
  proposal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author uuid NOT NULL,
  title text NOT NULL CHECK (governance.valid_text(title,200)),
  body text NOT NULL CHECK (governance.valid_text(body,20000)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE governance.openings (
  proposal_id uuid PRIMARY KEY REFERENCES governance.proposals,
  actor uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closes_at timestamptz NOT NULL,
  settings_version bigint NOT NULL REFERENCES governance.settings,
  members uuid[] NOT NULL,
  checked_at timestamptz NOT NULL
);
CREATE TABLE governance.withdrawals (
  proposal_id uuid PRIMARY KEY REFERENCES governance.proposals,
  actor uuid NOT NULL,
  reason text NOT NULL CHECK (governance.valid_text(reason,2000)),
  withdrawn_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE governance.votes (
  vote_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  proposal_id uuid NOT NULL REFERENCES governance.proposals,
  subject_id uuid NOT NULL,
  choice text CHECK (choice IN ('for','against','abstain')),
  placed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  membership_checked_at timestamptz NOT NULL
);
CREATE INDEX votes_latest ON governance.votes(proposal_id,subject_id,vote_id DESC);
CREATE TABLE governance.closures (
  proposal_id uuid PRIMARY KEY REFERENCES governance.openings,
  closed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  tally jsonb NOT NULL,
  excluded_receipts uuid[] NOT NULL,
  membership_checked_at timestamptz NOT NULL
);
CREATE TABLE governance.decisions (
  proposal_id uuid PRIMARY KEY REFERENCES governance.closures,
  actor uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accept','reject','defer')),
  reason text NOT NULL CHECK (governance.valid_text(reason,4000)),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE governance.evidence (
  evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES governance.decisions,
  actor uuid NOT NULL,
  body text NOT NULL CHECK (governance.valid_text(body,4000)),
  tx_hash text CHECK (tx_hash ~ '^[0-9a-fA-F]{64}$'),
  link text CHECK (char_length(link) <= 2048 AND link ~ '^https://[^[:space:]]+$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['settings','proposals','openings','withdrawals','votes','closures','decisions','evidence'] LOOP
   EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON governance.%I FOR EACH ROW EXECUTE FUNCTION governance.reject_change()',t);
   EXECUTE format('ALTER TABLE governance.%I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('ALTER TABLE governance.%I FORCE ROW LEVEL SECURITY',t);
   EXECUTE format('CREATE POLICY owner_access ON governance.%I TO governance_owner USING (true) WITH CHECK (true)',t);
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA governance TO governance_service;
RESET ROLE;
SET LOCAL ROLE governance_owner;
CREATE FUNCTION governance.current_settings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT jsonb_build_object('version',version,'rules',rules) FROM governance.settings ORDER BY version DESC LIMIT 1
$$;
CREATE FUNCTION governance.change_settings(r jsonb, why text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v bigint;
BEGIN
 IF NOT identity.can_steward_governance() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('governance.settings',0));
 INSERT INTO governance.settings(actor,reason,rules) VALUES(identity.current_subject(),why,r) RETURNING version INTO v;
 RETURN jsonb_build_object('version',v,'rules',r);
END $$;
CREATE FUNCTION governance.create_proposal(t text, b text, member boolean, checked timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result uuid;
BEGIN
 IF identity.current_subject() IS NULL OR member IS DISTINCT FROM true OR checked IS NULL
   OR checked < clock_timestamp()-interval '30 seconds' OR checked > clock_timestamp() THEN
   RAISE EXCEPTION 'membership_required' USING ERRCODE='42501';
 END IF;
 INSERT INTO governance.proposals(author,title,body) VALUES(identity.current_subject(),t,b) RETURNING proposal_id INTO result;
 RETURN result;
END $$;
-- Authorize before requesting the private membership snapshot.
CREATE FUNCTION governance.open_context(p uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE a uuid; s governance.settings;
BEGIN
 SELECT author INTO a FROM governance.proposals WHERE proposal_id=p;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 SELECT * INTO s FROM governance.settings ORDER BY version DESC LIMIT 1;
 IF NOT identity.can_steward_governance() AND NOT
   (s.rules->>'who_opens'='author-opens' AND a=identity.current_subject()) THEN
   RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('version',s.version,'rules',s.rules);
END $$;
GRANT EXECUTE ON FUNCTION governance.open_context(uuid) TO governance_service;
CREATE FUNCTION governance.open_proposal(p uuid, members uuid[], checked timestamptz, expected_version bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE proposal governance.proposals; s governance.settings; opened timestamptz;
BEGIN
 SELECT * INTO proposal FROM governance.proposals WHERE proposal_id=p FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('governance.settings',0));
 SELECT * INTO s FROM governance.settings ORDER BY version DESC LIMIT 1;
 IF s.version IS DISTINCT FROM expected_version THEN
   RAISE EXCEPTION 'settings_changed' USING ERRCODE='23514'; END IF;
 IF NOT identity.can_steward_governance() AND NOT
   (s.rules->>'who_opens'='author-opens' AND proposal.author=identity.current_subject()) THEN
   RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM governance.withdrawals WHERE proposal_id=p) OR
    EXISTS(SELECT 1 FROM governance.openings WHERE proposal_id=p) THEN
   RAISE EXCEPTION 'invalid_state' USING ERRCODE='23514';
 END IF;
 IF checked IS NULL OR checked < clock_timestamp()-interval '30 seconds' OR checked > clock_timestamp() THEN
   RAISE EXCEPTION 'stale_membership' USING ERRCODE='23514';
 END IF;
 opened := clock_timestamp();
 INSERT INTO governance.openings VALUES(p,identity.current_subject(),opened,
   opened + (s.rules->>'duration_hours')::numeric * interval '1 hour',s.version,coalesce(members,'{}'),checked);
END $$;
CREATE FUNCTION governance.withdraw_proposal(p uuid, why text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a uuid;
BEGIN
 SELECT author INTO a FROM governance.proposals WHERE proposal_id=p FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0002'; END IF;
 IF a IS DISTINCT FROM identity.current_subject() AND NOT identity.can_steward_governance() THEN
   RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM governance.openings WHERE proposal_id=p) THEN
   RAISE EXCEPTION 'invalid_state' USING ERRCODE='23514'; END IF;
 INSERT INTO governance.withdrawals VALUES(p,identity.current_subject(),why,clock_timestamp());
END $$;
CREATE FUNCTION governance.current_votes(p uuid) RETURNS SETOF governance.votes
LANGUAGE sql STABLE SET search_path = '' AS $$
 SELECT DISTINCT ON(subject_id) * FROM governance.votes WHERE proposal_id=p ORDER BY subject_id,vote_id DESC
$$;
CREATE FUNCTION governance.cast_vote(p uuid, c text, member boolean, checked timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o governance.openings; r jsonb; receipt_id uuid;
BEGIN
 -- All writers and closers take the proposal lock; no late vote can cross close.
 PERFORM 1 FROM governance.proposals WHERE proposal_id=p FOR UPDATE;
 SELECT * INTO o FROM governance.openings WHERE proposal_id=p;
 IF NOT FOUND OR o.closes_at <= clock_timestamp() OR EXISTS(SELECT 1 FROM governance.closures WHERE proposal_id=p) THEN
   RAISE EXCEPTION 'voting_closed' USING ERRCODE='23514'; END IF;
 SELECT rules INTO r FROM governance.settings WHERE version=o.settings_version;
 IF identity.current_subject() IS NULL OR member IS DISTINCT FROM true OR checked IS NULL
   OR checked < clock_timestamp()-interval '30 seconds' OR checked > clock_timestamp() THEN
   RAISE EXCEPTION 'membership_required' USING ERRCODE='42501'; END IF;
 IF (r->>'require_membership_at_open')::boolean AND NOT identity.current_subject()=ANY(o.members) THEN
   RAISE EXCEPTION 'membership_at_open_required' USING ERRCODE='42501'; END IF;
 IF NOT (r->>'allow_vote_changes')::boolean AND (c IS NULL OR EXISTS(
   SELECT 1 FROM governance.votes WHERE proposal_id=p AND subject_id=identity.current_subject())) THEN
   RAISE EXCEPTION 'vote_changes_disabled' USING ERRCODE='23514'; END IF;
 INSERT INTO governance.votes(proposal_id,subject_id,choice,membership_checked_at)
 VALUES(p,identity.current_subject(),c,checked) RETURNING receipt INTO receipt_id;
 RETURN jsonb_build_object('receipt',receipt_id,'proposal_id',p,'choice',c);
END $$;
GRANT EXECUTE ON FUNCTION governance.current_settings(), governance.change_settings(jsonb,text),
 governance.create_proposal(text,text,boolean,timestamptz), governance.open_proposal(uuid,uuid[],timestamptz,bigint),
 governance.withdraw_proposal(uuid,text), governance.cast_vote(uuid,text,boolean,timestamptz) TO governance_service;
RESET ROLE;
