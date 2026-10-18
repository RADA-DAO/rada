SET LOCAL ROLE apps_owner;
-- One row per person/app/day bounds repeat opens and the aggregate contribution.
CREATE TABLE apps.launcher_activity (
 subject_id uuid NOT NULL,
 app_id text NOT NULL,
 day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
 opened_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(subject_id,app_id,day)
);
ALTER TABLE apps.launcher_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE apps.launcher_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_activity ON apps.launcher_activity TO apps_owner USING(true) WITH CHECK(true);
CREATE FUNCTION apps.launcher_activity(p_app text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE who uuid := identity.current_subject(); recent jsonb; popular jsonb;
BEGIN
 IF who IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE='42501'; END IF;
 IF p_app IS NOT NULL THEN
  IF p_app NOT IN ('builtin:splash','builtin:governance','builtin:treasury','builtin:holders')
   AND NOT EXISTS (SELECT 1 FROM apps.registry r JOIN apps.versions v ON (v.version_id=r.live_version_id)
    WHERE r.app_id=p_app AND v.status='published' AND v.approved_by IS NOT NULL)
  THEN RAISE EXCEPTION 'Unknown app' USING ERRCODE='22023'; END IF;
  INSERT INTO apps.launcher_activity(subject_id,app_id) VALUES(who,p_app)
   ON CONFLICT(subject_id,app_id,day) DO UPDATE SET opened_at=now();
 END IF;
 DELETE FROM apps.launcher_activity WHERE opened_at < now()-interval '30 days';
 SELECT coalesce(jsonb_agg(app_id ORDER BY last_open DESC),'[]') INTO recent FROM
  (SELECT app_id,max(opened_at) last_open FROM apps.launcher_activity
   WHERE subject_id=who GROUP BY app_id ORDER BY last_open DESC LIMIT 8) q;
 SELECT coalesce(jsonb_agg(jsonb_build_object('appId',app_id,'count',people) ORDER BY people DESC,app_id),'[]') INTO popular FROM
  (SELECT app_id,count(DISTINCT subject_id) people FROM apps.launcher_activity
   WHERE opened_at >= now()-interval '30 days' GROUP BY app_id
   HAVING count(DISTINCT subject_id)>=5 ORDER BY people DESC,app_id LIMIT 8) q;
 RETURN jsonb_build_object('recent',recent,'popular',popular);
END $$;
REVOKE ALL ON FUNCTION apps.launcher_activity(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apps.launcher_activity(text) TO apps_service;
RESET ROLE;
