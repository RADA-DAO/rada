SET LOCAL ROLE reputation_owner;
CREATE TABLE reputation.source_receipts (
 source text NOT NULL CHECK(length(source) BETWEEN 1 AND 128),
 source_key text NOT NULL CHECK(length(source_key) BETWEEN 1 AND 256),
 fingerprint jsonb NOT NULL, receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(source,source_key)
);
CREATE TRIGGER source_receipts_immutable BEFORE UPDATE OR DELETE ON reputation.source_receipts FOR EACH ROW EXECUTE FUNCTION reputation.immutable();
-- Authenticated server adapters provide attribution and dated evidence only.
-- This capability cannot supply a score, policy hash or classification decision.
-- occurred_at is an exact microsecond instant; trusted callers must reject finer
-- source precision before casting, as enforced by PostgresReputationSourceStore.
CREATE FUNCTION reputation.ingest_fact(subject uuid,source text,source_key text,title text,description text,occurred_at timestamptz,evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE previous reputation.source_receipts; fingerprint jsonb; result jsonb; i reputation.items; proof jsonb; keys text[];
BEGIN
 IF subject IS NULL OR source IS NULL OR length(source) NOT BETWEEN 1 AND 128 OR source_key IS NULL OR length(source_key) NOT BETWEEN 1 AND 256
 OR title IS NULL OR length(btrim(title)) NOT BETWEEN 1 AND 200 OR description IS NULL OR length(btrim(description)) NOT BETWEEN 1 AND 8000
 OR occurred_at IS NULL OR NOT isfinite(occurred_at) OR occurred_at>clock_timestamp()
 OR evidence IS NULL OR jsonb_typeof(evidence)<>'array' THEN RAISE EXCEPTION 'invalid_source_fact' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(evidence) NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'invalid_source_evidence' USING ERRCODE='22023'; END IF;
 FOR proof IN SELECT value FROM jsonb_array_elements(evidence) LOOP
 IF jsonb_typeof(proof)<>'object' THEN RAISE EXCEPTION 'invalid_source_evidence' USING ERRCODE='22023'; END IF;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(proof) k;
 IF keys IS DISTINCT FROM (ARRAY['id','label','url']) OR jsonb_typeof(proof->'id')<>'string' OR length(proof->>'id') NOT BETWEEN 1 AND 128
 OR jsonb_typeof(proof->'label')<>'string' OR length(btrim(proof->>'label')) NOT BETWEEN 1 AND 200
 OR jsonb_typeof(proof->'url')<>'string' OR length(proof->>'url')>2048 OR proof->>'url' !~ '^https://[^[:space:]]+$'
 THEN RAISE EXCEPTION 'invalid_source_evidence' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(evidence))<>jsonb_array_length(evidence)
 OR (SELECT count(DISTINCT value->>'url') FROM jsonb_array_elements(evidence))<>jsonb_array_length(evidence)
 THEN RAISE EXCEPTION 'duplicate_source_evidence' USING ERRCODE='22023'; END IF;
 fingerprint:=jsonb_build_object('subject',subject,'title',title,'description',description,'occurredAt',occurred_at,'evidence',evidence);
 PERFORM reputation.lock_subject(subject);
 SELECT * INTO previous FROM reputation.source_receipts r WHERE r.source=ingest_fact.source AND r.source_key=ingest_fact.source_key;
 IF FOUND THEN
 IF previous.fingerprint<>fingerprint THEN RAISE EXCEPTION 'source_fact_conflict' USING ERRCODE='23505'; END IF;
 RETURN previous.receipt;
 END IF;
 INSERT INTO reputation.items(subject_id,title,description,category,status,reason,occurred_at,evidence,source,source_id)
 VALUES(subject,title,description,'work','pending','awaiting_interpretation',occurred_at,evidence,'fact:'||source,source_key) RETURNING * INTO i;
 PERFORM reputation.emit(subject,'item',i.id);
 result:=jsonb_build_object('item',reputation.item_json(i),'source',source,'sourceKey',source_key);
 INSERT INTO reputation.source_receipts(source,source_key,fingerprint,receipt) VALUES(source,source_key,fingerprint,result);
 RETURN result;
END $$;
GRANT EXECUTE ON FUNCTION reputation.ingest_fact(uuid,text,text,text,text,timestamptz,jsonb) TO reputation_ingress;
-- Deterministic source facts never enter the semantic interpretation queue.
ALTER TABLE reputation.jobs DROP CONSTRAINT jobs_lane_check;
ALTER TABLE reputation.jobs ADD CONSTRAINT jobs_lane_check CHECK(lane IN ('interpretation','external','source_fact'));
CREATE OR REPLACE FUNCTION reputation.enqueue_pending() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.status='pending' THEN
 INSERT INTO reputation.jobs(item_id,lane) VALUES(NEW.id,CASE WHEN NEW.source LIKE 'fact:%' THEN 'source_fact' WHEN NEW.mission_id IS NULL THEN 'interpretation' ELSE 'external' END)
 ON CONFLICT(item_id) DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION reputation.claim_job_internal(lanes text[],lease_seconds integer DEFAULT 60) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j reputation.jobs; i reputation.items;
