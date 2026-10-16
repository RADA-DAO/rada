SET LOCAL ROLE splash_owner;

-- Live availability of a proposed permanent name for the bid sheet: 'invalid'
-- (format), 'taken' (an existing frog or an active hold) or 'available'. The
-- rule stays JPEGPE's; SPLASH only relays it. A bid can still lose the name
-- when another winner of the same round claims it first.
CREATE FUNCTION splash.name_status(candidate text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jpegpe.username_status(candidate)
$$;

REVOKE ALL ON FUNCTION splash.name_status(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION splash.name_status(text) TO splash_service;
RESET ROLE;
