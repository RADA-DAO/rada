BEGIN;
CREATE FUNCTION pg_temp.ops_assert(value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Ops assertion failed'; END IF; END $$;
SET LOCAL ROLE ops_service;
SELECT ops.record_client_error('abc1234', 'home', 'error', 'TypeError', 'x is undefined', '["main.js:1:2"]');
DO $$ BEGIN
  PERFORM * FROM ops.client_errors;
  RAISE EXCEPTION 'Ops service read the base table';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ops.client_errors(build, route, kind, name, message, frames) VALUES ('a', 'home', 'error', 'E', '', '[]');
  RAISE EXCEPTION 'Ops service wrote the base table';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM ops.record_client_error('abc1234', 'home', 'bogus', 'E', '', '[]');
  RAISE EXCEPTION 'Invalid kind accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM ops.record_client_error('abc1234', 'home', 'error', 'E', repeat('a', 121), '[]');
  RAISE EXCEPTION 'Long message accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM ops.purge_client_errors(interval '1 hour');
  RAISE EXCEPTION 'Short retention accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
RESET ROLE;
-- Retention: backdate one row, keep the fresh one.
INSERT INTO ops.client_errors(received_at, build, route, kind, name, message, frames)
  VALUES (now() - interval '31 days', 'old', 'home', 'error', 'E', '', '[]');
SET LOCAL ROLE ops_service;
SELECT pg_temp.ops_assert(ops.purge_client_errors() = 1);
RESET ROLE;
SELECT pg_temp.ops_assert((SELECT count(*) FROM ops.client_errors WHERE build = 'old') = 0);
SELECT pg_temp.ops_assert((SELECT count(*) FROM ops.client_errors WHERE build = 'abc1234') = 1);
ROLLBACK;