BEGIN
 IF lanes IS NULL OR cardinality(lanes) NOT BETWEEN 1 AND 3 OR NOT lanes<@ARRAY['interpretation','external','source_fact']::text[]
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
CREATE OR REPLACE FUNCTION reputation.complete_report(item uuid,token uuid,hash text,key text,semantic text,source_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j reputation.jobs; i reputation.items; r reputation.rules; result jsonb; fingerprint jsonb;
 target_status text:='accepted'; target_reason text:='frozen_rule_accepted'; target_units bigint; lo timestamptz; hi timestamptz;
BEGIN
 IF hash IS NULL OR length(hash) NOT BETWEEN 1 AND 256 OR key IS NULL OR length(key) NOT BETWEEN 1 AND 128
 OR semantic IS NULL OR length(semantic) NOT BETWEEN 1 AND 256 OR source_id IS NULL OR length(source_id) NOT BETWEEN 1 AND 256
 THEN RAISE EXCEPTION 'invalid_report_commit' USING ERRCODE='22023'; END IF;
 fingerprint:=jsonb_build_object('kind','report','rulesHash',hash,'key',key,'semanticKey',semantic,'sourceId',source_id);
 result:=reputation.job_receipt(item,token,fingerprint); IF result IS NOT NULL THEN RETURN result; END IF;
 j:=reputation.lock_job(item,token);
 result:=reputation.job_receipt(item,token,fingerprint); IF result IS NOT NULL THEN RETURN result; END IF;
 SELECT * INTO i FROM reputation.items WHERE id=item;
 IF j.lane NOT IN ('interpretation','source_fact') OR i.mission_id IS NOT NULL OR i.status<>'pending' THEN RAISE EXCEPTION 'not_pending_report' USING ERRCODE='23505'; END IF;
 -- Source identity comes from the durable input, not the provider's response.
 IF source_id<>item::text THEN RAISE EXCEPTION 'source_conflict' USING ERRCODE='23505'; END IF;
 SELECT * INTO r FROM reputation.rules WHERE rules_hash=hash AND rule_key=key
 AND i.occurred_at>=valid_from AND (valid_to IS NULL OR i.occurred_at<valid_to);
 IF NOT FOUND THEN RETURN reputation.retry_job(item,token,300,'rule_unconfigured_or_not_effective'); END IF;
 target_units:=r.units;
 IF EXISTS(SELECT FROM reputation.report_awards WHERE subject_id=i.subject_id AND semantic_key=semantic) THEN
 target_status:='excluded'; target_reason:='duplicate_occurrence'; target_units:=0;
 ELSIF r.cap_unit<>'occurrence' THEN
 lo:=date_trunc(CASE WHEN r.cap_unit='kyiv_day' THEN 'day' ELSE 'week' END,i.occurred_at AT TIME ZONE 'Europe/Kyiv') AT TIME ZONE 'Europe/Kyiv';
 hi:=((lo AT TIME ZONE 'Europe/Kyiv')+CASE WHEN r.cap_unit='kyiv_day' THEN interval '1 day' ELSE interval '7 days' END) AT TIME ZONE 'Europe/Kyiv';
 -- Corrections may free active capacity; the immutable semantic journal still
 -- prevents a corrected occurrence from being awarded again.
 IF (SELECT count(*) FROM reputation.report_awards a JOIN reputation.items current_item ON (current_item.id=a.item_id)
 WHERE a.subject_id=i.subject_id AND a.rule_key=key AND a.occurred_at>=lo AND a.occurred_at<hi AND current_item.status='accepted')>=r.cap_limit THEN
 target_status:='excluded'; target_reason:='configured_cap_reached'; target_units:=0;
 END IF;
 END IF;
 IF target_status='accepted' THEN
 INSERT INTO reputation.report_awards(item_id,subject_id,semantic_key,rules_hash,rule_key,source_id,occurred_at)
 VALUES(item,i.subject_id,semantic,hash,key,source_id,i.occurred_at);
 END IF;
 INSERT INTO reputation.decisions(subject_id,item_id,source,source_id,units,status,reason,evidence)
 VALUES(i.subject_id,item,'report-rule',source_id,target_units,target_status,target_reason,i.evidence);
 UPDATE reputation.items SET units=target_units,status=target_status,reason=target_reason,category=r.category,rule_hash=r.rules_hash
 WHERE id=item RETURNING * INTO i;
 PERFORM reputation.emit(i.subject_id,'item',item);
 result:=jsonb_build_object('state','completed','item',reputation.item_json(i));
 UPDATE reputation.jobs SET state='completed',lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE item_id=item;
 INSERT INTO reputation.job_receipts(item_id,lease_token,fingerprint,receipt) VALUES(item,token,fingerprint,result);
 RETURN result;
END $$;
RESET ROLE;
