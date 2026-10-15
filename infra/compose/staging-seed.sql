BEGIN;
SET LOCAL ROLE identity_owner;
-- Deliberately synthetic fixture identifiers; no authority or balances.
INSERT INTO identity.subjects (subject_id) VALUES
  ('00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000102') ON CONFLICT DO NOTHING;
INSERT INTO identity.telegram_accounts (subject_id, telegram_user_id) VALUES
  ('00000000-0000-4000-8000-000000000101', 101),
  ('00000000-0000-4000-8000-000000000102', 102)
ON CONFLICT DO NOTHING;
DO $$ BEGIN
  IF (SELECT count(*) FROM identity.telegram_accounts WHERE
    (subject_id, telegram_user_id) IN (
      ('00000000-0000-4000-8000-000000000101'::uuid, 101),
      ('00000000-0000-4000-8000-000000000102'::uuid, 102))) <> 2
    OR (SELECT count(*) FROM identity.telegram_accounts) <> 2
    OR (SELECT count(*) FROM identity.subjects) <> 2
    OR EXISTS (SELECT FROM identity.role_grants)
    OR EXISTS (SELECT FROM identity.consents)
    OR EXISTS (SELECT FROM identity.subjects WHERE selected_frog_id IS NOT NULL)
  THEN RAISE EXCEPTION 'Staging fixture invariant failed'; END IF;
END $$;
COMMIT;
