SET LOCAL ROLE apps_owner;
CREATE TABLE apps.problem_reports (
 report_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 app_id text NOT NULL,
 version_id uuid NOT NULL,
 reporter_id uuid NOT NULL,
 category text NOT NULL CHECK(category IN ('bug','content','privacy','other')),
 description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(app_id,version_id) REFERENCES apps.versions(app_id,version_id)
);
ALTER TABLE apps.problem_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE apps.problem_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON apps.problem_reports TO apps_owner USING(true) WITH CHECK(true);
CREATE FUNCTION apps.report_problem(p_app text,p_hash text,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v uuid;
BEGIN
 IF identity.current_subject() IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE='42501'; END IF;
 SELECT version_id INTO v FROM apps.versions WHERE app_id=p_app AND version_id::text=p_body->>'versionId' AND encode(sha256,'hex')=p_hash
  AND approved_by IS NOT NULL AND reviewed_at IS NOT NULL
  AND EXISTS(SELECT FROM apps.audit_events e WHERE e.version_id=apps.versions.version_id AND to_status='published')
  ORDER BY version_no DESC LIMIT 1;
 IF v IS NULL THEN RAISE EXCEPTION 'Unknown release' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_body->'category') IS DISTINCT FROM 'string' OR
    p_body->>'category' NOT IN ('bug','content','privacy','other') OR
    jsonb_typeof(p_body->'text') IS DISTINCT FROM 'string' OR length(btrim(p_body->>'text')) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Invalid report' USING ERRCODE='22023'; END IF;
 PERFORM apps.take_rate('reports',3,interval '1 hour');
 INSERT INTO apps.problem_reports(app_id,version_id,reporter_id,category,description)
 VALUES(p_app,v,identity.current_subject(),p_body->>'category',btrim(p_body->>'text'));
 RETURN jsonb_build_object('submitted',true);
END $$;
CREATE FUNCTION apps.report_queue() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NOT identity.can_review_apps() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
 RETURN (SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') FROM (
  SELECT report_id AS "reportId",app_id AS "appId",version_id AS "versionId",
    reporter_id AS "reporterId",category,description AS text,created_at AS "createdAt"
  FROM apps.problem_reports ORDER BY created_at DESC,report_id LIMIT 1000
 ) r);
END $$;
REVOKE ALL ON FUNCTION apps.report_problem(text,text,jsonb),apps.report_queue() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apps.report_problem(text,text,jsonb),apps.report_queue() TO apps_service;
RESET ROLE;
