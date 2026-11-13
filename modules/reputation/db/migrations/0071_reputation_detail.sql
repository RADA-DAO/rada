SET LOCAL ROLE reputation_owner;
CREATE FUNCTION reputation.detail(item uuid,p text DEFAULT 'today') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE as_of timestamptz:=clock_timestamp(); own_item jsonb;
BEGIN
 SELECT reputation.item_json(i) INTO own_item FROM reputation.items i
 WHERE i.subject_id=identity.current_subject() AND i.id=item;
 IF own_item IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('summary',reputation.summary_at(p,as_of),
 'item',own_item,'appeals',reputation.read_appeals(item));
END $$;
GRANT EXECUTE ON FUNCTION reputation.detail(uuid,text) TO reputation_service;
RESET ROLE;
