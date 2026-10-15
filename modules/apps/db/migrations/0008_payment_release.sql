SET LOCAL ROLE apps_owner;
CREATE FUNCTION apps.money_transfer_released(p_app_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM apps.registry r, apps.versions v
    WHERE r.live_version_id = v.version_id AND r.app_id = p_app_id
      AND v.status = 'published' AND v.reviewed_at IS NOT NULL
      AND v.approved_by IS NOT NULL AND v.manifest->'permissions' ? 'money.transfer'
  )
$$;
REVOKE ALL ON FUNCTION apps.money_transfer_released(text) FROM PUBLIC;
GRANT USAGE ON SCHEMA apps TO wallet_service;
GRANT EXECUTE ON FUNCTION apps.money_transfer_released(text) TO wallet_service;
CREATE OR REPLACE FUNCTION apps.published() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'appId',r.app_id,'registryId',r.registry_id,
    'versionId',v.version_id,'versionNo',v.version_no,'manifest',v.manifest,
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
RESET ROLE;
