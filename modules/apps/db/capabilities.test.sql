BEGIN;
CREATE FUNCTION pg_temp.assert_true(v boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'Capability assertion failed'; END IF; END $$;
CREATE FUNCTION pg_temp.fails(q text, expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE q; EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE=expected THEN RETURN; END IF; RAISE;
 END;
 RAISE EXCEPTION 'Expected failure % for %',expected,q;
END $$;
SELECT identity.resolve_telegram(905901) AS person \gset
SELECT identity.resolve_telegram(905902) AS other \gset
SELECT set_config('rada.subject_id',:'person',true);
INSERT INTO identity.role_grants VALUES(:'person','apps.reviewer',now());
SELECT (apps.submit_version('fixture.capabilities',
 '{"name":"Game","author":"Fixture","designRoute":"standard","permissions":["storage.self","scores"],"boards":{"points":{"min":0,"max":100}},"minPlatformVersion":"1.0.0"}',
 decode(repeat('a',64),'hex'),'https://artifacts.example/artifacts/'||repeat('a',64)||'.html')->>'versionId') AS version \gset
SELECT apps.review_version('fixture.capabilities',:'version',true,'fixture');
SELECT apps.publish_version('fixture.capabilities',:'version');
SELECT pg_temp.assert_true(apps.published()->0->'grantedPermissions' ? 'scores');
SET LOCAL ROLE apps_service;
SELECT pg_temp.fails($q$SELECT apps.own_records('fixture.capabilities',repeat('a',64),'list','{}')$q$,'42501');
SELECT pg_temp.fails($q$SELECT apps.app_scores('fixture.capabilities',repeat('a',64),'list','{"board":"points"}')$q$,'42501');
SELECT pg_temp.fails($q$SELECT apps.erase_personal_records(identity.current_subject(),'fixture.capabilities')$q$,'42501');
SELECT pg_temp.fails($q$SELECT * FROM apps.records$q$,'42501');
SELECT pg_temp.fails($q$SELECT * FROM apps.scores$q$,'42501');
SELECT pg_temp.fails($q$SELECT * FROM apps.problem_reports$q$,'42501');
RESET ROLE;
INSERT INTO identity.consents(subject_id,app_id,capability) VALUES
 (:'person','fixture.capabilities','storage.self'),(:'person','fixture.capabilities','scores'),
 (:'other','fixture.capabilities','storage.self'),(:'other','fixture.capabilities','scores');
SET LOCAL ROLE apps_service;
SELECT (apps.own_records('fixture.capabilities',repeat('a',64),'put','{"key":"save","value":{"level":2},"version":0}')->>'version') AS record_version \gset
SELECT pg_temp.fails($q$SELECT apps.own_records('fixture.capabilities',repeat('a',64),'put','{"key":"save","value":null,"version":0}')$q$,'40001');
SELECT pg_temp.fails($q$SELECT apps.own_records('fixture.capabilities',repeat('a',64),'delete','{"key":"save","version":0}')$q$,'40001');
SELECT pg_temp.assert_true(apps.own_records('fixture.capabilities',repeat('a',64),'get','{"key":"save"}')->'value'='{"level":2}');
SELECT pg_temp.fails($q$SELECT apps.own_records('fixture.capabilities',repeat('b',64),'list','{}')$q$,'42501');
SELECT pg_temp.fails($q$SELECT apps.own_records('fixture.other',repeat('a',64),'list','{}')$q$,'42501');
SELECT pg_temp.fails($q$SELECT apps.own_records('fixture.capabilities',repeat('a',64),'put',jsonb_build_object('key','large','version',0,'value',repeat('x',16385)))$q$,'54000');
SELECT apps.own_records('fixture.capabilities',repeat('a',64),'put',jsonb_build_object('key','key'||n,'version',0,'value',n)) FROM generate_series(1,99) n;
SELECT pg_temp.fails($q$SELECT apps.own_records('fixture.capabilities',repeat('a',64),'put','{"key":"overflow","value":1,"version":0}')$q$,'54000');
SELECT pg_temp.assert_true(jsonb_array_length(apps.own_records('fixture.capabilities',repeat('a',64),'list','{}'))=100);
SELECT pg_temp.assert_true(apps.own_records('fixture.capabilities',repeat('a',64),'delete',jsonb_build_object('key','save','version',:'record_version'::bigint))->>'deleted'='true');
SELECT (apps.own_records('fixture.capabilities',repeat('a',64),'put','{"key":"save","value":null,"version":0}')->>'version')::bigint > :'record_version'::bigint AS no_aba \gset
SELECT pg_temp.assert_true(:'no_aba');
SELECT set_config('rada.subject_id',:'other',true);
SELECT pg_temp.assert_true(apps.own_records('fixture.capabilities',repeat('a',64),'get','{"key":"save"}') IS NULL);
SELECT pg_temp.assert_true(apps.own_records('fixture.capabilities',repeat('a',64),'list','{}')='[]');
SELECT apps.app_scores('fixture.capabilities',repeat('a',64),'submit','{"board":"points","score":90}');
SELECT pg_temp.fails($q$SELECT apps.report_queue()$q$,'42501');
SELECT set_config('rada.subject_id',:'person',true);
SELECT pg_temp.fails($q$SELECT apps.app_scores('fixture.capabilities',repeat('a',64),'submit','{"board":"points","score":101}')$q$,'22023');
SELECT pg_temp.fails($q$SELECT apps.app_scores('fixture.capabilities',repeat('a',64),'submit','{"board":"points","score":1.5}')$q$,'22023');
SELECT pg_temp.fails($q$SELECT apps.app_scores('fixture.capabilities',repeat('a',64),'submit','{"board":"unknown","score":1}')$q$,'22023');
SELECT apps.app_scores('fixture.capabilities',repeat('a',64),'submit','{"board":"points","score":80}');
SELECT pg_temp.assert_true(apps.app_scores('fixture.capabilities',repeat('a',64),'list','{"board":"points","limit":1}')->'rows'='[{"rank":1,"score":90,"name":null}]');
SELECT pg_temp.assert_true(apps.app_scores('fixture.capabilities',repeat('a',64),'rank','{"board":"points"}')->'myRank'='{"rank":2,"score":80}');
SELECT apps.app_scores('fixture.capabilities',repeat('a',64),'submit','{"board":"points","score":10}') FROM generate_series(1,9);
SELECT pg_temp.fails($q$SELECT apps.app_scores('fixture.capabilities',repeat('a',64),'submit','{"board":"points","score":80}')$q$,'P0429');
RESET ROLE;
SELECT gen_random_uuid() AS frog \gset
SELECT jpegpe.create_frog(:'frog','CapabilityFixture',:'other');
SELECT set_config('rada.subject_id',:'other',true);
SELECT identity.select_frog(:'frog');
SELECT set_config('rada.subject_id',:'person',true);
SET LOCAL ROLE apps_service;
SELECT pg_temp.assert_true(apps.app_scores('fixture.capabilities',repeat('a',64),'list','{"board":"points"}')->'rows'->0->>'name'='CapabilityFixture');
SELECT pg_temp.assert_true(NOT (apps.app_scores('fixture.capabilities',repeat('a',64),'list','{"board":"points"}')->'rows'->0 ? 'subject_id'));
SELECT pg_temp.fails(format($q$SELECT apps.report_problem('fixture.capabilities',repeat('a',64),'%s')$q$,jsonb_build_object('versionId',:'version','category','unknown','text','Problem')),'22023');
SELECT pg_temp.fails(format($q$SELECT apps.report_problem('fixture.capabilities',repeat('a',64),'%s')$q$,jsonb_build_object('versionId',:'version','category','bug','text',repeat('x',1001))),'22023');
SELECT apps.report_problem('fixture.capabilities',repeat('a',64),jsonb_build_object('versionId',:'version','category','bug','text','Fixture problem')) FROM generate_series(1,3);
SELECT pg_temp.fails(format($q$SELECT apps.report_problem('fixture.capabilities',repeat('a',64),'%s')$q$,jsonb_build_object('versionId',:'version','category','bug','text','Fourth')),'P0429');
SELECT pg_temp.assert_true(jsonb_array_length(apps.report_queue())=3);
SELECT pg_temp.assert_true(apps.report_queue()->0->>'reporterId'=:'person');
SELECT pg_temp.assert_true(apps.report_queue()->0->>'versionId'=:'version');
RESET ROLE;
SET LOCAL ROLE identity_service;
UPDATE identity.consents SET revoked_at=now() WHERE app_id='fixture.capabilities' AND capability='storage.self';
RESET ROLE;
SELECT pg_temp.assert_true(NOT EXISTS(SELECT FROM apps.records WHERE subject_id=:'person'));
SET LOCAL ROLE apps_service;
SELECT pg_temp.fails($q$SELECT apps.own_records('fixture.capabilities',repeat('a',64),'list','{}')$q$,'42501');
RESET ROLE;
UPDATE identity.consents SET revoked_at=NULL WHERE subject_id=:'person' AND capability='storage.self';
SELECT pg_temp.assert_true(apps.own_records('fixture.capabilities',repeat('a',64),'list','{}')='[]');
SELECT set_config('rada.subject_id',:'other',true);
SELECT identity.select_frog(NULL);
SELECT set_config('rada.subject_id',:'person',true);
SELECT pg_temp.assert_true(apps.app_scores('fixture.capabilities',repeat('a',64),'list','{"board":"points"}')->'rows'->0->'name'='null');
UPDATE identity.consents SET revoked_at=now() WHERE subject_id=:'person' AND capability='scores';
SELECT pg_temp.fails($q$SELECT apps.app_scores('fixture.capabilities',repeat('a',64),'list','{"board":"points"}')$q$,'42501');
UPDATE identity.consents SET revoked_at=NULL WHERE subject_id=:'person' AND capability='scores';
SELECT apps.withdraw_app('fixture.capabilities','fixture withdrawal');
SELECT pg_temp.fails($q$SELECT apps.app_scores('fixture.capabilities',repeat('a',64),'list','{"board":"points"}')$q$,'42501');
ROLLBACK;
