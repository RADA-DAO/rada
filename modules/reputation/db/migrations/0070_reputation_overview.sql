SET LOCAL ROLE reputation_owner;
CREATE FUNCTION reputation.summary_at(p text, as_of timestamptz) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE s uuid:=identity.current_subject(); lo timestamptz; hi timestamptz;
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
CREATE FUNCTION reputation.read_items_at(p text, cursor jsonb, as_of timestamptz) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE lo timestamptz; hi timestamptz; rows jsonb; next_cursor text;
BEGIN
 SELECT start_at,end_at INTO lo,hi FROM reputation.bounds(p,as_of);
 WITH selected AS (SELECT i.* FROM reputation.items i WHERE subject_id=identity.current_subject()
 AND (lo IS NULL OR occurred_at>=lo) AND occurred_at<hi
 AND (cursor IS NULL OR (occurred_at,id)<((cursor->>'at')::timestamptz,(cursor->>'id')::uuid))
 ORDER BY occurred_at DESC,id DESC LIMIT 31), page AS (SELECT * FROM selected ORDER BY occurred_at DESC,id DESC LIMIT 30)
 SELECT coalesce(jsonb_agg(reputation.item_json(page::reputation.items) ORDER BY occurred_at DESC,id DESC),'[]'),
 CASE WHEN (SELECT count(*) FROM selected)>30 THEN (SELECT jsonb_build_object('at',occurred_at,'id',id)::text FROM page ORDER BY occurred_at,id LIMIT 1) END
 INTO rows,next_cursor FROM page;
 RETURN jsonb_build_object('items',rows,'nextCursor',next_cursor);
END $$;
CREATE FUNCTION reputation.overview(view_name text,p text,cursor text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE as_of timestamptz:=clock_timestamp(); page jsonb;
BEGIN
 IF view_name='tasks' THEN page:=reputation.read_missions(cursor::uuid);
 ELSIF view_name='history' THEN page:=reputation.read_items_at(p,cursor::jsonb,as_of);
 ELSE RAISE EXCEPTION 'invalid_view' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('summary',reputation.summary_at(p,as_of),'page',page);
END $$;
CREATE FUNCTION reputation.appeal_command(request text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT receipt FROM reputation.commands WHERE subject_id=identity.current_subject()
 AND request_id=request AND fingerprint->>'kind'='appeal'
$$;
GRANT EXECUTE ON FUNCTION reputation.overview(text,text,text),reputation.appeal_command(text) TO reputation_service;
RESET ROLE;
