CREATE ROLE reputation_worker NOLOGIN;
GRANT USAGE ON SCHEMA reputation TO reputation_worker;
SET LOCAL ROLE reputation_owner;
CREATE TABLE reputation.jobs (
 item_id uuid PRIMARY KEY REFERENCES reputation.items, lane text NOT NULL CHECK(lane IN ('interpretation','external')),
 state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','leased','completed','blocked')),
 attempt integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 8 CHECK(max_attempts BETWEEN 1 AND 20),
 retry_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_token uuid, lease_until timestamptz,
 last_error text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(attempt BETWEEN 0 AND max_attempts), CHECK((state='leased')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX jobs_ready ON reputation.jobs(lane,retry_at,item_id) WHERE state='ready';
CREATE INDEX jobs_expired ON reputation.jobs(lease_until,item_id) WHERE state='leased';
CREATE TABLE reputation.job_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), item_id uuid NOT NULL REFERENCES reputation.jobs,
 attempt integer NOT NULL, proposal jsonb NOT NULL CHECK(jsonb_typeof(proposal)='object' AND octet_length(proposal::text)<=16384),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX job_proposals_item ON reputation.job_proposals(item_id,created_at,id);
CREATE TABLE reputation.job_receipts (
 item_id uuid PRIMARY KEY REFERENCES reputation.jobs, lease_token uuid NOT NULL,
 fingerprint jsonb NOT NULL, receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER job_receipts_immutable BEFORE UPDATE OR DELETE ON reputation.job_receipts FOR EACH ROW EXECUTE FUNCTION reputation.immutable();
CREATE TRIGGER job_proposals_immutable BEFORE UPDATE OR DELETE ON reputation.job_proposals FOR EACH ROW EXECUTE FUNCTION reputation.immutable();
CREATE FUNCTION reputation.enqueue_pending() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.status='pending' THEN
 INSERT INTO reputation.jobs(item_id,lane) VALUES(NEW.id,CASE WHEN NEW.mission_id IS NULL THEN 'interpretation' ELSE 'external' END)
 ON CONFLICT(item_id) DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER z_enqueue_pending AFTER INSERT ON reputation.items FOR EACH ROW EXECUTE FUNCTION reputation.enqueue_pending();
-- Include pending work already recorded before this migration.
INSERT INTO reputation.jobs(item_id,lane) SELECT id,CASE WHEN mission_id IS NULL THEN 'interpretation' ELSE 'external' END
FROM reputation.items WHERE status='pending' ON CONFLICT DO NOTHING;
CREATE FUNCTION reputation.claim_job(lanes text[],lease_seconds integer DEFAULT 60) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j reputation.jobs; i reputation.items;
BEGIN
 IF lanes IS NULL OR cardinality(lanes) NOT BETWEEN 1 AND 2 OR NOT lanes<@ARRAY['interpretation','external']::text[]
 OR lease_seconds IS NULL OR lease_seconds NOT BETWEEN 5 AND 300 THEN RAISE EXCEPTION 'invalid_claim' USING ERRCODE='22023'; END IF;
 -- Maintenance touches bounded unlocked rows; accepted items are never changed.
 WITH exhausted AS (SELECT item_id FROM reputation.jobs WHERE state='leased' AND lease_until<=clock_timestamp()
 AND attempt>=max_attempts FOR UPDATE SKIP LOCKED LIMIT 100)
 UPDATE reputation.jobs q SET state='blocked',lease_token=NULL,lease_until=NULL,last_error='lease_expired_attempt_budget',updated_at=clock_timestamp()
 FROM exhausted e WHERE q.item_id=e.item_id;
 WITH settled AS (SELECT q.item_id FROM reputation.jobs q JOIN reputation.items input ON (input.id=q.item_id)
 WHERE q.state IN ('ready','leased') AND input.status<>'pending' FOR UPDATE OF q SKIP LOCKED LIMIT 100)
 UPDATE reputation.jobs q SET state='completed',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
 FROM settled e WHERE q.item_id=e.item_id;
 -- Expired work is reclaimed lazily, without any process-local lock or startup reset.
 SELECT q.* INTO j FROM reputation.jobs q JOIN reputation.items input ON (input.id=q.item_id)
 WHERE q.lane=ANY(lanes) AND input.status='pending' AND q.attempt<q.max_attempts
 AND ((q.state='ready' AND q.retry_at<=clock_timestamp()) OR (q.state='leased' AND q.lease_until<=clock_timestamp()))
 ORDER BY q.retry_at,q.item_id FOR UPDATE OF q SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE reputation.jobs SET state='leased',attempt=attempt+1,lease_token=gen_random_uuid(),
 lease_until=clock_timestamp()+make_interval(secs=>lease_seconds),updated_at=clock_timestamp() WHERE item_id=j.item_id RETURNING * INTO j;
 SELECT * INTO i FROM reputation.items WHERE id=j.item_id;
 RETURN jsonb_build_object('itemId',j.item_id,'lane',j.lane,'leaseToken',j.lease_token,'leaseUntil',j.lease_until,
 'attempt',j.attempt,'subjectId',i.subject_id,'sourceId',i.id::text,'title',i.title,'description',i.description,
 'occurredAt',i.occurred_at,'evidence',i.evidence,'missionId',i.mission_id);
END $$;
CREATE FUNCTION reputation.lock_job(item uuid,token uuid) RETURNS reputation.jobs LANGUAGE plpgsql SET search_path='' AS $$
DECLARE j reputation.jobs; s uuid;
BEGIN
 SELECT subject_id INTO s FROM reputation.items WHERE id=item;
 IF s IS NULL THEN RAISE EXCEPTION 'job_not_found' USING ERRCODE='P0002'; END IF;
 PERFORM reputation.lock_subject(s);
 SELECT * INTO j FROM reputation.jobs WHERE item_id=item FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'job_not_found' USING ERRCODE='P0002'; END IF;
 IF token IS NULL OR j.lease_token IS DISTINCT FROM (token) OR j.state<>'leased' OR j.lease_until<=clock_timestamp()
 THEN RAISE EXCEPTION 'stale_lease' USING ERRCODE='23505'; END IF;
 RETURN j;
END $$;
CREATE FUNCTION reputation.retry_job(item uuid,token uuid,retry_seconds integer,reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j reputation.jobs;
BEGIN
 IF retry_seconds IS NULL OR retry_seconds NOT BETWEEN 1 AND 86400 OR reason IS NULL OR length(reason) NOT BETWEEN 1 AND 4000
 THEN RAISE EXCEPTION 'invalid_retry' USING ERRCODE='22023'; END IF;
 j:=reputation.lock_job(item,token);
 UPDATE reputation.jobs SET state=CASE WHEN attempt>=max_attempts THEN 'blocked' ELSE 'ready' END,
 retry_at=clock_timestamp()+make_interval(secs=>retry_seconds),lease_token=NULL,lease_until=NULL,last_error=reason,updated_at=clock_timestamp()
 WHERE item_id=item RETURNING * INTO j;
 RETURN jsonb_build_object('state',j.state,'retryAt',j.retry_at,'attempt',j.attempt,'reason',reason);
END $$;
CREATE FUNCTION reputation.save_proposal(item uuid,token uuid,proposal jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j reputation.jobs; result uuid;
BEGIN
 j:=reputation.lock_job(item,token);
 INSERT INTO reputation.job_proposals(item_id,attempt,proposal) VALUES(item,j.attempt,proposal) RETURNING id INTO result;
 RETURN result;
END $$;
CREATE FUNCTION reputation.job_receipt(item uuid,token uuid,fingerprint jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r reputation.job_receipts; s uuid;
BEGIN
 SELECT subject_id INTO s FROM reputation.items WHERE id=item;
 IF s IS NULL THEN RAISE EXCEPTION 'job_not_found' USING ERRCODE='P0002'; END IF;
 -- Serialize receipt lookup before lease validation, including concurrent replay.
 PERFORM reputation.lock_subject(s);
 SELECT * INTO r FROM reputation.job_receipts WHERE item_id=item;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF token IS NULL OR r.lease_token<>token OR r.fingerprint<>fingerprint THEN RAISE EXCEPTION 'job_receipt_conflict' USING ERRCODE='23505'; END IF;
 RETURN r.receipt;
END $$;
-- Only an explicit operator action can reopen an exhausted operational budget.
CREATE FUNCTION reputation.requeue_job(item uuid,budget integer,reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s uuid; j reputation.jobs;
BEGIN
 IF budget IS NULL OR budget NOT BETWEEN 1 AND 20 OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'invalid_requeue' USING ERRCODE='22023'; END IF;
 SELECT subject_id INTO s FROM reputation.items WHERE id=item AND status='pending';
 IF s IS NULL THEN RAISE EXCEPTION 'not_pending_item' USING ERRCODE='23505'; END IF;
 PERFORM reputation.lock_subject(s);
 IF NOT EXISTS(SELECT FROM reputation.items WHERE id=item AND status='pending') THEN RAISE EXCEPTION 'not_pending_item' USING ERRCODE='23505'; END IF;
 SELECT * INTO j FROM reputation.jobs WHERE item_id=item FOR UPDATE;
 IF NOT FOUND OR j.state<>'blocked' THEN RAISE EXCEPTION 'not_blocked_job' USING ERRCODE='23505'; END IF;
 INSERT INTO reputation.job_proposals(item_id,attempt,proposal) VALUES(item,j.attempt,jsonb_build_object('state','operator_requeue','reason',reason,'budget',budget));
 UPDATE reputation.jobs SET state='ready',attempt=0,max_attempts=budget,retry_at=clock_timestamp(),last_error=NULL,updated_at=clock_timestamp() WHERE item_id=item;
END $$;
GRANT EXECUTE ON FUNCTION reputation.requeue_job(uuid,integer,text) TO reputation_operator;
GRANT EXECUTE ON FUNCTION reputation.claim_job(text[],integer),reputation.retry_job(uuid,uuid,integer,text),reputation.save_proposal(uuid,uuid,jsonb) TO reputation_worker;
RESET ROLE;
