SET LOCAL ROLE identity_owner;
CREATE FUNCTION identity.import_person(p_id uuid, p_telegram bigint, p_created timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- Never resolve by Telegram: an existing link is a conflict, not a merge.
  INSERT INTO identity.subjects(subject_id, created_at) VALUES (p_id, p_created);
  IF p_telegram IS NOT NULL THEN
    INSERT INTO identity.telegram_accounts(subject_id, telegram_user_id, verified_at)
      VALUES (p_id, p_telegram, p_created);
  END IF;
END $$;
CREATE FUNCTION identity.import_person_state(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', s.subject_id, 'telegram_id', t.telegram_user_id::text,
    'created_at', to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
  FROM identity.subjects s LEFT JOIN identity.telegram_accounts t USING (subject_id)
  WHERE s.subject_id = p_id
$$;
CREATE FUNCTION identity.import_telegram_available(p_telegram bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT NOT EXISTS (SELECT 1 FROM identity.telegram_accounts WHERE telegram_user_id = p_telegram)
$$;
CREATE FUNCTION identity.import_selection(p_id uuid, p_frog uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM set_config('rada.subject_id', p_id::text, true);
  RETURN identity.select_frog(p_frog);
END $$;
CREATE FUNCTION identity.import_selection_state(p_id uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT selected_frog_id FROM identity.subjects WHERE subject_id = p_id
$$;
REVOKE ALL ON FUNCTION identity.import_person(uuid,bigint,timestamptz),
  identity.import_person_state(uuid), identity.import_telegram_available(bigint),
  identity.import_selection(uuid,uuid), identity.import_selection_state(uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA identity TO legacy_import;
GRANT EXECUTE ON FUNCTION identity.import_person(uuid,bigint,timestamptz),
  identity.import_person_state(uuid), identity.import_telegram_available(bigint),
  identity.import_selection(uuid,uuid), identity.import_selection_state(uuid) TO legacy_import;
RESET ROLE;
