SET LOCAL ROLE apps_owner;
CREATE OR REPLACE FUNCTION apps.valid_manifest(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE requested_permission jsonb; board record;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' OR
     EXISTS (SELECT 1 FROM jsonb_object_keys(value) AS k(key)
             WHERE k.key NOT IN ('name','author','trustLevel','designRoute','permissions','minPlatformVersion','icon','boards')) OR
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

CREATE OR REPLACE FUNCTION apps.published() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'appId',r.app_id,'registryId',r.registry_id,'tier',r.tier,
    'versionId',v.version_id,'versionNo',v.version_no,'manifest',v.manifest - 'trustLevel',
    'sha256',encode(v.sha256,'hex'),'artifactUrl',v.artifact_url,
    'grantedPermissions',(SELECT coalesce(jsonb_agg(permission),'[]'::jsonb)
      FROM jsonb_array_elements_text(v.manifest->'permissions') AS grants(permission)
      WHERE permission IN ('identity.self.read','theme.read','navigation',
        'storage.self','scores','dao.public.read','telegram.username.read','wallet.address.read',
        'wallet.balances.read','jpegpe.collection.read','notifications.send','money.transfer'))
    ) ORDER BY r.app_id),'[]'::jsonb)
  FROM apps.registry r, apps.versions v
  WHERE r.live_version_id=v.version_id AND v.status='published'
    AND v.reviewed_at IS NOT NULL AND v.approved_by IS NOT NULL
$$;

CREATE TABLE apps.records (
 app_id text NOT NULL REFERENCES apps.registry(app_id),
 subject_id uuid NOT NULL,
 key text NOT NULL CHECK (key ~ '^[A-Za-z0-9_.:-]{1,64}$'),
 value jsonb NOT NULL CHECK (octet_length(value::text) <= 16384),
 version bigint NOT NULL CHECK (version > 0),
 PRIMARY KEY(app_id,subject_id,key)
);
CREATE SEQUENCE apps.record_versions MAXVALUE 9007199254740991;
ALTER TABLE apps.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE apps.records FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON apps.records TO apps_owner USING(true) WITH CHECK(true);
CREATE FUNCTION apps.capability(p_app text,p_hash text,p_permission text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE m jsonb;
BEGIN
 IF NOT identity.lock_app_consent(p_app,p_permission) THEN
  RAISE EXCEPTION 'Consent required' USING ERRCODE='42501'; END IF;
 SELECT v.manifest INTO m FROM apps.registry r JOIN apps.versions v ON (v.version_id=r.live_version_id)
 WHERE r.app_id=p_app AND encode(v.sha256,'hex')=p_hash AND v.status='published'
   AND v.approved_by IS NOT NULL AND v.reviewed_at IS NOT NULL AND (v.manifest->'permissions') ? p_permission;
 IF m IS NULL THEN RAISE EXCEPTION 'Capability denied' USING ERRCODE='42501'; END IF;
 RETURN m;
END $$;
CREATE FUNCTION apps.own_records(p_app text,p_hash text,p_action text,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s uuid := identity.current_subject(); k text := p_body->>'key'; old_version bigint; result jsonb;
BEGIN
 PERFORM apps.capability(p_app,p_hash,'storage.self');
 IF p_action='list' THEN
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('key',key,'value',value,'version',version) ORDER BY key),'[]')
    FROM apps.records WHERE app_id=p_app AND subject_id=s);
 END IF;
 IF k IS NULL OR k !~ '^[A-Za-z0-9_.:-]{1,64}$' THEN RAISE EXCEPTION 'Invalid key' USING ERRCODE='22023'; END IF;
 IF p_action='get' THEN
  RETURN (SELECT jsonb_build_object('key',key,'value',value,'version',version)
    FROM apps.records WHERE app_id=p_app AND subject_id=s AND key=k);
 END IF;
 IF p_action NOT IN ('put','delete') OR p_action IS NULL OR
    jsonb_typeof(p_body->'version') IS DISTINCT FROM 'number' OR
    (p_body->>'version')::numeric NOT BETWEEN 0 AND 9007199254740991 OR
    trunc((p_body->>'version')::numeric) <> (p_body->>'version')::numeric
 THEN RAISE EXCEPTION 'Invalid write' USING ERRCODE='22023'; END IF;
 SELECT version INTO old_version FROM apps.records WHERE app_id=p_app AND subject_id=s AND key=k;
 IF coalesce(old_version,0) <> (p_body->>'version')::bigint THEN
  RAISE EXCEPTION 'Version conflict' USING ERRCODE='40001'; END IF;
 IF p_action='delete' THEN
  DELETE FROM apps.records WHERE app_id=p_app AND subject_id=s AND key=k;
  RETURN jsonb_build_object('deleted',old_version IS NOT NULL);
 END IF;
 IF NOT p_body ? 'value' OR octet_length((p_body->'value')::text)>16384 THEN
  RAISE EXCEPTION 'Record too large' USING ERRCODE='54000'; END IF;
 IF old_version IS NULL AND (SELECT count(*) FROM apps.records WHERE app_id=p_app AND subject_id=s)>=100 THEN
  RAISE EXCEPTION 'Record limit' USING ERRCODE='54000'; END IF;
 INSERT INTO apps.records VALUES(p_app,s,k,p_body->'value',nextval('apps.record_versions'))
 ON CONFLICT(app_id,subject_id,key) DO UPDATE SET value=EXCLUDED.value,version=EXCLUDED.version
 RETURNING jsonb_build_object('key',key,'value',value,'version',version) INTO result;
 RETURN result;
END $$;
-- Only the identity-owned consent trigger can call this deletion interface.
CREATE FUNCTION apps.erase_personal_records(s uuid,p_app text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
 DELETE FROM apps.records WHERE subject_id=s AND app_id=p_app
$$;
REVOKE ALL ON FUNCTION apps.capability(text,text,text), apps.own_records(text,text,text,jsonb),
 apps.erase_personal_records(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apps.own_records(text,text,text,jsonb) TO apps_service;
GRANT USAGE ON SCHEMA apps TO identity_owner;
GRANT EXECUTE ON FUNCTION apps.erase_personal_records(uuid,text) TO identity_owner;
RESET ROLE;
