SET LOCAL ROLE reputation_owner;
-- One request namespace across all command kinds. Call only under subject lock.
CREATE FUNCTION reputation.replay(s uuid, request text, input jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE previous reputation.commands;
BEGIN
 IF request IS NULL OR length(request) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE='22023'; END IF;
 SELECT * INTO previous FROM reputation.commands WHERE subject_id=s AND request_id=request;
 IF FOUND THEN
 IF previous.fingerprint<>input THEN RAISE EXCEPTION 'request_conflict' USING ERRCODE='23505'; END IF;
 RETURN previous.receipt;
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION reputation.verify(mission uuid, requested_version integer, request text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s uuid:=identity.current_subject(); m reputation.missions; i reputation.items; result jsonb;
 fingerprint jsonb:=jsonb_build_object('kind','verify','mission',mission,'version',requested_version);
BEGIN
 PERFORM reputation.lock_subject(s);
 result:=reputation.replay(s,request,fingerprint); IF result IS NOT NULL THEN RETURN result; END IF;
 SELECT * INTO m FROM reputation.missions WHERE id=mission AND enabled;
 IF NOT FOUND THEN RAISE EXCEPTION 'mission_not_found' USING ERRCODE='P0002'; END IF;
 IF requested_version IS DISTINCT FROM m.version THEN RAISE EXCEPTION 'mission_version_conflict' USING ERRCODE='23505'; END IF;
 SELECT * INTO i FROM reputation.items WHERE subject_id=s AND mission_id=mission;
 IF NOT FOUND THEN
 INSERT INTO reputation.items(subject_id,title,description,category,units,status,reason,occurred_at,rule_hash,mission_id)
 VALUES(s,m.title,m.description,m.category,CASE WHEN m.verifier='acknowledgement' THEN m.units ELSE 0 END,
 CASE WHEN m.verifier='acknowledgement' THEN 'accepted' ELSE 'pending' END,
 CASE WHEN m.verifier='acknowledgement' THEN 'signed_acknowledgement' ELSE 'awaiting_trusted_evidence' END,clock_timestamp(),m.rule_hash,m.id) RETURNING * INTO i;
 IF m.verifier='acknowledgement' THEN
 INSERT INTO reputation.decisions(subject_id,item_id,source,source_id,units,status,reason,evidence)
 VALUES(s,i.id,'acknowledgement',i.id::text,i.units,i.status,i.reason,'[]');
 END IF;
 PERFORM reputation.emit(s,'item',i.id);
 END IF;
 result:=jsonb_build_object('version',1,'requestId',request,'state',CASE WHEN i.status='accepted' THEN 'completed' ELSE 'checking' END,
 'item',reputation.item_json(i),'summary',reputation.summary('today'));
 INSERT INTO reputation.commands(subject_id,request_id,fingerprint,receipt) VALUES(s,request,fingerprint,result);
 RETURN result;
END $$;
CREATE FUNCTION reputation.report(request text,title text,description text,occurred_at timestamptz,evidence_url text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s uuid:=identity.current_subject(); i reputation.items; result jsonb;
 fingerprint jsonb:=jsonb_build_object('kind','report','title',title,'description',description,'occurredAt',occurred_at,'evidenceUrl',evidence_url);
BEGIN
 PERFORM reputation.lock_subject(s);
 result:=reputation.replay(s,request,fingerprint); IF result IS NOT NULL THEN RETURN result; END IF;
 IF title IS NULL OR length(btrim(title)) NOT BETWEEN 1 AND 200 OR description IS NULL OR length(btrim(description)) NOT BETWEEN 1 AND 8000
 OR occurred_at IS NULL OR NOT isfinite(occurred_at) OR occurred_at>clock_timestamp()+interval '5 minutes'
 OR (evidence_url IS NOT NULL AND (length(evidence_url)>2048 OR evidence_url !~ '^https://[^[:space:]]+$'))
 THEN RAISE EXCEPTION 'invalid_report' USING ERRCODE='22023'; END IF;
 INSERT INTO reputation.items(subject_id,title,description,category,status,reason,occurred_at,evidence)
 VALUES(s,title,description,'work','pending','awaiting_interpretation',occurred_at,
 CASE WHEN evidence_url IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'url',evidence_url,'label','Submitted evidence')) END) RETURNING * INTO i;
 PERFORM reputation.emit(s,'item',i.id);
 result:=jsonb_build_object('version',1,'requestId',request,'state','checking','item',reputation.item_json(i),'summary',reputation.summary('today'));
 INSERT INTO reputation.commands(subject_id,request_id,fingerprint,receipt) VALUES(s,request,fingerprint,result);
 RETURN result;
END $$;
CREATE FUNCTION reputation.appeal(item uuid,request text,message text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s uuid:=identity.current_subject(); a reputation.appeals; result jsonb;
 fingerprint jsonb:=jsonb_build_object('kind','appeal','item',item,'message',message);
BEGIN
 PERFORM reputation.lock_subject(s);
 result:=reputation.replay(s,request,fingerprint); IF result IS NOT NULL THEN RETURN result; END IF;
 IF message IS NULL OR length(btrim(message)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'invalid_appeal' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT FROM reputation.items WHERE id=item AND subject_id=s) THEN RAISE EXCEPTION 'item_not_found' USING ERRCODE='P0002'; END IF;
 INSERT INTO reputation.appeals(subject_id,item_id,message) VALUES(s,item,message) RETURNING * INTO a;
 PERFORM reputation.emit(s,'appeal',item);
 result:=reputation.appeal_json(a);
 INSERT INTO reputation.commands(subject_id,request_id,fingerprint,receipt) VALUES(s,request,fingerprint,result);
 RETURN result;
END $$;
GRANT EXECUTE ON FUNCTION reputation.verify(uuid,integer,text),reputation.report(text,text,text,timestamptz,text),reputation.appeal(uuid,text,text) TO reputation_service;
RESET ROLE;
