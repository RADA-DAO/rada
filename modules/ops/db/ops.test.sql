BEGIN;
CREATE FUNCTION pg_temp.ops_assert(value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Ops assertion failed'; END IF; END $$;
SET LOCAL ROLE ops_service;
SELECT ops.record_client_error('abc1234', 'home', 'error', 'TypeError', 'type_error', '["main.js:1:2"]');
DO $$ BEGIN
  PERFORM * FROM ops.client_errors;
  RAISE EXCEPTION 'Ops service read the base table';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  INSERT INTO ops.client_errors(build, route, kind, name, message, frames) VALUES ('a', 'home', 'error', 'E', 'unknown', '[]');
  RAISE EXCEPTION 'Ops service wrote the base table';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  PERFORM ops.record_client_error('abc1234', 'home', 'bogus', 'E', 'unknown', '[]');
  RAISE EXCEPTION 'Invalid kind accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ BEGIN
  PERFORM ops.record_client_error('abc1234', 'home', 'error', 'E', repeat('a', 121), '[]');
  RAISE EXCEPTION 'Long message accepted';
EXCEPTION WHEN check_violation THEN NULL; END $$;
DO $$ DECLARE message text; BEGIN
  FOREACH message IN ARRAY ARRAY['Example Person', 'example_person', '', 'TypeError', 'type_error ', 'unknown' || chr(10)] LOOP
    BEGIN
      PERFORM ops.record_client_error('abc1234', 'home', 'error', 'E', message, '[]');
      RAISE EXCEPTION 'Free-form message accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  END LOOP;
END $$;
DO $$ DECLARE code text; BEGIN
  FOREACH code IN ARRAY ARRAY[
    'unknown', 'type_error', 'range_error', 'reference_error', 'syntax_error',
    'uri_error', 'eval_error', 'aggregate_error', 'abort_error', 'timeout_error'
  ] LOOP
    PERFORM ops.record_client_error('codesfixture', 'home', 'error', 'E', code, '[]');
  END LOOP;
END $$;
DO $$ BEGIN
  PERFORM ops.purge_client_errors(interval '1 hour');
  RAISE EXCEPTION 'Short retention accepted';
EXCEPTION WHEN invalid_parameter_value THEN NULL; END $$;
RESET ROLE;
-- Retention: backdate one row, keep the fresh one.
INSERT INTO ops.client_errors(received_at, build, route, kind, name, message, frames)
  VALUES (now() - interval '31 days', 'old', 'home', 'error', 'E', 'unknown', '[]');
SET LOCAL ROLE ops_service;
SELECT pg_temp.ops_assert(ops.purge_client_errors() = 1);
RESET ROLE;
SELECT pg_temp.ops_assert((SELECT count(*) FROM ops.client_errors WHERE build = 'old') = 0);
SELECT pg_temp.ops_assert((SELECT count(*) FROM ops.client_errors WHERE build = 'abc1234') = 1);
SELECT pg_temp.ops_assert((SELECT count(*) FROM ops.client_errors WHERE build = 'codesfixture') = 10);
-- Alert digest: summary is callable by ops_service, the state table is not readable.
SET LOCAL ROLE ops_service;
DO $$ BEGIN
  PERFORM * FROM ops.alert_state;
  RAISE EXCEPTION 'Ops service read the alert state table';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
DO $$ BEGIN
  UPDATE ops.alert_state SET client_errors_after = 99;
  RAISE EXCEPTION 'Ops service wrote the alert state table';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
SELECT pg_temp.ops_assert((SELECT count(*) FROM ops.client_error_summary(0)) >= 1);
SELECT pg_temp.ops_assert((SELECT sum(total) FROM ops.client_error_summary(0)) >= 1);
SELECT ops.advance_alert_watermark(5);
SELECT ops.advance_alert_watermark(2);
SELECT pg_temp.ops_assert(ops.alert_watermark() = 5);
RESET ROLE;
ROLLBACK;
