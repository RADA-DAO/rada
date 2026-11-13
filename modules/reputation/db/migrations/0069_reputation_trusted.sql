SET LOCAL ROLE reputation_owner;
-- Operator-only configuration: disabled by default, never called by public HTTP.
CREATE FUNCTION reputation.configure_mission(id uuid,version integer,title text,description text,category text,points text,rule_hash text,verifier text,action_url text,enabled boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF points IS NULL OR points !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,4})?$' THEN RAISE EXCEPTION 'invalid_points' USING ERRCODE='22023'; END IF;
 INSERT INTO reputation.missions(id,version,title,description,category,units,rule_hash,verifier,action_url,enabled)
 VALUES(id,version,title,description,category,(points::numeric*10000)::bigint,rule_hash,verifier,action_url,enabled);
END $$;
CREATE FUNCTION reputation.set_mission_enabled(mission uuid,enabled boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE reputation.missions SET enabled=set_mission_enabled.enabled WHERE id=mission;
 IF NOT FOUND THEN RAISE EXCEPTION 'mission_not_found' USING ERRCODE='P0002'; END IF;
END $$;
GRANT EXECUTE ON FUNCTION reputation.set_mission_enabled(uuid,boolean) TO reputation_operator;
-- Trusted evidence can finish only a pending external mission; it cannot change
-- a previous award. The source namespace is assigned by role-scoped adapters.
CREATE FUNCTION reputation.finalize_external(item uuid,source text,source_id text,evidence_url text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE i reputation.items; m reputation.missions; d reputation.decisions; s uuid; ev jsonb;
BEGIN
 IF source IS NULL OR length(source) NOT BETWEEN 1 AND 128 OR source_id IS NULL OR length(source_id) NOT BETWEEN 1 AND 256
 OR evidence_url IS NULL OR length(evidence_url)>2048 OR evidence_url !~ '^https://[^[:space:]]+$' THEN RAISE EXCEPTION 'invalid_evidence' USING ERRCODE='22023'; END IF;
 SELECT subject_id INTO s FROM reputation.items WHERE id=item;
 IF s IS NULL THEN RAISE EXCEPTION 'item_not_found' USING ERRCODE='P0002'; END IF;
 PERFORM reputation.lock_subject(s);
 SELECT * INTO i FROM reputation.items WHERE id=item;
 SELECT * INTO d FROM reputation.decisions WHERE decisions.source='external:'||finalize_external.source AND decisions.source_id=finalize_external.source_id;
 IF FOUND THEN
 IF d.item_id<>item OR d.evidence->0->>'url' IS DISTINCT FROM evidence_url THEN RAISE EXCEPTION 'source_conflict' USING ERRCODE='23505'; END IF;
 RETURN reputation.item_json(i);
 END IF;
 SELECT * INTO m FROM reputation.missions WHERE id=i.mission_id AND verifier='external';
 IF NOT FOUND OR i.status<>'pending' THEN RAISE EXCEPTION 'not_pending_external' USING ERRCODE='23505'; END IF;
 ev:=jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'url',evidence_url,'label','Verified evidence'));
 INSERT INTO reputation.decisions(subject_id,item_id,source,source_id,units,status,reason,evidence)
 VALUES(s,item,'external:'||source,source_id,m.units,'accepted','trusted_external_evidence',ev);
 UPDATE reputation.items SET units=m.units,status='accepted',reason='trusted_external_evidence',evidence=ev WHERE id=item RETURNING * INTO i;
 PERFORM reputation.emit(s,'item',item);
 RETURN reputation.item_json(i);
END $$;
-- Explicit correction authority is separate from trusted verification. Decisions
-- append permanently; the visible item is a projection of the latest decision.
CREATE FUNCTION reputation.correct(item uuid,source_id text,points text,status text,reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE i reputation.items; s uuid; d reputation.decisions; v_units bigint;
BEGIN
 IF points IS NULL OR points !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,4})?$' OR status IS NULL OR status NOT IN ('accepted','excluded','superseded')
 OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 1 AND 4000 OR source_id IS NULL OR length(source_id) NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'invalid_correction' USING ERRCODE='22023'; END IF;
 v_units:=(points::numeric*10000)::bigint;
 IF status<>'accepted' AND v_units<>0 THEN RAISE EXCEPTION 'invalid_correction' USING ERRCODE='22023'; END IF;
 SELECT subject_id INTO s FROM reputation.items WHERE id=item;
 IF s IS NULL THEN RAISE EXCEPTION 'item_not_found' USING ERRCODE='P0002'; END IF;
 PERFORM reputation.lock_subject(s);
 SELECT * INTO i FROM reputation.items WHERE id=item;
 SELECT * INTO d FROM reputation.decisions WHERE source='correction' AND decisions.source_id=correct.source_id;
 IF FOUND THEN
 IF d.item_id<>item OR d.units<>v_units OR d.status<>status OR d.reason<>reason THEN RAISE EXCEPTION 'source_conflict' USING ERRCODE='23505'; END IF;
 RETURN reputation.item_json(i);
 END IF;
 INSERT INTO reputation.decisions(subject_id,item_id,source,source_id,units,status,reason,evidence) VALUES(s,item,'correction',source_id,v_units,status,reason,i.evidence);
 UPDATE reputation.items SET units=v_units,status=correct.status,reason=correct.reason WHERE id=item RETURNING * INTO i;
 PERFORM reputation.emit(s,'item',item);
 RETURN reputation.item_json(i);
END $$;
GRANT EXECUTE ON FUNCTION reputation.configure_mission(uuid,integer,text,text,text,text,text,text,text,boolean),reputation.correct(uuid,text,text,text,text) TO reputation_operator;
GRANT EXECUTE ON FUNCTION reputation.finalize_external(uuid,text,text,text) TO reputation_ingress;
RESET ROLE;
