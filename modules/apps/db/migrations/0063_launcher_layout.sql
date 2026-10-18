SET LOCAL ROLE apps_owner;
CREATE OR REPLACE FUNCTION apps.valid_manifest(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE requested_permission jsonb; board record;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' OR
     EXISTS (SELECT 1 FROM jsonb_object_keys(value) AS k(key)
             WHERE k.key NOT IN ('name','author','trustLevel','designRoute','permissions','minPlatformVersion','icon','boards','category')) OR
     (value ? 'category' AND (jsonb_typeof(value->'category') <> 'string' OR value->>'category' NOT IN ('games','apps'))) OR
     NOT value ?& ARRAY['name','author','designRoute','permissions','minPlatformVersion'] OR
     (value ? 'trustLevel' AND (jsonb_typeof(value->'trustLevel') <> 'string' OR value->>'trustLevel' NOT IN ('community','official'))) OR
     jsonb_typeof(value->'name') <> 'string' OR
     jsonb_typeof(value->'author') <> 'string' OR
     jsonb_typeof(value->'designRoute') <> 'string' OR
     jsonb_typeof(value->'minPlatformVersion') <> 'string' OR
     jsonb_typeof(value->'permissions') <> 'array' OR
     length(value->>'name') NOT BETWEEN 1 AND 64 OR
     length(value->>'author') NOT BETWEEN 1 AND 64 OR
     btrim(value->>'name') <> value->>'name' OR
     btrim(value->>'author') <> value->>'author' OR
     value->>'name' ~ '[[:cntrl:]<>]' OR value->>'author' ~ '[[:cntrl:]<>]' OR
     value->>'designRoute' NOT IN ('standard','free-style') OR
     value->>'minPlatformVersion' !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' OR
     (string_to_array(value->>'minPlatformVersion','.'))[1]::integer > 1 OR
     jsonb_array_length(value->'permissions') > 19 OR
     (value ? 'icon' AND (
       jsonb_typeof(value->'icon') <> 'string' OR
       value->>'icon' !~ '^[a-z0-9][a-z0-9._-]{0,63}(/[a-z0-9][a-z0-9._-]{0,63}){0,2}\.(png|webp|svg)$'))
  THEN RETURN false; END IF;
  IF value->>'minPlatformVersion' > '1.0.0' THEN RETURN false; END IF;
  FOR requested_permission IN SELECT * FROM jsonb_array_elements(value->'permissions') LOOP
    IF jsonb_typeof(requested_permission) <> 'string' OR requested_permission #>> '{}' NOT IN (
      'identity.self.read','theme.read','navigation','storage.self','scores','dao.public.read',
      'telegram.username.read','wallet.address.read','wallet.balances.read',
      'jpegpe.collection.read','notifications.send','money.exchange','money.transfer',
      'frog.transfer','wallet.sign','governance.vote','treasury.request','frog.issue','rewards.grant')
    THEN RETURN false; END IF;
  END LOOP;
  IF value->'permissions' ? 'scores' THEN
    IF jsonb_typeof(value->'boards') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(value->'boards')) NOT BETWEEN 1 AND 10 THEN RETURN false; END IF;
    FOR board IN SELECT * FROM jsonb_each(value->'boards') LOOP
      IF board.key !~ '^[a-z][a-z0-9_-]{0,31}$' OR jsonb_typeof(board.value) <> 'object' THEN RETURN false; END IF;
      IF NOT board.value ?& ARRAY['min','max'] OR (SELECT count(*) FROM jsonb_object_keys(board.value)) <> 2
        OR jsonb_typeof(board.value->'min') <> 'number' OR jsonb_typeof(board.value->'max') <> 'number'
        OR (board.value->>'min')::numeric <> trunc((board.value->>'min')::numeric)
        OR (board.value->>'max')::numeric <> trunc((board.value->>'max')::numeric)
        OR (board.value->>'min')::numeric < -1000000000 OR (board.value->>'max')::numeric > 1000000000
        OR (board.value->>'min')::numeric > (board.value->>'max')::numeric THEN RETURN false; END IF;
    END LOOP;
  ELSIF value ? 'boards' THEN RETURN false;
  END IF;
  RETURN (SELECT count(*)=count(DISTINCT grants.permission)
    FROM jsonb_array_elements_text(value->'permissions') AS grants(permission));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;

CREATE TABLE apps.launcher_layouts (
 subject_id uuid PRIMARY KEY,
 version integer NOT NULL DEFAULT 0,
 layout jsonb NOT NULL DEFAULT '{"order":[],"pinned":[],"favourites":[],"folders":[]}'
);
ALTER TABLE apps.launcher_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE apps.launcher_layouts FORCE ROW LEVEL SECURITY;
CREATE POLICY own_layout ON apps.launcher_layouts TO apps_owner
 USING (subject_id = identity.current_subject())
 WITH CHECK (subject_id = identity.current_subject());

CREATE FUNCTION apps.launcher_layout(p_version integer DEFAULT NULL, p_layout jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE who uuid := identity.current_subject(); result jsonb;
BEGIN
 IF who IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE='42501'; END IF;
 INSERT INTO apps.launcher_layouts(subject_id) VALUES(who) ON CONFLICT DO NOTHING;
 IF p_layout IS NOT NULL THEN
  IF p_version IS NULL OR p_version < 0 OR octet_length(p_layout::text)>32768
   OR jsonb_typeof(p_layout) <> 'object'
   OR NOT p_layout ?& ARRAY['order','pinned','favourites','folders']
   OR (SELECT count(*) FROM jsonb_object_keys(p_layout)) <> 4
   OR jsonb_typeof(p_layout->'order') <> 'array'
   OR jsonb_typeof(p_layout->'pinned') <> 'array'
   OR jsonb_typeof(p_layout->'favourites') <> 'array'
   OR jsonb_typeof(p_layout->'folders') <> 'array'
  THEN RAISE EXCEPTION 'Invalid layout' USING ERRCODE='22023'; END IF;
  UPDATE apps.launcher_layouts SET layout=p_layout, version=version+1
   WHERE subject_id=who AND version=p_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Layout conflict' USING ERRCODE='40001'; END IF;
 END IF;
 SELECT jsonb_build_object('version',version,'layout',layout) INTO result
 FROM apps.launcher_layouts WHERE subject_id=who;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION apps.launcher_layout(integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apps.launcher_layout(integer,jsonb) TO apps_service;
RESET ROLE;
