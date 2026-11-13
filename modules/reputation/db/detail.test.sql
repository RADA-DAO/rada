BEGIN;
SET LOCAL ROLE reputation_operator;
SELECT reputation.configure_mission('a0710000-0000-4000-8000-000000000001',1,'Synthetic detail','Acknowledgement fixture','participation','1.2345','synthetic-rule','acknowledgement',NULL,true);
SET LOCAL ROLE reputation_service;
SELECT set_config('rada.subject_id','a0710000-0000-4000-8000-000000000011',true);
DO $$
DECLARE receipt jsonb; detail jsonb; item uuid;
BEGIN
 receipt:=reputation.verify('a0710000-0000-4000-8000-000000000001',1,'synthetic-detail-ack');
 item:=(receipt->'item'->>'id')::uuid;
 PERFORM reputation.appeal(item,'synthetic-detail-appeal','Please review');
 detail:=reputation.detail(item,'today');
 IF detail->'summary'->>'totalPoints'<>'1.2345' OR detail->'summary'->>'revision'<>'2'
 OR detail->'item'->>'id'<>item::text OR jsonb_array_length(detail->'appeals')<>1
 OR (detail->'item'->>'occurredAt')::timestamptz>=(detail->'summary'->>'end')::timestamptz
 THEN RAISE EXCEPTION 'detail snapshot/as-of mismatch'; END IF;
 PERFORM set_config('rada.subject_id','a0710000-0000-4000-8000-000000000012',true);
 IF reputation.detail(item,'today') IS NOT NULL THEN RAISE EXCEPTION 'detail cross-subject disclosure'; END IF;
 IF reputation.detail('a0710000-0000-4000-8000-000000000099','today') IS NOT NULL THEN RAISE EXCEPTION 'absent detail disclosed'; END IF;
END $$;
ROLLBACK;
