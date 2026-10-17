SET LOCAL ROLE governance_owner;
CREATE FUNCTION governance.public_person(s uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
 SELECT to_jsonb(f) FROM jpegpe.public_profile_frog(s) f
$$;
CREATE FUNCTION governance.read_proposal(p uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT jsonb_build_object(
 'proposal_id',a.proposal_id,'title',a.title,'body',a.body,'author',governance.public_person(a.author),
 'created_at',a.created_at,'state',CASE WHEN w.proposal_id IS NOT NULL THEN 'withdrawn'
 WHEN c.proposal_id IS NOT NULL THEN 'closed' WHEN o.proposal_id IS NOT NULL THEN 'opened' ELSE 'created' END,
 'withdrawal_reason',w.reason,'opened_at',o.opened_at,'closes_at',o.closes_at,
 'rules',s.rules,'settings_version',o.settings_version,
 'tally',coalesce(c.tally,governance.tally(p)), 'closed_at',c.closed_at,
 'decision_status',CASE WHEN d.proposal_id IS NOT NULL THEN d.outcome
 WHEN c.proposal_id IS NULL THEN 'not_due'
 WHEN clock_timestamp() > c.closed_at + (s.rules->>'decision_days')::numeric * interval '1 day'
 THEN 'decision_pending' ELSE 'awaiting_decision' END,
 'decision_due_at',c.closed_at + (s.rules->>'decision_days')::numeric * interval '1 day',
 'decision',CASE WHEN d.proposal_id IS NOT NULL THEN jsonb_build_object('outcome',d.outcome,'reason',d.reason,
 'decided_at',d.decided_at,'steward',governance.public_person(d.actor)) END,
 'execution_status',CASE WHEN EXISTS(SELECT 1 FROM governance.evidence e WHERE e.proposal_id=p) THEN 'evidence_recorded' ELSE 'no_evidence' END,
 'evidence',coalesce((SELECT jsonb_agg(jsonb_build_object('evidence_id',e.evidence_id,'body',e.body,
 'tx_hash',e.tx_hash,'link',e.link,'recorded_at',e.recorded_at,'steward',governance.public_person(e.actor)) ORDER BY e.recorded_at,e.evidence_id)
 FROM governance.evidence e WHERE e.proposal_id=p),'[]'))
 FROM governance.proposals a LEFT JOIN governance.openings o USING(proposal_id)
 LEFT JOIN governance.settings s ON (s.version=o.settings_version)
 LEFT JOIN governance.withdrawals w USING(proposal_id) LEFT JOIN governance.closures c USING(proposal_id)
 LEFT JOIN governance.decisions d USING(proposal_id) WHERE a.proposal_id=p
$$;
CREATE FUNCTION governance.list_proposals(before_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT coalesce(jsonb_agg(governance.read_proposal(proposal_id) ORDER BY proposal_id DESC),'[]')
 FROM (SELECT proposal_id FROM governance.proposals WHERE before_id IS NULL OR proposal_id < before_id ORDER BY proposal_id DESC LIMIT 50) page
$$;
CREATE FUNCTION governance.public_votes(p uuid, after_id bigint DEFAULT 0) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('vote_id',v.vote_id::text,'receipt',v.receipt,'choice',v.choice,
 'placed_at',v.placed_at,'voter',governance.public_person(v.subject_id),
 'current',NOT EXISTS(SELECT 1 FROM governance.votes n WHERE n.proposal_id=p AND n.subject_id=v.subject_id AND n.vote_id>v.vote_id),
 'excluded',coalesce(v.receipt=ANY(c.excluded_receipts),false),
 'exclusion_reason',CASE WHEN v.receipt=ANY(c.excluded_receipts) THEN 'membership_lost_at_close' END) ORDER BY v.vote_id),'[]')
 FROM (SELECT * FROM governance.votes WHERE proposal_id=p AND vote_id>after_id ORDER BY vote_id LIMIT 100) v
 LEFT JOIN governance.closures c ON (c.proposal_id=v.proposal_id)
$$;
CREATE FUNCTION governance.my_votes() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('proposal_id',proposal_id,'choice',choice,'receipt',receipt,'placed_at',placed_at) ORDER BY vote_id DESC),'[]')
 FROM (SELECT DISTINCT ON(proposal_id) * FROM governance.votes WHERE subject_id=identity.current_subject() ORDER BY proposal_id,vote_id DESC) v
$$;
CREATE FUNCTION governance.settings_history() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('version',version,'reason',reason,'rules',rules,
 'changed_at',changed_at,'steward',governance.public_person(actor)) ORDER BY version DESC),'[]') FROM governance.settings
$$;
GRANT EXECUTE ON FUNCTION governance.read_proposal(uuid), governance.list_proposals(uuid),
 governance.public_votes(uuid,bigint), governance.my_votes(), governance.settings_history() TO governance_service;
RESET ROLE;
