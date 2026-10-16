SET LOCAL ROLE ops_owner;
-- Single-row watermark: the highest client_errors id already reported in a digest.
CREATE TABLE ops.alert_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  client_errors_after bigint NOT NULL DEFAULT 0 CHECK (client_errors_after >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ops.alert_state(singleton) VALUES (true);
REVOKE ALL ON ops.alert_state FROM PUBLIC;

CREATE FUNCTION ops.alert_watermark() RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT client_errors_after FROM ops.alert_state
$$;

-- Counts only: kind, name and route are constrained identifiers; messages and frames are never returned.
-- grand_total and last_id describe every new row, not only the returned top groups.
CREATE FUNCTION ops.client_error_summary(p_after bigint, p_limit integer DEFAULT 10)
RETURNS TABLE (kind text, name text, route text, total bigint, grand_total bigint, last_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT g.kind, g.name, g.route, g.total, sum(g.total) OVER (), max(g.last_id) OVER ()
  FROM (
    SELECT e.kind, e.name, e.route, count(*) AS total, max(e.id) AS last_id
    FROM ops.client_errors e
    WHERE e.id > p_after
    GROUP BY e.kind, e.name, e.route
  ) g
  ORDER BY g.total DESC, g.kind, g.name, g.route
  LIMIT greatest(1, least(p_limit, 50))
$$;

-- Forward-only: the watermark never moves back.
CREATE FUNCTION ops.advance_alert_watermark(p_last_id bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE ops.alert_state
  SET client_errors_after = greatest(client_errors_after, p_last_id), updated_at = now()
$$;

REVOKE ALL ON FUNCTION ops.alert_watermark() FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.client_error_summary(bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ops.advance_alert_watermark(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops.alert_watermark() TO ops_service;
GRANT EXECUTE ON FUNCTION ops.client_error_summary(bigint, integer) TO ops_service;
GRANT EXECUTE ON FUNCTION ops.advance_alert_watermark(bigint) TO ops_service;
RESET ROLE;
