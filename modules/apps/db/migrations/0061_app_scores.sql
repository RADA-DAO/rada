GRANT USAGE ON SCHEMA jpegpe TO apps_owner;
GRANT EXECUTE ON FUNCTION jpegpe.public_profile_frog(uuid) TO apps_owner;
SET LOCAL ROLE apps_owner;
CREATE TABLE apps.scores (
 app_id text NOT NULL REFERENCES apps.registry(app_id),
 subject_id uuid NOT NULL,
 board text NOT NULL,
 score bigint NOT NULL CHECK(score BETWEEN -1000000000 AND 1000000000),
 PRIMARY KEY(app_id,board,subject_id)
);
CREATE INDEX scores_order ON apps.scores(app_id,board,score DESC);
CREATE TABLE apps.capability_rates (
 subject_id uuid NOT NULL, scope text NOT NULL, started_at timestamptz NOT NULL,
 count integer NOT NULL, PRIMARY KEY(subject_id,scope)
);
ALTER TABLE apps.scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE apps.scores FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON apps.scores TO apps_owner USING(true) WITH CHECK(true);
ALTER TABLE apps.capability_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE apps.capability_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON apps.capability_rates TO apps_owner USING(true) WITH CHECK(true);
CREATE FUNCTION apps.take_rate(p_scope text,p_limit integer,p_window interval) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE n integer;
BEGIN
 INSERT INTO apps.capability_rates VALUES(identity.current_subject(),p_scope,clock_timestamp(),1)
 ON CONFLICT(subject_id,scope) DO UPDATE SET
   count=CASE WHEN apps.capability_rates.started_at <= clock_timestamp()-p_window THEN 1 ELSE apps.capability_rates.count+1 END,
   started_at=CASE WHEN apps.capability_rates.started_at <= clock_timestamp()-p_window THEN clock_timestamp() ELSE apps.capability_rates.started_at END
 RETURNING count INTO n;
 IF n>p_limit THEN RAISE EXCEPTION 'Rate limited' USING ERRCODE='P0429'; END IF;
END $$;
CREATE FUNCTION apps.app_scores(p_app text,p_hash text,p_action text,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m jsonb; bounds jsonb; b text := p_body->>'board'; amount numeric; n integer := 10;
 result jsonb; mine jsonb; total bigint;
BEGIN
 m := apps.capability(p_app,p_hash,'scores');
 bounds := m->'boards'->b;
 IF bounds IS NULL OR b IS NULL OR p_action IS NULL OR p_action NOT IN ('submit','list','rank') THEN
  RAISE EXCEPTION 'Unknown board or operation' USING ERRCODE='22023'; END IF;
 IF p_body ? 'limit' THEN
  IF jsonb_typeof(p_body->'limit') <> 'number' OR (p_body->>'limit')::numeric NOT BETWEEN 1 AND 100
    OR trunc((p_body->>'limit')::numeric) <> (p_body->>'limit')::numeric THEN
   RAISE EXCEPTION 'Invalid limit' USING ERRCODE='22023'; END IF;
  n := (p_body->>'limit')::integer;
 END IF;
 IF p_action='submit' THEN
  IF jsonb_typeof(p_body->'score') IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION 'Invalid score' USING ERRCODE='22023'; END IF;
  amount := (p_body->>'score')::numeric;
  IF amount <> trunc(amount) OR amount < (bounds->>'min')::numeric OR amount > (bounds->>'max')::numeric THEN
   RAISE EXCEPTION 'Score out of bounds' USING ERRCODE='22023'; END IF;
  PERFORM apps.take_rate('scores:' || p_app,10,interval '1 minute');
  INSERT INTO apps.scores VALUES(p_app,identity.current_subject(),b,amount::bigint)
   ON CONFLICT(app_id,board,subject_id) DO UPDATE SET score=greatest(apps.scores.score,EXCLUDED.score);
 END IF;
 -- Bounds from the current reviewed release also apply to earlier submissions.
 WITH ranked AS (
  SELECT subject_id,score,rank() OVER(ORDER BY score DESC) AS rank
  FROM apps.scores WHERE app_id=p_app AND board=b
    AND score BETWEEN (bounds->>'min')::bigint AND (bounds->>'max')::bigint
 ), top_rows AS (
  SELECT * FROM ranked ORDER BY score DESC,subject_id LIMIT n
 ) SELECT
  (SELECT count(*) FROM ranked),
  (SELECT jsonb_build_object('rank',rank,'score',score) FROM ranked WHERE subject_id=identity.current_subject()),
  (SELECT coalesce(jsonb_agg(jsonb_build_object('rank',r.rank,'score',r.score,'name',f.username)
    ORDER BY r.score DESC,r.subject_id),'[]') FROM top_rows r
    LEFT JOIN LATERAL jpegpe.public_profile_frog(r.subject_id) f ON true)
 INTO total,mine,result;
 RETURN jsonb_build_object('board',b,'total',total,'rows',CASE WHEN p_action='rank' THEN '[]'::jsonb ELSE result END,'myRank',mine);
END $$;
REVOKE ALL ON FUNCTION apps.app_scores(text,text,text,jsonb),apps.take_rate(text,integer,interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apps.app_scores(text,text,text,jsonb) TO apps_service;
RESET ROLE;
