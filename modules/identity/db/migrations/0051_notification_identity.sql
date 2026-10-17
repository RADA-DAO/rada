CREATE ROLE notifications_owner NOLOGIN;
CREATE ROLE notifications_service NOLOGIN;
CREATE SCHEMA notifications AUTHORIZATION notifications_owner;
GRANT USAGE ON SCHEMA identity TO notifications_owner;
GRANT EXECUTE ON FUNCTION identity.current_subject() TO notifications_owner;
SET LOCAL ROLE identity_owner;
CREATE FUNCTION identity.notification_destination(s uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT telegram_user_id::text FROM identity.telegram_accounts WHERE subject_id=s
$$;
REVOKE ALL ON FUNCTION identity.notification_destination(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.notification_destination(uuid) TO notifications_owner;
RESET ROLE;
