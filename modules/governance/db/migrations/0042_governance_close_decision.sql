SET LOCAL ROLE governance_owner;
CREATE FUNCTION governance.tally(p uuid, excluded uuid[] DEFAULT '{}') RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
 SELECT jsonb_build_object('for',count(*) FILTER(WHERE choice='for'),
 'against',count(*) FILTER(WHERE choice='against'),'abstain',count(*) FILTER(WHERE choice='abstain'))
 FROM governance.current_votes(p) WHERE NOT receipt=ANY(excluded)
$$;
CREATE FUNCTION governance.close_proposal(p uuid, members uuid[], checked timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o governance.openings; r jsonb; excluded uuid[] := '{}';
BEGIN
 PERFORM 1 FROM governance.proposals WHERE proposal_id=p FOR UPDATE;
 SELECT * INTO o FROM governance.openings WHERE proposal_id=p;
 IF NOT FOUND OR o.closes_at > clock_timestamp() OR EXISTS(SELECT 1 FROM governance.closures WHERE proposal_id=p) THEN
   RETURN false; END IF;
 SELECT rules INTO r FROM governance.settings WHERE version=o.settings_version;
 IF NOT (r->>'keep_departed_votes')::boolean THEN
   IF members IS NULL OR checked IS NULL OR checked < clock_timestamp()-interval '30 seconds'
      OR checked > clock_timestamp() THEN
     RAISE EXCEPTION 'membership_unavailable' USING ERRCODE='23514'; END IF;
   SELECT coalesce(array_agg(receipt),'{}') INTO excluded FROM governance.current_votes(p)
     WHERE choice IS NOT NULL AND NOT subject_id=ANY(members);
 END IF;
 INSERT INTO governance.closures VALUES(p,clock_timestamp(),governance.tally(p,excluded),excluded,coalesce(checked,clock_timestamp()));
 RETURN true;
END $$;
CREATE FUNCTION governance.due_proposals() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('proposal_id',o.proposal_id,
 'keep_departed_votes',(s.rules->>'keep_departed_votes')::boolean)),'[]')
 FROM governance.openings o JOIN governance.settings s ON (s.version=o.settings_version)
 WHERE o.closes_at <= clock_timestamp() AND NOT EXISTS(SELECT 1 FROM governance.closures c WHERE c.proposal_id=o.proposal_id)
$$;
CREATE FUNCTION governance.decide(p uuid, outcome text, why text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t jsonb; r jsonb;
BEGIN
 IF NOT identity.can_steward_governance() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM governance.proposals WHERE proposal_id=p FOR UPDATE;
 SELECT tally INTO t FROM governance.closures WHERE proposal_id=p;
 IF NOT FOUND THEN RAISE EXCEPTION 'not_closed' USING ERRCODE='23514'; END IF;
 SELECT s.rules INTO r FROM governance.openings o JOIN governance.settings s ON (s.version=o.settings_version) WHERE o.proposal_id=p;
 IF NOT (r->>'allow_majority_override')::boolean AND
   ((outcome='accept' AND (t->>'for')::bigint <= (t->>'against')::bigint) OR
    (outcome='reject' AND (t->>'for')::bigint > (t->>'against')::bigint)) THEN
   RAISE EXCEPTION 'majority_override_disabled' USING ERRCODE='23514'; END IF;
 INSERT INTO governance.decisions VALUES(p,identity.current_subject(),outcome,why,clock_timestamp());
END $$;
CREATE FUNCTION governance.attach_evidence(p uuid, b text, tx text, url text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result uuid;
BEGIN
 IF NOT identity.can_steward_governance() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM governance.decisions WHERE proposal_id=p AND outcome='accept') THEN
   RAISE EXCEPTION 'not_accepted' USING ERRCODE='23514'; END IF;
 INSERT INTO governance.evidence(proposal_id,actor,body,tx_hash,link)
 VALUES(p,identity.current_subject(),b,tx,url) RETURNING evidence_id INTO result;
 RETURN result;
END $$;
GRANT EXECUTE ON FUNCTION governance.close_proposal(uuid,uuid[],timestamptz), governance.due_proposals(),
 governance.decide(uuid,text,text), governance.attach_evidence(uuid,text,text,text) TO governance_service;
RESET ROLE;
