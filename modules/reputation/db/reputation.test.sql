BEGIN;
SET LOCAL ROLE reputation_operator;
SELECT reputation.configure_mission('a0660000-0000-4000-8000-000000000001',1,'Synthetic acknowledgement','Only acknowledges the signed statement','participation','0.0001','synthetic-rule','acknowledgement',NULL,true);
SELECT reputation.configure_mission('a0660000-0000-4000-8000-000000000002',1,'Synthetic external','Requires a trusted adapter','help','1.2345','synthetic-rule','external',NULL,true);
SET LOCAL ROLE reputation_service;
SELECT set_config('rada.subject_id','a0660000-0000-4000-8000-000000000011',true);
DO $$
DECLARE first jsonb; replay jsonb; dedupe jsonb; result jsonb; points text; revision text; item uuid; before_revision text;
BEGIN
 first:=reputation.verify('a0660000-0000-4000-8000-000000000001',1,'synthetic-ack');
 IF first->>'state'<>'completed' OR first->'summary'->>'totalPoints'<>'0.0001' THEN RAISE EXCEPTION 'award not atomic/exact'; END IF;
 replay:=reputation.verify('a0660000-0000-4000-8000-000000000001',1,'synthetic-ack');
 IF replay<>first THEN RAISE EXCEPTION 'receipt changed'; END IF;
 dedupe:=reputation.verify('a0660000-0000-4000-8000-000000000001',1,'synthetic-ack-second');
 IF dedupe->'item'<>first->'item' OR dedupe->'summary'->>'revision'<>first->'summary'->>'revision' THEN RAISE EXCEPTION 'semantic award duplicated'; END IF;
 BEGIN
 PERFORM reputation.report('synthetic-ack','Synthetic report','Concrete work',clock_timestamp(),NULL);
 RAISE EXCEPTION 'cross-command request conflict missing';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
 PERFORM reputation.verify('a0660000-0000-4000-8000-000000000001',2,'synthetic-ack');
 RAISE EXCEPTION 'changed request accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 IF reputation.summary('all')->>'totalPoints'<>'0.0001' THEN RAISE EXCEPTION 'failed verification changed points'; END IF;
 result:=reputation.report('synthetic-report','Synthetic report','Concrete work without an attachment',clock_timestamp(),NULL);
 IF result->>'state'<>'checking' OR result->'item'->>'status'<>'pending' OR result->'item'->'evidence'<>'[]'::jsonb THEN RAISE EXCEPTION 'unattached report not durable pending'; END IF;
 IF reputation.command('synthetic-report')<>result THEN RAISE EXCEPTION 'lost response not recovered'; END IF;
 before_revision:=reputation.summary('all')->>'revision';
 BEGIN
 PERFORM reputation.report('synthetic-rolled-back','Rollback fixture','Must not survive',clock_timestamp(),NULL);
 RAISE EXCEPTION 'synthetic failure';
 EXCEPTION WHEN raise_exception THEN NULL; END;
 IF reputation.command('synthetic-rolled-back') IS NOT NULL OR reputation.summary('all')->>'revision'<>before_revision THEN RAISE EXCEPTION 'failed transaction leaked state'; END IF;
 item:=(first->'item'->>'id')::uuid;
 result:=reputation.appeal(item,'synthetic-appeal','Please review the reason');
 IF reputation.appeal(item,'synthetic-appeal','Please review the reason')<>result THEN RAISE EXCEPTION 'appeal replay changed'; END IF;
 IF reputation.summary('all')->>'totalPoints'<>'0.0001' THEN RAISE EXCEPTION 'appeal changed score'; END IF;
 IF jsonb_array_length(reputation.read_appeals(item))<>1 THEN RAISE EXCEPTION 'appeal duplicated'; END IF;
 IF reputation.changes(0)->>'nextCursor'<>reputation.summary('all')->>'revision' OR jsonb_array_length(reputation.changes(0)->'changes')<>3 THEN RAISE EXCEPTION 'durable changes missing'; END IF;
 result:=reputation.verify('a0660000-0000-4000-8000-000000000002',1,'synthetic-external');
 IF result->>'state'<>'checking' OR result->'item'->>'points'<>'0' OR result->'summary'->>'totalPoints'<>'0.0001' THEN RAISE EXCEPTION 'external mission awarded untrusted points'; END IF;
 BEGIN
 PERFORM reputation.finalize_external((result->'item'->>'id')::uuid,'synthetic','event-1','https://example.invalid/evidence');
 RAISE EXCEPTION 'public role finalized external mission';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
 PERFORM reputation.correct(item,'synthetic-correction','9','accepted','Unauthorized override');
 RAISE EXCEPTION 'public role corrected score';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
 PERFORM 1 FROM reputation.items;
 RAISE EXCEPTION 'public role has base-table read';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
-- Another verified subject cannot see any records, receipts or appeals.
SELECT set_config('rada.subject_id','a0660000-0000-4000-8000-000000000012',true);
DO $$ BEGIN
 IF reputation.command('synthetic-ack') IS NOT NULL OR reputation.summary('all')->>'totalPoints'<>'0'
 OR jsonb_array_length(reputation.changes(0)->'changes')<>0
 OR jsonb_array_length(reputation.read_items('all')->'items')<>0 THEN RAISE EXCEPTION 'cross-subject disclosure'; END IF;
END $$;
SET LOCAL ROLE reputation_owner;
DO $$
DECLARE item uuid; result jsonb;
BEGIN
 SELECT id INTO item FROM reputation.items WHERE subject_id='a0660000-0000-4000-8000-000000000011' AND mission_id='a0660000-0000-4000-8000-000000000002';
 result:=reputation.finalize_external(item,'synthetic','event-1','https://example.invalid/evidence');
 IF result->>'points'<>'1.2345' OR result->>'status'<>'accepted' THEN RAISE EXCEPTION 'trusted evidence did not award exact points'; END IF;
 IF reputation.finalize_external(item,'synthetic','event-1','https://example.invalid/evidence')<>result THEN RAISE EXCEPTION 'trusted ingress not idempotent'; END IF;
 BEGIN
 PERFORM reputation.finalize_external(item,'synthetic','event-1','https://example.invalid/different');
 RAISE EXCEPTION 'source fingerprint conflict missing';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
 UPDATE reputation.commands SET receipt='{}';
 RAISE EXCEPTION 'receipt mutable';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
 DELETE FROM reputation.decisions;
 RAISE EXCEPTION 'decision mutable';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- Spring transition week has 167 hours; autumn has 169.
 IF (SELECT end_at-start_at FROM reputation.bounds('previous_week','2026-03-30T12:00:00Z'))<>interval '167 hours'
 OR (SELECT end_at-start_at FROM reputation.bounds('previous_week','2026-10-26T12:00:00Z'))<>interval '169 hours' THEN RAISE EXCEPTION 'Kyiv DST periods incorrect'; END IF;
END $$;
SET LOCAL ROLE reputation_service;
SELECT set_config('rada.subject_id','a0660000-0000-4000-8000-000000000011',true);
DO $$ BEGIN
 IF reputation.summary('all')->>'totalPoints'<>'1.2346' THEN RAISE EXCEPTION 'trusted completion summary mismatch'; END IF;
 IF reputation.command('synthetic-external')->>'state'<>'checking' THEN RAISE EXCEPTION 'immutable original receipt changed after finalization'; END IF;
END $$;
ROLLBACK;
