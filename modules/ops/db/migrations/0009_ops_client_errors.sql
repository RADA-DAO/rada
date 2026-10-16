CREATE ROLE ops_owner NOLOGIN;
CREATE ROLE ops_service NOLOGIN;
CREATE SCHEMA ops AUTHORIZATION ops_owner;
SET LOCAL ROLE ops_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
-- Sanitized client-side failure reports. No subject, address, token or IP column exists.
CREATE TABLE ops.client_errors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  build text NOT NULL CHECK (build ~ '^[0-9A-Za-z._-]{1,32}$'),
  route text NOT NULL CHECK (route ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  kind text NOT NULL CHECK (kind IN ('error', 'unhandledrejection')),
  name text NOT NULL CHECK (name ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
  message text NOT NULL CHECK (length(message) <= 120),
  frames jsonb NOT NULL CHECK (
    jsonb_typeof(frames) = 'array' AND jsonb_array_length(frames) <= 10 AND length(frames::text) <= 2048
  )
);
CREATE INDEX client_errors_received ON ops.client_errors(received_at);
REVOKE ALL ON ALL TABLES IN SCHEMA ops FROM PUBLIC;

CREATE FUNCTION ops.record_client_error(
  p_build text, p_route text, p_kind text, p_name text, p_message text, p_frames jsonb
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO ops.client_errors(build, route, kind, name, message, frames)
  VALUES (p_build, p_route, p_kind, p_name, p_message, p_frames)
$$;

-- Retention: schedule `SELECT ops.purge_client_errors();` daily where a scheduler
-- exists. The API also calls it at most once per hour after an insert.
CREATE FUNCTION ops.purge_client_errors(p_retention interval DEFAULT interval '30 days')
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE removed bigint;
BEGIN
  IF p_retention < interval '1 day' THEN
    RAISE EXCEPTION 'Retention below one day is not allowed' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM ops.client_errors WHERE received_at < now() - p_retention;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

REVOKE ALL ON FUNCTION ops.record_client_error(text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.purge_client_errors(interval) FROM PUBLIC;
GRANT USAGE ON SCHEMA ops TO ops_service;
GRANT EXECUTE ON FUNCTION ops.record_client_error(text, text, text, text, text, jsonb) TO ops_service;
GRANT EXECUTE ON FUNCTION ops.purge_client_errors(interval) TO ops_service;
RESET ROLE;
