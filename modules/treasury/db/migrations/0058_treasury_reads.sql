SET LOCAL ROLE treasury_owner;
CREATE FUNCTION treasury.overview() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('wallets',coalesce(jsonb_agg(jsonb_build_object(
 'address',w.address,'balances',s.balances,'asOf',s.balance_at,
 'stale',coalesce(s.balance_at < now()-interval '10 minutes',true),
 'historyAsOf',s.history_at,'indexedThrough',s.indexed_through,
 'historyStale',coalesce(s.incomplete OR s.history_at < now()-interval '10 minutes' OR s.indexed_through < now()-interval '10 minutes',true),
 'signersAsOf',s.signers_at,'signersStale',coalesce(s.signers_at < now()-interval '10 minutes',true),
 'signers',CASE WHEN s.signers IS NOT NULL THEN (SELECT coalesce(jsonb_agg(identity.treasury_person(a)),'[]') FROM unnest(s.signers) a) END
 ) ORDER BY w.address),'[]')) FROM treasury.wallets() w LEFT JOIN treasury.samples s USING(address)
$$;
CREATE FUNCTION treasury.transactions(before_id bigint, direction_filter text, token_filter text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id::text,'wallet',m.address,'hash',m.tx_hash,
 'at',m.occurred_at,'direction',m.direction,'token',m.token,'amount',m.amount,
 'person',identity.treasury_person(m.counterparty),'decisions',governance.transaction_evidence(m.tx_hash)) ORDER BY m.occurred_at DESC,m.id DESC),'[]')
 FROM (SELECT m.* FROM treasury.movements m JOIN treasury.wallets() w ON (w.address=m.address)
 WHERE (before_id IS NULL OR (m.occurred_at,m.id)<(SELECT occurred_at,id FROM treasury.movements WHERE id=before_id)) AND (direction_filter IS NULL OR m.direction=direction_filter)
 AND (token_filter IS NULL OR m.token=token_filter) ORDER BY m.occurred_at DESC,m.id DESC LIMIT 51) m
$$;
CREATE FUNCTION treasury.history(before_version bigint) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('version',c.version::text,'address',c.address,'enabled',c.enabled,
 'reason',c.reason,'changedAt',c.changed_at,'person',(SELECT jsonb_build_object('frogId',f.frog_id,'name',f.username)
 FROM jpegpe.public_profile_frog(c.actor) f)) ORDER BY c.version DESC),'[]')
 FROM (SELECT * FROM treasury.configuration WHERE before_version IS NULL OR version<before_version ORDER BY version DESC LIMIT 51) c
$$;
GRANT EXECUTE ON FUNCTION treasury.overview(),treasury.transactions(bigint,text,text),treasury.history(bigint) TO treasury_service;
REVOKE ALL ON ALL TABLES IN SCHEMA treasury FROM PUBLIC,treasury_service;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA treasury FROM PUBLIC,treasury_service;
RESET ROLE;
