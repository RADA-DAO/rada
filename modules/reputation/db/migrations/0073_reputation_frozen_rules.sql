SET LOCAL ROLE reputation_owner;
CREATE TABLE reputation.rules (
 rules_hash text NOT NULL CHECK(length(rules_hash) BETWEEN 1 AND 256), rule_key text NOT NULL CHECK(length(rule_key) BETWEEN 1 AND 128),
 units bigint NOT NULL CHECK(units>=0), category text NOT NULL CHECK(category IN ('work','content','help','participation')),
 cap_unit text NOT NULL CHECK(cap_unit IN ('occurrence','kyiv_day','kyiv_week')), cap_limit bigint NOT NULL CHECK(cap_limit BETWEEN 1 AND 9007199254740991),
 valid_from timestamptz NOT NULL CHECK(isfinite(valid_from)), valid_to timestamptz CHECK(isfinite(valid_to)),
 CHECK(valid_to IS NULL OR valid_to>valid_from), PRIMARY KEY(rules_hash,rule_key)
);
CREATE TRIGGER rules_immutable BEFORE UPDATE OR DELETE ON reputation.rules FOR EACH ROW EXECUTE FUNCTION reputation.immutable();
CREATE TABLE reputation.report_awards (
 item_id uuid PRIMARY KEY REFERENCES reputation.items, subject_id uuid NOT NULL,
 semantic_key text NOT NULL CHECK(length(semantic_key) BETWEEN 1 AND 256), rules_hash text NOT NULL, rule_key text NOT NULL,
 source_id text NOT NULL UNIQUE CHECK(length(source_id) BETWEEN 1 AND 256), occurred_at timestamptz NOT NULL,
 FOREIGN KEY(rules_hash,rule_key) REFERENCES reputation.rules, UNIQUE(subject_id,semantic_key)
);
CREATE INDEX report_awards_cap ON reputation.report_awards(subject_id,rule_key,occurred_at);
CREATE TRIGGER report_awards_immutable BEFORE UPDATE OR DELETE ON reputation.report_awards FOR EACH ROW EXECUTE FUNCTION reputation.immutable();
CREATE FUNCTION reputation.configure_rule(config jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE keys text[]; cap_keys text[];
BEGIN
 IF config IS NULL OR jsonb_typeof(config)<>'object' OR jsonb_typeof(config->'cap')<>'object' THEN RAISE EXCEPTION 'invalid_rule' USING ERRCODE='22023'; END IF;
 SELECT array_agg(k ORDER BY k) INTO keys FROM jsonb_object_keys(config) k;
 SELECT array_agg(k ORDER BY k) INTO cap_keys FROM jsonb_object_keys(config->'cap') k;
 IF keys<>ARRAY['cap','category','key','points','rulesHash','validFrom','validTo'] OR cap_keys<>ARRAY['limit','unit']
 OR jsonb_typeof(config->'rulesHash')<>'string' OR jsonb_typeof(config->'key')<>'string'
 OR jsonb_typeof(config->'category')<>'string' OR jsonb_typeof(config->'cap'->'unit')<>'string'
 OR jsonb_typeof(config->'points')<>'string' OR config->>'points' !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$'
 OR jsonb_typeof(config->'cap'->'limit')<>'number' OR config->'cap'->>'limit' !~ '^[1-9][0-9]*$'
 OR jsonb_typeof(config->'validFrom')<>'string' OR jsonb_typeof(config->'validTo') NOT IN ('string','null')
 THEN RAISE EXCEPTION 'invalid_rule' USING ERRCODE='22023'; END IF;
 INSERT INTO reputation.rules(rules_hash,rule_key,units,category,cap_unit,cap_limit,valid_from,valid_to)
 VALUES(config->>'rulesHash',config->>'key',((config->>'points')::numeric*10000)::bigint,config->>'category',
 config->'cap'->>'unit',(config->'cap'->>'limit')::bigint,(config->>'validFrom')::timestamptz,(config->>'validTo')::timestamptz);
END $$;
CREATE FUNCTION reputation.job_rules(item uuid,token uuid,hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j reputation.jobs; at_time timestamptz; result jsonb;
BEGIN
 j:=reputation.lock_job(item,token);
 SELECT occurred_at INTO at_time FROM reputation.items WHERE id=item;
 SELECT jsonb_build_object('hash',hash,'rules',jsonb_agg(jsonb_build_object('key',rule_key,'points',reputation.points(units),'category',category,
 'cap',jsonb_build_object('unit',cap_unit,'limit',cap_limit)) ORDER BY rule_key)) INTO result
 FROM reputation.rules WHERE rules_hash=hash AND at_time>=valid_from AND (valid_to IS NULL OR at_time<valid_to);
 IF result->'rules'='null'::jsonb THEN RETURN NULL; END IF;
 RETURN result;
END $$;
GRANT EXECUTE ON FUNCTION reputation.configure_rule(jsonb) TO reputation_operator;
GRANT EXECUTE ON FUNCTION reputation.job_rules(uuid,uuid,text) TO reputation_worker;
RESET ROLE;
