BEGIN;
CREATE FUNCTION pg_temp.assert_true(value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed'; END IF; END $$;
SELECT identity.resolve_telegram(989801) AS first_subject \gset
SELECT identity.resolve_telegram(989802) AS second_subject \gset
SELECT set_config('rada.subject_id', :'first_subject', true);
SET LOCAL ROLE apps_service;
SELECT pg_temp.assert_true(apps.launcher_layout()->>'version'='0');
SELECT pg_temp.assert_true(apps.launcher_layout(0,'{"order":["builtin:splash"],"pinned":[],"favourites":[],"folders":[]}')->>'version'='1');
DO $$ BEGIN
 PERFORM apps.launcher_layout(0,'{"order":[],"pinned":[],"favourites":[],"folders":[]}');
 RAISE EXCEPTION 'Stale save accepted';
EXCEPTION WHEN serialization_failure THEN NULL; END $$;
SELECT pg_temp.assert_true(apps.launcher_activity('builtin:splash')->'recent'='["builtin:splash"]');
SELECT pg_temp.assert_true(apps.launcher_activity()->'popular'='[]');
SELECT set_config('rada.subject_id', :'second_subject', true);
SELECT pg_temp.assert_true(apps.launcher_layout()->>'version'='0');
SELECT pg_temp.assert_true(apps.launcher_activity()->'recent'='[]');
DO $$ BEGIN
 PERFORM * FROM apps.launcher_layouts; RAISE EXCEPTION 'Private layout exposed';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
 PERFORM * FROM apps.launcher_activity; RAISE EXCEPTION 'Private activity exposed';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
INSERT INTO apps.launcher_activity(subject_id,app_id)
 SELECT identity.resolve_telegram(n),'builtin:splash' FROM generate_series(989802,989804) n;
SET LOCAL ROLE apps_service;
SELECT pg_temp.assert_true(apps.launcher_activity()->'popular'='[]');
RESET ROLE;
INSERT INTO apps.launcher_activity(subject_id,app_id) VALUES(identity.resolve_telegram(989805),'builtin:splash');
SET LOCAL ROLE apps_service;
SELECT pg_temp.assert_true(apps.launcher_activity()->'popular'='[{"appId":"builtin:splash","count":5}]');
RESET ROLE;
UPDATE apps.launcher_activity SET opened_at=now()-interval '31 days' WHERE subject_id=identity.resolve_telegram(989805);
SET LOCAL ROLE apps_service;
SELECT pg_temp.assert_true(apps.launcher_activity()->'popular'='[]');
RESET ROLE;
SELECT pg_temp.assert_true(apps.valid_manifest('{"name":"Game","author":"Author","designRoute":"standard","permissions":[],"minPlatformVersion":"1.0.0","category":"games"}'));
SELECT pg_temp.assert_true(NOT apps.valid_manifest('{"name":"Game","author":"Author","designRoute":"standard","permissions":[],"minPlatformVersion":"1.0.0","category":"rada"}'));
ROLLBACK;
