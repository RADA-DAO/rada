BEGIN;
CREATE FUNCTION pg_temp.splash_assert(value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Splash assertion failed'; END IF; END $$;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(610001) AS author \gset
SELECT identity.resolve_telegram(610002) AS other \gset
RESET ROLE;
SELECT gen_random_uuid() AS public_frog \gset
SET LOCAL ROLE jpegpe_operator;
SELECT jpegpe.create_frog(:'public_frog', 'Splash_Author', :'author', '#102030', '#AABBCC');
RESET ROLE;

-- Submit as the author: five accepted, the sixth refused with a wait time.
SET LOCAL ROLE splash_service;
SELECT set_config('rada.subject_id', :'author', true);
DO $$
DECLARE r record; image uuid;
BEGIN
  FOR i IN 1..5 LOOP
    image := gen_random_uuid();
    SELECT * INTO r FROM splash.submit_frog(image);
    IF r.accepted_at IS NULL OR r.retry_after_seconds <> 0 THEN
      RAISE EXCEPTION 'Submission % was refused', i;
    END IF;
    PERFORM splash.store_image(image, md5(i::text) || md5('x' || i::text), 100, 100, true, '\x89504e47'::bytea);
  END LOOP;
  SELECT * INTO r FROM splash.submit_frog(gen_random_uuid());
  IF r.accepted_at IS NOT NULL OR r.retry_after_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'Rate limit did not apply';
  END IF;
END $$;
SELECT pg_temp.splash_assert((SELECT count(*) = 5 FROM splash.my_submissions() WHERE state = 'in_pond'));
-- The profile is private until the author selects a frog: the pond shows no author.
SELECT pg_temp.splash_assert((SELECT count(*) = 0 FROM splash.pond() WHERE author_frog_id IS NOT NULL));
RESET ROLE;
SELECT submission_id AS first_submission FROM splash.submissions
  WHERE author_subject_id = :'author' ORDER BY submitted_at, submission_id LIMIT 1 \gset

-- Another person sees the pond without author ids and cannot see or attach to the first author's rows.
SET LOCAL ROLE splash_service;
SELECT set_config('rada.subject_id', :'other', true);
SELECT pg_temp.splash_assert((SELECT count(*) = 0 FROM splash.my_submissions()));
SELECT pg_temp.splash_assert((SELECT count(*) >= 5 FROM splash.pond()));
SELECT pg_temp.splash_assert((SELECT count(*) = 1 FROM splash.submission_image(:'first_submission')));
SELECT pg_temp.splash_assert(splash.author_of(:'first_submission') = :'author');
DO $$ BEGIN
  PERFORM splash.store_image(gen_random_uuid(), repeat('c', 64), 100, 100, true, '\x01'::bytea);
  RAISE EXCEPTION 'Image attached to an unknown submission';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
-- The other author has a clean limit, and old submissions do not count.
RESET ROLE;
INSERT INTO splash.submissions(submission_id, author_subject_id, submitted_at)
  SELECT gen_random_uuid(), :'other', now() - interval '25 hours' FROM generate_series(1, 5);
SET LOCAL ROLE splash_service;
SELECT set_config('rada.subject_id', :'other', true);
SELECT pg_temp.splash_assert((SELECT accepted_at IS NOT NULL FROM splash.submit_frog(gen_random_uuid())));
-- Same processed image twice is refused.
DO $$ DECLARE image uuid := gen_random_uuid();
BEGIN
  PERFORM splash.submit_frog(image);
  PERFORM splash.store_image(image, repeat('d', 64), 64, 64, false, '\x02'::bytea);
  image := gen_random_uuid();
  PERFORM splash.submit_frog(image);
  PERFORM splash.store_image(image, repeat('d', 64), 64, 64, false, '\x02'::bytea);
  RAISE EXCEPTION 'Duplicate image accepted';
EXCEPTION WHEN unique_violation THEN NULL; END $$;
-- Out-of-range image metadata and size are rejected by constraints.
DO $$ DECLARE image uuid := gen_random_uuid();
BEGIN
  PERFORM splash.submit_frog(image);
  PERFORM splash.store_image(image, repeat('e', 64), 100, 100, true, ''::bytea);
  RAISE EXCEPTION 'Empty image accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ DECLARE image uuid := gen_random_uuid();
BEGIN
  PERFORM splash.submit_frog(image);
  PERFORM splash.store_image(image, repeat('f', 64), 100, 100, true, decode(repeat('00', 4194305), 'hex'));
  RAISE EXCEPTION 'Oversized image accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;

-- No subject context: nothing can be submitted; the public pond still reads.
RESET ROLE;
SET LOCAL ROLE splash_service;
SELECT set_config('rada.subject_id', '', true);
DO $$ BEGIN
  PERFORM splash.submit_frog(gen_random_uuid());
  RAISE EXCEPTION 'Anonymous submission accepted';
EXCEPTION WHEN invalid_authorization_specification THEN NULL; END $$;
SELECT pg_temp.splash_assert((SELECT count(*) = 0 FROM splash.my_submissions()));

-- Least privilege: the service login has no table access and cannot call internals.
DO $$ BEGIN
  PERFORM * FROM splash.submissions;
  RAISE EXCEPTION 'Service read a base table';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO splash.submission_events(submission_id, state) VALUES (gen_random_uuid(), 'in_pond');
  RAISE EXCEPTION 'Service wrote a base table';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM splash.current_state(gen_random_uuid());
  RAISE EXCEPTION 'Service called an internal helper';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM jpegpe.public_profile_frog(gen_random_uuid());
  RAISE EXCEPTION 'Service called another module profile function';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;

-- History is immutable even for the owner.
SET LOCAL ROLE splash_owner;
DO $$ BEGIN
  UPDATE splash.submissions SET author_subject_id = gen_random_uuid();
  RAISE EXCEPTION 'Submission rewritten';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  DELETE FROM splash.submission_events;
  RAISE EXCEPTION 'Events deleted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  UPDATE splash.submission_images SET bytes = '\x00'::bytea;
  RAISE EXCEPTION 'Image rewritten';
EXCEPTION WHEN check_violation THEN NULL; END $$;
RESET ROLE;

-- Author identity follows the public profile rule: shown once the author selects a
-- frog, hidden again when the frog is no longer owned.
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id', :'author', true);
SELECT pg_temp.splash_assert(identity.select_frog(:'public_frog'));
RESET ROLE;
SET LOCAL ROLE splash_service;
SELECT pg_temp.splash_assert((SELECT count(*) = 5 FROM splash.pond()
  WHERE author_frog_id = :'public_frog' AND author_username = 'Splash_Author'
    AND author_background_color = '#102030' AND author_accent_color = '#AABBCC'));
RESET ROLE;
SET LOCAL ROLE jpegpe_operator;
SELECT jpegpe.transfer_frog(:'public_frog', :'author', :'other');
RESET ROLE;
SET LOCAL ROLE splash_service;
SELECT pg_temp.splash_assert((SELECT count(*) = 0 FROM splash.pond() WHERE author_frog_id IS NOT NULL));
RESET ROLE;
ROLLBACK;
