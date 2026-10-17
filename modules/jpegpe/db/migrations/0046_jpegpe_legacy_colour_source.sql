SET LOCAL ROLE jpegpe_owner;
ALTER TABLE jpegpe.frogs ADD COLUMN colour_source text NOT NULL DEFAULT 'proof'
  CHECK (colour_source IN ('proof', 'legacy_unverified'));
-- Preserve authored colours and existing proofs without asserting missing evidence.
UPDATE jpegpe.frogs SET colour_source = 'legacy_unverified'
WHERE (background_color IS NOT NULL AND background_proof IS NULL)
   OR (accent_color IS NOT NULL AND accent_proof IS NULL);
CREATE OR REPLACE FUNCTION jpegpe.import_frog(p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e jsonb; prior uuid; recipient uuid; stamp timestamptz;
BEGIN
  IF p->>'colour_source' IS NULL OR p->>'colour_source' NOT IN ('proof', 'legacy_unverified')
     OR (p->>'colour_source' = 'proof' AND (
       (p->>'background_color' IS NOT NULL AND nullif(p->'background_proof', 'null') IS NULL)
       OR (p->>'accent_color' IS NOT NULL AND nullif(p->'accent_proof', 'null') IS NULL))) THEN
    RAISE EXCEPTION 'Invalid imported colour source' USING ERRCODE = '22023';
  END IF;
  -- Reuse the public name hold protocol, including its namespace locks.
  IF NOT jpegpe.hold_username(p->>'username', (p->>'id')::uuid) THEN
    RAISE EXCEPTION 'Import name conflict' USING ERRCODE = '23505';
  END IF;
  INSERT INTO jpegpe.frogs(frog_id, username, display_name, creator_subject_id, current_owner_subject_id,
    background_color, accent_color, background_proof, accent_proof, colour_source, created_at)
  VALUES ((p->>'id')::uuid, p->>'username', p->>'display_name', (p->>'creator')::uuid, (p->>'owner')::uuid,
    p->>'background_color', p->>'accent_color', nullif(p->'background_proof', 'null'),
    nullif(p->'accent_proof', 'null'), p->>'colour_source', (p->>'created_at')::timestamptz);
  INSERT INTO jpegpe.username_hold_ends(hold_id, outcome)
    SELECT h.hold_id, 'confirmed' FROM jpegpe.username_holds h WHERE h.frog_id = (p->>'id')::uuid
      AND NOT EXISTS (SELECT 1 FROM jpegpe.username_hold_ends e WHERE e.hold_id = h.hold_id);
  prior := NULL;
  stamp := (p->>'created_at')::timestamptz;
  FOR e IN SELECT value FROM jsonb_array_elements(p->'events') LOOP
    recipient := (e->>'to')::uuid;
    IF (e->>'from')::uuid IS DISTINCT FROM prior OR recipient IS NULL
       OR (e->>'at')::timestamptz < stamp THEN
      RAISE EXCEPTION 'Invalid imported ownership chain' USING ERRCODE = '22023';
    END IF;
    INSERT INTO jpegpe.ownership_events(frog_id, from_subject_id, to_subject_id, occurred_at, imported, import_key)
      VALUES ((p->>'id')::uuid, prior, recipient, (e->>'at')::timestamptz, true, e->>'key');
    prior := recipient;
    stamp := (e->>'at')::timestamptz;
  END LOOP;
  IF prior IS DISTINCT FROM (p->>'owner')::uuid THEN
    RAISE EXCEPTION 'Imported owner mismatch' USING ERRCODE = '22023';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION jpegpe.import_frog_state(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', f.frog_id, 'username', f.username, 'display_name', f.display_name,
    'creator', f.creator_subject_id, 'owner', f.current_owner_subject_id,
    'colour_source', f.colour_source, 'background_color', f.background_color, 'accent_color', f.accent_color,
    'background_proof', f.background_proof, 'accent_proof', f.accent_proof,
    'created_at', to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'events', (SELECT jsonb_agg(jsonb_build_object('from', e.from_subject_id, 'to', e.to_subject_id,
      'at', to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'key', e.import_key, 'imported', e.imported) ORDER BY e.event_id)
      FROM jpegpe.ownership_events e WHERE e.frog_id = f.frog_id))
  FROM jpegpe.frogs f WHERE f.frog_id = p_id
$$;
RESET ROLE;
