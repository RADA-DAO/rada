BEGIN;
SET LOCAL ROLE reputation_operator;
SELECT reputation.configure_mission('a0700000-0000-4000-8000-000000000001',1,'Synthetic overview','Acknowledgement fixture','participation','2.3456','synthetic-rule','acknowledgement',NULL,true);
SET LOCAL ROLE reputation_service;
SELECT set_config('rada.subject_id','a0700000-0000-4000-8000-000000000011',true);
DO $$
DECLARE receipt jsonb; overview jsonb; item uuid; a jsonb;
BEGIN
 receipt:=reputation.verify('a0700000-0000-4000-8000-000000000001',1,'synthetic-overview-ack');
 item:=(receipt->'item'->>'id')::uuid;
 overview:=reputation.overview('history','today',NULL);
 IF overview->'summary'->>'totalPoints'<>'2.3456' OR overview->'page'->'items'->0->>'id'<>item::text
 OR (overview->'page'->'items'->0->>'occurredAt')::timestamptz>=(overview->'summary'->>'end')::timestamptz
 THEN RAISE EXCEPTION 'overview snapshot/as-of mismatch'; END IF;
 IF reputation.overview('tasks','today')->'page'->'items'->0->>'status'<>'completed' THEN RAISE EXCEPTION 'overview mission not completed'; END IF;
 a:=reputation.appeal(item,'synthetic-overview-appeal','Please review');
 IF reputation.appeal_command('synthetic-overview-appeal')<>a OR reputation.appeal_command('synthetic-overview-ack') IS NOT NULL THEN RAISE EXCEPTION 'appeal recovery is not exact typed receipt'; END IF;
 BEGIN
 PERFORM reputation.overview('invalid','today');
 RAISE EXCEPTION 'invalid overview accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
 PERFORM reputation.summary_at('today',clock_timestamp());
 RAISE EXCEPTION 'public reader controls summary clock';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT set_config('rada.subject_id','a0700000-0000-4000-8000-000000000012',true);
DO $$ BEGIN
 IF reputation.appeal_command('synthetic-overview-appeal') IS NOT NULL
 OR reputation.overview('history','today')->'summary'->>'totalPoints'<>'0'
 OR jsonb_array_length(reputation.overview('history','today')->'page'->'items')<>0 THEN RAISE EXCEPTION 'overview/receipt cross-subject disclosure'; END IF;
END $$;
ROLLBACK;
