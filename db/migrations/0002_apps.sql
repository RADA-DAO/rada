CREATE ROLE apps_owner NOLOGIN;
CREATE ROLE apps_service NOLOGIN;
CREATE SCHEMA apps AUTHORIZATION apps_owner;

SET LOCAL ROLE identity_owner;
CREATE FUNCTION identity.can_review_apps() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM identity.role_grants
    WHERE subject_id = identity.current_subject() AND role_name = 'apps.reviewer'
  )
$$;
REVOKE ALL ON FUNCTION identity.can_review_apps() FROM PUBLIC;
GRANT USAGE ON SCHEMA identity TO apps_owner;
GRANT REFERENCES ON identity.subjects TO apps_owner;
GRANT EXECUTE ON FUNCTION identity.current_subject(), identity.can_review_apps() TO apps_owner;
RESET ROLE;

SET LOCAL ROLE apps_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE apps.registry (
  registry_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  app_id text PRIMARY KEY CHECK (app_id ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
  author_id uuid NOT NULL REFERENCES identity.subjects(subject_id),
  live_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE apps.versions (
  version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL REFERENCES apps.registry(app_id),
  version_no integer NOT NULL CHECK (version_no > 0),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  artifact_url text NOT NULL CHECK (length(artifact_url) <= 2048 AND artifact_url ~ '^https://'),
  status text NOT NULL CHECK (status IN ('draft','pending','approved','rejected','published','withdrawn')),
  approved_by uuid REFERENCES identity.subjects(subject_id),
  review_reason text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, version_no),
  UNIQUE (app_id, version_id),
  CHECK ((approved_by IS NULL AND review_reason IS NULL AND reviewed_at IS NULL)
      OR (approved_by IS NOT NULL AND review_reason IS NOT NULL AND reviewed_at IS NOT NULL))
);
ALTER TABLE apps.registry ADD CONSTRAINT live_version_of_app
  FOREIGN KEY (app_id, live_version_id) REFERENCES apps.versions(app_id, version_id);
CREATE TABLE apps.audit_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES apps.versions(version_id),
  actor_id uuid NOT NULL REFERENCES identity.subjects(subject_id),
  from_status text,
  to_status text NOT NULL,
  reason text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION apps.guard_version() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.version_id IS DISTINCT FROM NEW.version_id
    OR OLD.app_id IS DISTINCT FROM NEW.app_id
    OR OLD.version_no IS DISTINCT FROM NEW.version_no
    OR OLD.manifest IS DISTINCT FROM NEW.manifest
    OR OLD.sha256 IS DISTINCT FROM NEW.sha256
    OR OLD.artifact_url IS DISTINCT FROM NEW.artifact_url
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR (OLD.reviewed_at IS NOT NULL AND (
      OLD.approved_by IS DISTINCT FROM NEW.approved_by OR
      OLD.review_reason IS DISTINCT FROM NEW.review_reason OR
      OLD.reviewed_at IS DISTINCT FROM NEW.reviewed_at))
    OR (OLD.status IS DISTINCT FROM NEW.status AND NOT (
      (OLD.status='draft' AND NEW.status='pending') OR
      (OLD.status='pending' AND NEW.status IN ('approved','rejected')) OR
      (OLD.status='approved' AND NEW.status='published') OR
      (OLD.status='published' AND NEW.status IN ('approved','withdrawn'))))
  THEN RAISE EXCEPTION 'Immutable app version'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_version BEFORE UPDATE OR DELETE ON apps.versions
  FOR EACH ROW EXECUTE FUNCTION apps.guard_version();
CREATE FUNCTION apps.guard_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'Immutable app audit'; END $$;
CREATE TRIGGER guard_audit BEFORE UPDATE OR DELETE ON apps.audit_events
  FOR EACH ROW EXECUTE FUNCTION apps.guard_audit();
CREATE FUNCTION apps.guard_registry() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.registry_id IS DISTINCT FROM NEW.registry_id
    OR OLD.app_id IS DISTINCT FROM NEW.app_id
    OR OLD.author_id IS DISTINCT FROM NEW.author_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN RAISE EXCEPTION 'Immutable app identity'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_registry BEFORE UPDATE OR DELETE ON apps.registry
  FOR EACH ROW EXECUTE FUNCTION apps.guard_registry();

CREATE FUNCTION apps.valid_manifest(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE requested_permission jsonb;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' OR
     (SELECT count(*) FROM jsonb_object_keys(value)) <> 6 OR
     NOT value ?& ARRAY['name','author','trustLevel','designRoute','permissions','minPlatformVersion'] OR
     jsonb_typeof(value->'name') <> 'string' OR
     jsonb_typeof(value->'author') <> 'string' OR
     jsonb_typeof(value->'trustLevel') <> 'string' OR
     jsonb_typeof(value->'designRoute') <> 'string' OR
     jsonb_typeof(value->'minPlatformVersion') <> 'string' OR
     jsonb_typeof(value->'permissions') <> 'array' OR
     length(value->>'name') NOT BETWEEN 1 AND 64 OR
     length(value->>'author') NOT BETWEEN 1 AND 64 OR
     btrim(value->>'name') <> value->>'name' OR
     btrim(value->>'author') <> value->>'author' OR
     value->>'name' ~ '[[:cntrl:]<>]' OR value->>'author' ~ '[[:cntrl:]<>]' OR
     value->>'trustLevel' NOT IN ('community','official') OR
     value->>'designRoute' NOT IN ('standard','free-style') OR
     value->>'minPlatformVersion' !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' OR
     (string_to_array(value->>'minPlatformVersion','.'))[1]::integer > 1 OR
     jsonb_array_length(value->'permissions') > 18
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

ALTER TABLE apps.versions ADD CONSTRAINT valid_manifest
  CHECK (apps.valid_manifest(manifest));

CREATE FUNCTION apps.submit_version(
  p_app_id text, p_manifest jsonb, p_sha256 bytea, p_artifact_url text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := identity.current_subject(); own apps.registry%ROWTYPE;
        next_no integer; result apps.versions%ROWTYPE;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE='42501'; END IF;
  IF p_app_id IS NULL OR p_app_id !~ '^[a-z][a-z0-9_.:-]{0,127}$'
    OR NOT apps.valid_manifest(p_manifest)
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

CREATE FUNCTION apps.review_queue() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT identity.can_review_apps() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'appId',v.app_id,'versionId',v.version_id,'versionNo',v.version_no,
    'authorId',r.author_id,'manifest',v.manifest,'sha256',encode(v.sha256,'hex'),
    'artifactUrl',v.artifact_url,'createdAt',v.created_at) ORDER BY v.created_at,v.version_id),'[]'::jsonb)
    FROM apps.versions v JOIN apps.registry r USING(app_id) WHERE v.status='pending');
