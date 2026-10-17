SET LOCAL ROLE governance_owner;
-- A hash match links recorded evidence; it does not independently prove execution.
CREATE FUNCTION governance.transaction_evidence(hash text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('proposalId',e.proposal_id,'evidenceId',e.evidence_id,
 'title',p.title,'body',e.body,'outcome',d.outcome) ORDER BY e.recorded_at,e.evidence_id),'[]')
 FROM governance.evidence e JOIN governance.proposals p USING(proposal_id)
 JOIN governance.decisions d USING(proposal_id) WHERE e.tx_hash=lower(hash)
$$;
REVOKE ALL ON FUNCTION governance.transaction_evidence(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION governance.transaction_evidence(text) TO treasury_owner;
RESET ROLE;
