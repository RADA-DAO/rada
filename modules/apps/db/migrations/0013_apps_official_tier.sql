SET LOCAL ROLE apps_owner;
-- Official status is a registry decision, never an author declaration. Every app
-- is community until the authorized steward records otherwise; the history keeps who and when.
ALTER TABLE apps.registry
  ADD COLUMN tier text NOT NULL DEFAULT 'community' CHECK (tier IN ('community','official'));
CREATE TABLE apps.tier_history (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps.registry(app_id),
  from_tier text NOT NULL CHECK (from_tier IN ('community','official')),
  to_tier text NOT NULL CHECK (to_tier IN ('community','official') AND to_tier <> from_tier),
  actor_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER guard_tier_history BEFORE UPDATE OR DELETE ON apps.tier_history
  FOR EACH ROW EXECUTE FUNCTION apps.guard_audit();
ALTER TABLE apps.tier_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE apps.tier_history FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON apps.tier_history TO apps_owner USING (true) WITH CHECK (true);

-- `trustLevel` stays accepted in stored manifests only so history written before this
-- migration still validates; new submissions may not request anything but community.
CREATE OR REPLACE FUNCTION apps.valid_manifest(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE requested_permission jsonb;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' OR
     EXISTS (SELECT 1 FROM jsonb_object_keys(value) AS k(key)
             WHERE k.key NOT IN ('name','author','trustLevel','designRoute','permissions','minPlatformVersion','icon')) OR
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
     jsonb_array_length(value->'permissions') > 18 OR
     (value ? 'icon' AND (
       jsonb_typeof(value->'icon') <> 'string' OR
       value->>'icon' !~ '^[a-z0-9][a-z0-9._-]{0,63}(/[a-z0-9][a-z0-9._-]{0,63}){0,2}\.(png|webp|svg)$'))
  THEN RETURN false; END IF;
  IF value->>'minPlatformVersion' > '1.0.0' THEN RETURN false; END IF;
  FOR requested_permission IN SELECT * FROM jsonb_array_elements(value->'permissions') LOOP
    IF jsonb_typeof(requested_permission) <> 'string' OR requested_permission #>> '{}' NOT IN (
      'identity.self.read','theme.read','navigation','storage.self','dao.public.read',
      'telegram.username.read','wallet.address.read','wallet.balances.read',
      'jpegpe.collection.read','notifications.send','money.exchange','money.transfer',
      'frog.transfer','wallet.sign','governance.vote','treasury.request','frog.issue','rewards.grant')
    THEN RETURN false; END IF;
  END LOOP;
  RETURN (SELECT count(*)=count(DISTINCT grants.permission)
    FROM jsonb_array_elements_text(value->'permissions') AS grants(permission));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION apps.submit_version(
  p_app_id text, p_manifest jsonb, p_sha256 bytea, p_artifact_url text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := identity.current_subject(); own apps.registry%ROWTYPE;
        next_no integer; result apps.versions%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE='42501'; END IF;
  IF p_app_id IS NULL OR p_app_id !~ '^[a-z][a-z0-9_.:-]{0,127}$'
    OR NOT apps.valid_manifest(p_manifest)
    OR coalesce(p_manifest->>'trustLevel','community') <> 'community'
    OR octet_length(p_sha256) <> 32 OR p_artifact_url !~ '^https://' OR length(p_artifact_url) > 2048
    OR p_artifact_url !~ ('/artifacts/' || encode(p_sha256,'hex') || '\.html$')
  THEN RAISE EXCEPTION 'Invalid version' USING ERRCODE='22023'; END IF;
  INSERT INTO apps.registry(app_id, author_id) VALUES (p_app_id, actor)
    ON CONFLICT (app_id) DO NOTHING;
  SELECT * INTO own FROM apps.registry WHERE app_id = p_app_id FOR UPDATE;
  IF own.author_id <> actor THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
  SELECT coalesce(max(version_no),0)+1 INTO next_no FROM apps.versions WHERE app_id=p_app_id;
  INSERT INTO apps.versions(app_id,version_no,manifest,sha256,artifact_url,status)
    VALUES(p_app_id,next_no,p_manifest,p_sha256,p_artifact_url,'draft') RETURNING * INTO result;
  INSERT INTO apps.audit_events(version_id,actor_id,from_status,to_status)
    VALUES(result.version_id,actor,NULL,'draft');
  UPDATE apps.versions SET status='pending' WHERE version_id=result.version_id;
  INSERT INTO apps.audit_events(version_id,actor_id,from_status,to_status)
    VALUES(result.version_id,actor,'draft','pending');
  RETURN pg_catalog.jsonb_build_object('appId',p_app_id,'versionId',result.version_id,
    'versionNo',next_no,'status','pending');
END $$;

CREATE FUNCTION apps.set_tier(p_app_id text, p_tier text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := identity.current_subject(); own apps.registry%ROWTYPE;
BEGIN
  IF NOT identity.can_steward_apps() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
  IF p_tier IS NULL OR p_tier NOT IN ('community','official') OR p_reason IS NULL
    OR length(btrim(p_reason)) < 1 OR length(p_reason) > 500
    THEN RAISE EXCEPTION 'Tier and reason required' USING ERRCODE='22023'; END IF;
  SELECT * INTO own FROM apps.registry WHERE app_id=p_app_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'App not found' USING ERRCODE='P0002'; END IF;
  IF own.tier = p_tier THEN RAISE EXCEPTION 'Invalid transition' USING ERRCODE='55000'; END IF;
  UPDATE apps.registry SET tier=p_tier WHERE app_id=p_app_id;
  INSERT INTO apps.tier_history(app_id,from_tier,to_tier,actor_id,reason)
    VALUES(p_app_id,own.tier,p_tier,actor,p_reason);
  RETURN jsonb_build_object('appId',p_app_id,'tier',p_tier);
END $$;

CREATE FUNCTION apps.tier_changes(p_app_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT identity.can_steward_apps() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'fromTier',h.from_tier,'toTier',h.to_tier,'actorId',h.actor_id,
    'reason',h.reason,'recordedAt',h.recorded_at) ORDER BY h.event_id),'[]'::jsonb)
    FROM apps.tier_history h WHERE h.app_id=p_app_id);
END $$;

-- The manifest the launcher and reviewers see carries no author-declared level;
-- the published row carries the registry's tier instead.
CREATE OR REPLACE FUNCTION apps.review_queue() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT identity.can_review_apps() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'appId',v.app_id,'versionId',v.version_id,'versionNo',v.version_no,
    'authorId',r.author_id,'manifest',v.manifest - 'trustLevel','sha256',encode(v.sha256,'hex'),
    'artifactUrl',v.artifact_url,'createdAt',v.created_at) ORDER BY v.created_at,v.version_id),'[]'::jsonb)
    FROM apps.versions v JOIN apps.registry r USING(app_id) WHERE v.status='pending');
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
        'storage.self','dao.public.read','telegram.username.read','wallet.address.read',
        'wallet.balances.read','jpegpe.collection.read','notifications.send','money.transfer'))
    ) ORDER BY r.app_id),'[]'::jsonb)
  FROM apps.registry r, apps.versions v
  WHERE r.live_version_id=v.version_id AND v.status='published'
    AND v.reviewed_at IS NOT NULL AND v.approved_by IS NOT NULL
$$;

REVOKE ALL ON FUNCTION apps.set_tier(text,text,text), apps.tier_changes(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apps.set_tier(text,text,text), apps.tier_changes(text) TO apps_service;
RESET ROLE;