END $$;

CREATE FUNCTION apps.review_version(p_app_id text,p_version_id uuid,p_approve boolean,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := identity.current_subject(); own apps.registry%ROWTYPE;
        ver apps.versions%ROWTYPE; target text;
BEGIN
  IF NOT identity.can_review_apps() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 1 OR length(p_reason) > 500
    OR p_approve IS NULL THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='22023'; END IF;
  SELECT * INTO own FROM apps.registry WHERE app_id=p_app_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'App not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO ver FROM apps.versions WHERE app_id=p_app_id AND version_id=p_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Version not found' USING ERRCODE='P0002'; END IF;
  IF ver.status <> 'pending' THEN RAISE EXCEPTION 'Invalid transition' USING ERRCODE='55000'; END IF;
  target := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
  UPDATE apps.versions SET status=target,approved_by=actor,review_reason=p_reason,reviewed_at=now()
    WHERE version_id=p_version_id;
  INSERT INTO apps.audit_events(version_id,actor_id,from_status,to_status,reason)
    VALUES(p_version_id,actor,'pending',target,p_reason);
  RETURN jsonb_build_object('appId',p_app_id,'versionId',p_version_id,'status',target);
END $$;

CREATE FUNCTION apps.publish_version(p_app_id text,p_version_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := identity.current_subject(); own apps.registry%ROWTYPE;
        ver apps.versions%ROWTYPE;
BEGIN
  IF NOT identity.can_review_apps() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO own FROM apps.registry WHERE app_id=p_app_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'App not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO ver FROM apps.versions WHERE app_id=p_app_id AND version_id=p_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Version not found' USING ERRCODE='P0002'; END IF;
  IF ver.status <> 'approved' THEN RAISE EXCEPTION 'Invalid transition' USING ERRCODE='55000'; END IF;
  IF own.live_version_id IS NOT NULL THEN
    UPDATE apps.versions SET status='approved' WHERE version_id=own.live_version_id;
    INSERT INTO apps.audit_events(version_id,actor_id,from_status,to_status,reason)
      VALUES(own.live_version_id,actor,'published','approved','superseded');
  END IF;
  UPDATE apps.versions SET status='published' WHERE version_id=p_version_id;
  UPDATE apps.registry SET live_version_id=p_version_id WHERE app_id=p_app_id;
  INSERT INTO apps.audit_events(version_id,actor_id,from_status,to_status)
    VALUES(p_version_id,actor,'approved','published');
  RETURN jsonb_build_object('appId',p_app_id,'versionId',p_version_id,'status','published');
END $$;

CREATE FUNCTION apps.withdraw_app(p_app_id text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := identity.current_subject(); own apps.registry%ROWTYPE;
BEGIN
  IF NOT identity.can_review_apps() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 1 OR length(p_reason) > 500
    THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='22023'; END IF;
  SELECT * INTO own FROM apps.registry WHERE app_id=p_app_id FOR UPDATE;
  IF NOT FOUND OR own.live_version_id IS NULL THEN
    RAISE EXCEPTION 'Invalid transition' USING ERRCODE='55000'; END IF;
  UPDATE apps.versions SET status='withdrawn' WHERE version_id=own.live_version_id;
  UPDATE apps.registry SET live_version_id=NULL WHERE app_id=p_app_id;
  INSERT INTO apps.audit_events(version_id,actor_id,from_status,to_status,reason)
    VALUES(own.live_version_id,actor,'published','withdrawn',p_reason);
  RETURN jsonb_build_object('appId',p_app_id,'versionId',own.live_version_id,'status','withdrawn');
END $$;

CREATE FUNCTION apps.rollback_version(p_app_id text,p_version_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE own apps.registry%ROWTYPE; live_no integer; target_no integer;
BEGIN
  IF NOT identity.can_review_apps() THEN RAISE EXCEPTION 'Forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO own FROM apps.registry WHERE app_id=p_app_id FOR UPDATE;
  IF NOT FOUND OR own.live_version_id IS NULL THEN
    RAISE EXCEPTION 'Invalid transition' USING ERRCODE='55000'; END IF;
  SELECT version_no INTO live_no FROM apps.versions WHERE version_id=own.live_version_id;
  SELECT version_no INTO target_no FROM apps.versions
    WHERE app_id=p_app_id AND version_id=p_version_id AND status='approved';
  IF target_no IS NULL OR target_no >= live_no OR NOT EXISTS (
    SELECT 1 FROM apps.audit_events WHERE version_id=p_version_id AND to_status='published'
  ) THEN
    RAISE EXCEPTION 'Invalid transition' USING ERRCODE='55000'; END IF;
  RETURN apps.publish_version(p_app_id,p_version_id);
END $$;

CREATE FUNCTION apps.published() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'appId',r.app_id,'registryId',r.registry_id,
    'versionId',v.version_id,'versionNo',v.version_no,'manifest',v.manifest,
    'sha256',encode(v.sha256,'hex'),'artifactUrl',v.artifact_url,
    'grantedPermissions',(SELECT coalesce(jsonb_agg(permission),'[]'::jsonb)
      FROM jsonb_array_elements_text(v.manifest->'permissions') AS grants(permission)
      WHERE permission IN ('identity.self.read','theme.read','navigation',
        'storage.self','dao.public.read','telegram.username.read','wallet.address.read',
        'wallet.balances.read','jpegpe.collection.read','notifications.send'))
    ) ORDER BY r.app_id),'[]'::jsonb)
  FROM apps.registry r JOIN apps.versions v ON v.version_id=r.live_version_id
  WHERE v.status='published' AND v.reviewed_at IS NOT NULL AND v.approved_by IS NOT NULL
$$;

ALTER TABLE apps.registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE apps.registry FORCE ROW LEVEL SECURITY;
ALTER TABLE apps.versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE apps.versions FORCE ROW LEVEL SECURITY;
ALTER TABLE apps.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE apps.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON apps.registry TO apps_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON apps.versions TO apps_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_access ON apps.audit_events TO apps_owner USING (true) WITH CHECK (true);
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA apps FROM PUBLIC;
GRANT USAGE ON SCHEMA apps TO apps_service;
GRANT EXECUTE ON FUNCTION apps.submit_version(text,jsonb,bytea,text),
  apps.review_queue(),apps.review_version(text,uuid,boolean,text),
  apps.publish_version(text,uuid),apps.rollback_version(text,uuid),
  apps.withdraw_app(text,text),apps.published() TO apps_service;
RESET ROLE;
