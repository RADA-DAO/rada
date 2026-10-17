BEGIN;
CREATE FUNCTION pg_temp.assert_true(value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Artwork assertion failed'; END IF; END $$;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(920001) AS owner \gset
SELECT identity.resolve_telegram(920002) AS other \gset
RESET ROLE;
SELECT gen_random_uuid() AS frog \gset
SET LOCAL ROLE jpegpe_operator;
SELECT jpegpe.create_frog(:'frog', 'ArtworkReadFixture', :'owner');
RESET ROLE;
SET LOCAL ROLE legacy_import;
SELECT jpegpe.import_artwork(:'frog', 'image/jpeg', true, decode('ffd8ffd9', 'hex'));
RESET ROLE;
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id', '', true);
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM jpegpe.read_artwork(:'frog')));
SELECT set_config('rada.subject_id', :'other', true);
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM jpegpe.read_artwork(:'frog')));
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM jpegpe.visible_artwork(ARRAY[:'frog'::uuid])));
SELECT set_config('rada.subject_id', :'owner', true);
SELECT pg_temp.assert_true((SELECT NOT is_public AND content_type = 'image/jpeg' AND needs_normalization
  AND sha256 = encode(sha256(bytes), 'hex') FROM jpegpe.read_artwork(:'frog')));
SELECT identity.select_frog(:'frog');
SELECT set_config('rada.subject_id', '', true);
SELECT pg_temp.assert_true((SELECT is_public FROM jpegpe.read_artwork(:'frog')));
DO $$ BEGIN
  PERFORM * FROM jpegpe.artwork;
  RAISE EXCEPTION 'Direct artwork access allowed';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM * FROM jpegpe.import_artwork_state(gen_random_uuid());
  RAISE EXCEPTION 'Import-only read allowed';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
SET LOCAL ROLE jpegpe_operator;
SELECT jpegpe.transfer_frog(:'frog', :'owner', :'other');
RESET ROLE;
SET LOCAL ROLE identity_service;
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM jpegpe.read_artwork(:'frog')));
SELECT set_config('rada.subject_id', :'owner', true);
SELECT pg_temp.assert_true((SELECT count(*) = 0 FROM jpegpe.read_artwork(:'frog')));
SELECT set_config('rada.subject_id', :'other', true);
SELECT pg_temp.assert_true((SELECT NOT is_public FROM jpegpe.read_artwork(:'frog')));
RESET ROLE;
-- A public SPLASH image makes an issued frog public without a profile selection.
SELECT gen_random_uuid() AS pond_frog \gset
SET LOCAL ROLE splash_service;
SELECT splash.submit_frog(:'pond_frog');
SELECT splash.store_image(:'pond_frog', repeat('a', 64), 64, 64, false, decode('89504e47', 'hex'));
RESET ROLE;
SET LOCAL ROLE jpegpe_operator;
SELECT jpegpe.create_frog(:'pond_frog', 'PondArtworkFixture', :'other');
RESET ROLE;
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id', '', true);
SELECT pg_temp.assert_true((SELECT is_public AND content_type = 'image/png' AND NOT needs_normalization
  AND sha256 = encode(sha256(bytes), 'hex') FROM jpegpe.read_artwork(:'pond_frog')));
RESET ROLE;
SET LOCAL ROLE legacy_import;
SELECT jpegpe.import_artwork(:'pond_frog', 'image/jpeg', true, decode('ffd8ffd9', 'hex'));
RESET ROLE;
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id', '', true);
SELECT pg_temp.assert_true((SELECT is_public FROM jpegpe.read_artwork(:'pond_frog')));
ROLLBACK;
