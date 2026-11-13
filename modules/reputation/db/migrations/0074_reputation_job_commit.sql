SET LOCAL ROLE reputation_owner;
CREATE FUNCTION reputation.complete_report(item uuid,token uuid,hash text,key text,semantic text,source_id text) RETURNS jsonb
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
 IF j.lane<>'interpretation' OR i.mission_id IS NOT NULL OR i.status<>'pending' THEN RAISE EXCEPTION 'not_pending_report' USING ERRCODE='23505'; END IF;
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
CREATE FUNCTION reputation.complete_external(item uuid,token uuid,source text,source_id text,evidence_url text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j reputation.jobs; result jsonb; fingerprint jsonb:=jsonb_build_object('kind','external','source',source,'sourceId',source_id,'evidenceUrl',evidence_url);
BEGIN
 result:=reputation.job_receipt(item,token,fingerprint); IF result IS NOT NULL THEN RETURN result; END IF;
 j:=reputation.lock_job(item,token);
 result:=reputation.job_receipt(item,token,fingerprint); IF result IS NOT NULL THEN RETURN result; END IF;
 IF j.lane<>'external' THEN RAISE EXCEPTION 'not_external_job' USING ERRCODE='23505'; END IF;
 result:=jsonb_build_object('state','completed','item',reputation.finalize_external(item,source,source_id,evidence_url));
 UPDATE reputation.jobs SET state='completed',lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=clock_timestamp() WHERE item_id=item;
 INSERT INTO reputation.job_receipts(item_id,lease_token,fingerprint,receipt) VALUES(item,token,fingerprint,result);
 RETURN result;
END $$;
GRANT EXECUTE ON FUNCTION reputation.complete_report(uuid,uuid,text,text,text,text),reputation.complete_external(uuid,uuid,text,text,text) TO reputation_worker;
RESET ROLE;
