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
RESET ROLE;
