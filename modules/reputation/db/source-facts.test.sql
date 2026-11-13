BEGIN;
SET LOCAL ROLE reputation_ingress;
DO $$
DECLARE result jsonb; again jsonb; s uuid:='a0760000-0000-4000-8000-000000000001'; evidence jsonb:='[{"id":"proof-1","url":"https://example.invalid/comment/1","label":"Observed comment"},{"id":"proof-2","url":"https://example.invalid/comment/2","label":"Observed comment"}]';
BEGIN
 result:=reputation.ingest_fact(s,'synthetic-raw-raid','unit-1','Synthetic raid','Dated raw observations','2026-01-01T00:00:00Z',evidence);
 IF result->'item'->>'status'<>'pending' OR result->'item'->>'points'<>'0' OR result->'item'->'evidence'<>evidence THEN RAISE EXCEPTION 'source fact did not preserve pending full evidence'; END IF;
 again:=reputation.ingest_fact(s,'synthetic-raw-raid','unit-1','Synthetic raid','Dated raw observations','2026-01-01T00:00:00Z',evidence);
 IF again<>result THEN RAISE EXCEPTION 'source receipt replay changed'; END IF;
 BEGIN
 PERFORM reputation.ingest_fact(s,'synthetic-raw-raid','unit-1','Changed payload','Dated raw observations','2026-01-01T00:00:00Z',evidence);
 RAISE EXCEPTION 'changed source key accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
 PERFORM reputation.ingest_fact('a0760000-0000-4000-8000-000000000002','synthetic-raw-raid','unit-1','Synthetic raid','Dated raw observations','2026-01-01T00:00:00Z',evidence);
 RAISE EXCEPTION 'source key rebound to different actor';
 EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
SET LOCAL ROLE reputation_service;
SELECT set_config('rada.subject_id','a0760000-0000-4000-8000-000000000001',true);
DO $$ BEGIN
 IF reputation.summary('all')->>'pendingCount'<>'1' OR reputation.summary('all')->>'totalPoints'<>'0' THEN RAISE EXCEPTION 'ingress changed score or duplicated input'; END IF;
 BEGIN
 PERFORM reputation.ingest_fact('a0760000-0000-4000-8000-000000000001','synthetic','forbidden','Synthetic','Forbidden source override','2026-01-01T00:00:00Z','[]');
 RAISE EXCEPTION 'public service acquired source ingress';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET LOCAL ROLE reputation_owner;
DO $$ BEGIN
 IF (SELECT count(*) FROM reputation.jobs q JOIN reputation.items i ON (q.item_id=i.id) WHERE i.subject_id='a0760000-0000-4000-8000-000000000001')<>1 THEN RAISE EXCEPTION 'source pending job not atomic'; END IF;
 BEGIN
 UPDATE reputation.source_receipts SET receipt='{}';
 RAISE EXCEPTION 'source receipt mutable';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
