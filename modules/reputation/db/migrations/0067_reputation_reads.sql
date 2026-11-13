SET LOCAL ROLE reputation_owner;
CREATE FUNCTION reputation.bounds(p text, reference_time timestamptz DEFAULT statement_timestamp(), OUT start_at timestamptz, OUT end_at timestamptz)
LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE local_now timestamp:=reference_time AT TIME ZONE 'Europe/Kyiv';
BEGIN
 IF p NOT IN ('today','week','previous_week','all') OR p IS NULL THEN RAISE EXCEPTION 'invalid_period' USING ERRCODE='22023'; END IF;
 end_at:=reference_time;
 IF p='today' THEN start_at:=date_trunc('day',local_now) AT TIME ZONE 'Europe/Kyiv';
 ELSIF p='week' THEN start_at:=date_trunc('week',local_now) AT TIME ZONE 'Europe/Kyiv';
 ELSIF p='previous_week' THEN
 end_at:=date_trunc('week',local_now) AT TIME ZONE 'Europe/Kyiv';
 start_at:=(date_trunc('week',local_now)-interval '7 days') AT TIME ZONE 'Europe/Kyiv';
 END IF;
END $$;
CREATE FUNCTION reputation.item_json(i reputation.items) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',i.id,'title',i.title,'category',i.category,'points',reputation.points(i.units),
 'status',i.status,'reason',i.reason,'occurredAt',i.occurred_at,'recordedAt',i.recorded_at,
 'ruleHash',i.rule_hash,'evidence',i.evidence,'missionId',i.mission_id)
$$;
CREATE FUNCTION reputation.summary(p text DEFAULT 'all') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE s uuid:=identity.current_subject(); lo timestamptz; hi timestamptz; as_of timestamptz:=clock_timestamp();
 today date:=(as_of AT TIME ZONE 'Europe/Kyiv')::date; result jsonb;
BEGIN
 SELECT start_at,end_at INTO lo,hi FROM reputation.bounds(p,as_of);
 -- Historical buckets contain no item scans. Only the current calendar day
 -- needs exact instant filtering. Future evidence never inflates lifetime.
 WITH tail AS MATERIALIZED (
 SELECT category,
 coalesce(sum(units) FILTER(WHERE status='accepted' AND occurred_at<as_of),0) AS past_units,
 coalesce(sum(units) FILTER(WHERE status='accepted' AND occurred_at>=as_of),0) AS future_units,
 count(*) FILTER(WHERE status='pending' AND occurred_at<as_of) AS pending,
 count(*) FILTER(WHERE status='pending' AND occurred_at>=as_of) AS future_pending
 FROM reputation.items WHERE subject_id=s
 AND occurred_at>=today::timestamp AT TIME ZONE 'Europe/Kyiv'
 AND occurred_at<(today+1)::timestamp AT TIME ZONE 'Europe/Kyiv' GROUP BY category
 ), bucket AS MATERIALIZED (
 SELECT category,
 coalesce(sum(units) FILTER(WHERE day>today),0) AS future_units,
 coalesce(sum(pending) FILTER(WHERE day>today),0) AS future_pending,
 coalesce(sum(units) FILTER(WHERE day>=coalesce((lo AT TIME ZONE 'Europe/Kyiv')::date,day)
 AND day<(hi AT TIME ZONE 'Europe/Kyiv')::date),0) AS period_units,
 coalesce(sum(pending) FILTER(WHERE day>=coalesce((lo AT TIME ZONE 'Europe/Kyiv')::date,day)
 AND day<(hi AT TIME ZONE 'Europe/Kyiv')::date),0) AS pending
 FROM reputation.day_totals WHERE subject_id=s AND
 (day>today OR (p<>'all' AND day>=((lo AT TIME ZONE 'Europe/Kyiv')::date) AND day<(hi AT TIME ZONE 'Europe/Kyiv')::date)) GROUP BY category
 ), categories AS (
 SELECT c,coalesce(ct.units,0)-coalesce(b.future_units,0)-coalesce(t.future_units,0) AS lifetime,
 CASE WHEN p='all' THEN coalesce(ct.units,0)-coalesce(b.future_units,0)-coalesce(t.future_units,0)
 ELSE coalesce(b.period_units,0)+CASE WHEN p='previous_week' THEN 0 ELSE coalesce(t.past_units,0) END END AS units,
 CASE WHEN p='all' THEN coalesce(ct.pending,0)-coalesce(b.future_pending,0)-coalesce(t.future_pending,0)
 ELSE coalesce(b.pending,0)+CASE WHEN p='previous_week' THEN 0 ELSE coalesce(t.pending,0) END END AS pending
 FROM unnest(ARRAY['work','content','help','participation']) c
 LEFT JOIN reputation.category_totals ct ON (ct.subject_id=s AND ct.category=c)
 LEFT JOIN bucket b ON (b.category=c) LEFT JOIN tail t ON (t.category=c)
 )
 SELECT jsonb_build_object('version',1,'revision',coalesce((SELECT revision::text FROM reputation.subjects WHERE subject_id=s),'0'),
 'period',p,'start',lo,'end',hi,'totalPoints',reputation.points(coalesce(sum(units),0)),
 'lifetimePoints',reputation.points(coalesce(sum(lifetime),0)),'pendingCount',coalesce(sum(pending),0),
 'categories',jsonb_agg(jsonb_build_object('category',c,'points',reputation.points(units)) ORDER BY c),
 'updatedAt',coalesce((SELECT updated_at FROM reputation.subjects WHERE subject_id=s),as_of)) INTO result FROM categories;
 RETURN result;
