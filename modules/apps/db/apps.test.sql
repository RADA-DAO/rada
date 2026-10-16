BEGIN;
CREATE FUNCTION pg_temp.assert_true(value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed'; END IF;
END $$;
SELECT pg_temp.assert_true(current_setting('server_version_num')::integer / 10000 = 17);
SELECT pg_temp.assert_true((SELECT count(*) = 1 FROM platform_migrations.applied WHERE name = '0002_apps.sql'));
SET LOCAL ROLE apps_service;
SELECT pg_temp.assert_true(jsonb_typeof(apps.published()) = 'array');
DO $$ BEGIN
  PERFORM * FROM apps.registry;
  RAISE EXCEPTION 'Registry login read base table';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM apps.review_queue();
  RAISE EXCEPTION 'Unassigned reviewer read queue';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM * FROM identity.role_grants;
  RAISE EXCEPTION 'Registry login read private roles';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
SELECT pg_temp.assert_true(apps.valid_manifest(
  '{"name":"A","author":"B","trustLevel":"community","designRoute":"standard","permissions":[],"minPlatformVersion":"1.0.0"}'::jsonb));
SELECT pg_temp.assert_true(apps.valid_manifest(
  '{"name":"A","author":"B","trustLevel":"community","designRoute":"standard","permissions":[],"minPlatformVersion":"1.0.0","icon":"img/icon.webp"}'::jsonb));
SELECT pg_temp.assert_true(NOT apps.valid_manifest(format(
  '{"name":"A","author":"B","trustLevel":"community","designRoute":"standard","permissions":[],"minPlatformVersion":"1.0.0","icon":%s}', icon)::jsonb))
  FROM unnest(ARRAY['"/icon.png"','"../icon.png"','"https://x.example/i.png"','"icon.gif"','"icon.PNG"','"a/b/c/d.png"','7','null']) AS icons(icon);
SELECT identity.resolve_telegram(909001) AS fixture_subject \gset
INSERT INTO apps.registry(app_id,author_id) VALUES('fixture.invalid',:'fixture_subject');
DO $$ BEGIN
  INSERT INTO apps.versions(app_id,version_no,manifest,sha256,artifact_url,status)
    VALUES('fixture.invalid',1,'{}'::jsonb,decode(repeat('a',64),'hex'),
      'https://artifacts.example/artifacts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.html','draft');
  RAISE EXCEPTION 'Malformed manifest reached version storage';
EXCEPTION WHEN check_violation THEN NULL; END $$;
ROLLBACK;
