BEGIN;
SET LOCAL ROLE reputation_operator;
SELECT reputation.configure_rule('{"rulesHash":"synthetic-frozen-v1","key":"synthetic-help","points":"1.2345","category":"help","cap":{"unit":"kyiv_day","limit":1},"validFrom":"2020-01-01T00:00:00Z","validTo":null}');
SELECT reputation.configure_mission('a0720000-0000-4000-8000-000000000001',1,'Synthetic worker external','Trusted fixture','participation','0.0001','synthetic-rule','external',NULL,true);
SET LOCAL ROLE reputation_service;
SELECT set_config('rada.subject_id','a0720000-0000-4000-8000-000000000011',true);
SELECT reputation.report('synthetic-worker-report-1','Synthetic first report','Concrete completed work without attachment',clock_timestamp(),NULL);
SELECT reputation.report('synthetic-worker-report-2','Synthetic duplicate report','Same completed occurrence',clock_timestamp(),NULL);
SELECT reputation.report('synthetic-worker-report-3','Synthetic capped report','Different completed occurrence',clock_timestamp(),NULL);
SELECT reputation.verify('a0720000-0000-4000-8000-000000000001',1,'synthetic-worker-external');
DO $$ BEGIN
 BEGIN
 PERFORM reputation.claim_job(ARRAY['interpretation'],60);
 RAISE EXCEPTION 'public role claimed private jobs';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
-- Fixtures make claim order deterministic while preserving genuine role checks.
SET LOCAL ROLE reputation_owner;
UPDATE reputation.jobs SET retry_at=clock_timestamp()+interval '1 day';
UPDATE reputation.jobs SET retry_at=clock_timestamp()-interval '1 day' FROM reputation.items i
 WHERE reputation.jobs.item_id=i.id AND i.subject_id='a0720000-0000-4000-8000-000000000011';
SET LOCAL ROLE reputation_worker;
DO $$
DECLARE j jsonb; first_item uuid; first_lease uuid; result jsonb; snapshot jsonb; n integer:=0;
BEGIN
 LOOP
 j:=reputation.claim_job(ARRAY['interpretation'],60); EXIT WHEN j IS NULL;
 n:=n+1;
 IF j->>'sourceId'<>j->>'itemId' THEN RAISE EXCEPTION 'job attribution missing'; END IF;
 snapshot:=reputation.job_rules((j->>'itemId')::uuid,(j->>'leaseToken')::uuid,'synthetic-frozen-v1');
 IF snapshot->'rules'->0->>'points'<>'1.2345' THEN RAISE EXCEPTION 'frozen rules snapshot unavailable'; END IF;
 PERFORM reputation.save_proposal((j->>'itemId')::uuid,(j->>'leaseToken')::uuid,'{"state":"proposed","classification":"concrete_completed","points":"999999"}');
 result:=reputation.complete_report((j->>'itemId')::uuid,(j->>'leaseToken')::uuid,'synthetic-frozen-v1','synthetic-help',CASE WHEN n<=2 THEN 'same-synthetic-occurrence' ELSE 'different-synthetic-occurrence' END,j->>'sourceId');
 IF n=1 THEN
 first_item:=(j->>'itemId')::uuid; first_lease:=(j->>'leaseToken')::uuid;
 IF result->'item'->>'points'<>'1.2345' OR result->'item'->>'category'<>'help' OR result->'item'->>'status'<>'accepted' THEN RAISE EXCEPTION 'worker controlled score/category'; END IF;
 IF reputation.complete_report(first_item,first_lease,'synthetic-frozen-v1','synthetic-help','same-synthetic-occurrence',j->>'sourceId')<>result THEN RAISE EXCEPTION 'job receipt not immutable replay'; END IF;
 ELSIF n=2 THEN
 IF result->'item'->>'status'<>'excluded' OR result->'item'->>'reason'<>'duplicate_occurrence' THEN RAISE EXCEPTION 'semantic duplicate awarded'; END IF;
 ELSIF n=3 THEN
 IF result->'item'->>'status'<>'excluded' OR result->'item'->>'reason'<>'configured_cap_reached' THEN RAISE EXCEPTION 'calendar cap bypassed'; END IF;
 END IF;
 END LOOP;
 IF n<>3 THEN RAISE EXCEPTION 'reports not atomically enqueued'; END IF;
 BEGIN
 PERFORM reputation.complete_report(first_item,gen_random_uuid(),'synthetic-frozen-v1','synthetic-help','same-synthetic-occurrence',first_item::text);
 RAISE EXCEPTION 'stale lease replay accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 j:=reputation.claim_job(ARRAY['external'],60);
 result:=reputation.complete_external((j->>'itemId')::uuid,(j->>'leaseToken')::uuid,'synthetic-worker','synthetic-external-source','https://example.invalid/evidence');
 IF result->'item'->>'status'<>'accepted' OR result->'item'->>'points'<>'0.0001' THEN RAISE EXCEPTION 'external worker did not use frozen mission points'; END IF;
 IF reputation.complete_external((j->>'itemId')::uuid,(j->>'leaseToken')::uuid,'synthetic-worker','synthetic-external-source','https://example.invalid/evidence')<>result THEN RAISE EXCEPTION 'external job replay changed'; END IF;
 BEGIN
 PERFORM 1 FROM reputation.jobs;
 RAISE EXCEPTION 'worker has base-table access';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET LOCAL ROLE reputation_service;
SELECT reputation.report('synthetic-worker-unconfigured','Synthetic unconfigured','Must stay pending',clock_timestamp(),NULL);
SET LOCAL ROLE reputation_worker;
DO $$
DECLARE j jsonb; result jsonb;
BEGIN
 j:=reputation.claim_job(ARRAY['interpretation'],60);
 result:=reputation.complete_report((j->>'itemId')::uuid,(j->>'leaseToken')::uuid,'no-configured-rule','unknown','synthetic-unconfigured',j->>'sourceId');
 IF result->>'state'<>'ready' THEN RAISE EXCEPTION 'unconfigured rule completed item'; END IF;
 BEGIN
 PERFORM reputation.retry_job((j->>'itemId')::uuid,(j->>'leaseToken')::uuid,10,'stale lease');
 RAISE EXCEPTION 'retry reused expired lease';
 EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
SET LOCAL ROLE reputation_owner;
DO $$ BEGIN
 IF EXISTS(SELECT FROM reputation.items WHERE title='Synthetic unconfigured' AND status<>'pending') THEN RAISE EXCEPTION 'no-rule path changed canonical status'; END IF;
 IF (SELECT count(*) FROM reputation.job_receipts WHERE item_id IN (SELECT id FROM reputation.items WHERE subject_id='a0720000-0000-4000-8000-000000000011'))<>4 THEN RAISE EXCEPTION 'job decisions/receipts diverged'; END IF;
 BEGIN
 UPDATE reputation.rules SET units=999 WHERE rules_hash='synthetic-frozen-v1';
 RAISE EXCEPTION 'frozen weights mutable';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