END $$;
CREATE FUNCTION reputation.read_item(item uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT reputation.item_json(i) FROM reputation.items i WHERE subject_id=identity.current_subject() AND id=item
$$;
CREATE FUNCTION reputation.read_items(p text, cursor jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE lo timestamptz; hi timestamptz; rows jsonb; next_cursor text;
BEGIN
 SELECT start_at,end_at INTO lo,hi FROM reputation.bounds(p,clock_timestamp());
 WITH selected AS (SELECT i.* FROM reputation.items i WHERE subject_id=identity.current_subject()
 AND (lo IS NULL OR occurred_at>=lo) AND occurred_at<hi
 AND (cursor IS NULL OR (occurred_at,id)<((cursor->>'at')::timestamptz,(cursor->>'id')::uuid))
 ORDER BY occurred_at DESC,id DESC LIMIT 31), page AS (SELECT * FROM selected ORDER BY occurred_at DESC,id DESC LIMIT 30)
 SELECT coalesce(jsonb_agg(reputation.item_json(page::reputation.items) ORDER BY occurred_at DESC,id DESC),'[]'),
 CASE WHEN (SELECT count(*) FROM selected)>30 THEN (SELECT jsonb_build_object('at',occurred_at,'id',id)::text FROM page ORDER BY occurred_at,id LIMIT 1) END
 INTO rows,next_cursor FROM page;
 RETURN jsonb_build_object('items',rows,'nextCursor',next_cursor);
END $$;
CREATE FUNCTION reputation.read_missions(cursor uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH selected AS (SELECT m.*,i.status AS item_status FROM reputation.missions m LEFT JOIN reputation.items i ON (i.mission_id=m.id AND i.subject_id=identity.current_subject())
 WHERE m.enabled AND (cursor IS NULL OR m.id>cursor) ORDER BY m.id LIMIT 31), page AS (SELECT * FROM selected ORDER BY id LIMIT 30)
 SELECT jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version,'title',title,'description',description,
 'category',category,'points',reputation.points(units),'ruleHash',rule_hash,'verifier',verifier,
 'status',CASE WHEN item_status='accepted' THEN 'completed' WHEN item_status IS NOT NULL THEN 'checking' ELSE 'available' END,'actionUrl',action_url) ORDER BY id),'[]'),
 'nextCursor',CASE WHEN (SELECT count(*) FROM selected)>30 THEN (SELECT id::text FROM page ORDER BY id DESC LIMIT 1) END) FROM page
$$;
CREATE FUNCTION reputation.command(request text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT receipt FROM reputation.commands WHERE subject_id=identity.current_subject() AND request_id=request AND fingerprint->>'kind'<>'appeal'
$$;
CREATE FUNCTION reputation.changes(after_revision bigint) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE s uuid:=identity.current_subject(); current_revision bigint; result jsonb;
BEGIN
 IF after_revision IS NULL OR after_revision<0 THEN RAISE EXCEPTION 'invalid_revision' USING ERRCODE='22023'; END IF;
 SELECT coalesce((SELECT revision FROM reputation.subjects WHERE subject_id=s),0) INTO current_revision;
 WITH page AS (SELECT * FROM reputation.changes WHERE subject_id=s AND revision>after_revision ORDER BY revision LIMIT 100)
 SELECT jsonb_build_object('version',1,'changes',coalesce(jsonb_agg(jsonb_build_object('revision',revision::text,'type',type,'itemId',item_id,'recordedAt',recorded_at) ORDER BY revision),'[]'),
 'nextCursor',CASE WHEN after_revision>current_revision THEN current_revision::text ELSE coalesce(max(revision),after_revision)::text END,
 'hasMore',coalesce(max(revision),after_revision)<current_revision,'resetRequired',after_revision>current_revision) INTO result FROM page;
 RETURN result;
END $$;
CREATE FUNCTION reputation.appeal_json(a reputation.appeals) RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',a.id,'itemId',a.item_id,'message',a.message,'status',a.status,'resolution',a.resolution,'createdAt',a.created_at)
$$;
CREATE FUNCTION reputation.read_appeals(item uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(reputation.appeal_json(a) ORDER BY created_at,id),'[]') FROM reputation.appeals a WHERE subject_id=identity.current_subject() AND item_id=item
$$;
GRANT EXECUTE ON FUNCTION reputation.summary(text),reputation.read_item(uuid),reputation.read_items(text,jsonb),reputation.read_missions(uuid),reputation.command(text),reputation.changes(bigint),reputation.read_appeals(uuid) TO reputation_service;
RESET ROLE;
