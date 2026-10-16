SET LOCAL ROLE apps_owner;
-- Adds the optional manifest `icon`: a relative PNG, WebP or SVG path of at most three
-- lower-case segments. The image itself is checked by the reviewer, who approves the manifest.
CREATE OR REPLACE FUNCTION apps.valid_manifest(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE requested_permission jsonb;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' OR
     EXISTS (SELECT 1 FROM jsonb_object_keys(value) AS k(key)
             WHERE k.key NOT IN ('name','author','trustLevel','designRoute','permissions','minPlatformVersion','icon')) OR
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
RESET ROLE;
