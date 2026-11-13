BEGIN;
SET LOCAL ROLE reputation_owner;
UPDATE reputation.jobs SET retry_at=clock_timestamp()+interval '1 day';
INSERT INTO reputation.items(id,subject_id,title,description,category,status,reason,occurred_at)
VALUES('a0720000-0000-4000-8000-000000000099','a0720000-0000-4000-8000-000000000098','Synthetic lease fixture','Concrete work','work','pending','awaiting_interpretation',clock_timestamp());
UPDATE reputation.jobs SET max_attempts=2,retry_at=clock_timestamp()-interval '2 days' WHERE item_id='a0720000-0000-4000-8000-000000000099';
SET LOCAL ROLE reputation_worker;
SELECT set_config('test.first_token',reputation.claim_job(ARRAY['interpretation'],5)->>'leaseToken',true);
SET LOCAL ROLE reputation_owner;
UPDATE reputation.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE item_id='a0720000-0000-4000-8000-000000000099';
SET LOCAL ROLE reputation_worker;
DO $$
DECLARE second jsonb;
BEGIN
 second:=reputation.claim_job(ARRAY['interpretation'],5);
 IF second->>'leaseToken'=current_setting('test.first_token') OR second->>'attempt'<>'2' THEN RAISE EXCEPTION 'crashed lease not reclaimed'; END IF;
 IF second ? 'telegramUserId' THEN RAISE EXCEPTION 'interpretation job exposed Telegram identity'; END IF;
 BEGIN
 PERFORM reputation.retry_job('a0720000-0000-4000-8000-000000000099',current_setting('test.first_token')::uuid,10,'stale worker');
 RAISE EXCEPTION 'stale worker retained authority';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
 PERFORM reputation.requeue_job('a0720000-0000-4000-8000-000000000099',2,'Worker cannot extend its budget');
 RAISE EXCEPTION 'worker acquired operator budget authority';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SET LOCAL ROLE reputation_operator;
DO $$ BEGIN
 BEGIN
 PERFORM reputation.requeue_job('a0720000-0000-4000-8000-000000000099',2,'Active lease must not reset');
 RAISE EXCEPTION 'operator reset active lease';
 EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
SET LOCAL ROLE reputation_owner;
UPDATE reputation.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE item_id='a0720000-0000-4000-8000-000000000099';
SET LOCAL ROLE reputation_worker;
DO $$ BEGIN
 IF reputation.claim_job(ARRAY['interpretation'],5) IS NOT NULL THEN RAISE EXCEPTION 'attempt budget exceeded'; END IF;
END $$;
SET LOCAL ROLE reputation_owner;
DO $$ BEGIN
 IF (SELECT state FROM reputation.jobs WHERE item_id='a0720000-0000-4000-8000-000000000099')<>'blocked' THEN RAISE EXCEPTION 'exhausted crash not durably blocked'; END IF;
END $$;
SET LOCAL ROLE reputation_operator;
SELECT reputation.requeue_job('a0720000-0000-4000-8000-000000000099',2,'Synthetic dependency repaired');
SET LOCAL ROLE reputation_worker;
DO $$ BEGIN
 IF reputation.claim_job(ARRAY['interpretation'],5)->>'attempt'<>'1' THEN RAISE EXCEPTION 'explicit repair did not reopen budget'; END IF;
END $$;
SET LOCAL ROLE reputation_owner;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM reputation.job_proposals WHERE item_id='a0720000-0000-4000-8000-000000000099' AND proposal->>'state'='operator_requeue') THEN RAISE EXCEPTION 'operator repair history missing'; END IF;
END $$;
ROLLBACK;
