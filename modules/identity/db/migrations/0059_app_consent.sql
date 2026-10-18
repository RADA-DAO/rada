SET LOCAL ROLE identity_owner;
ALTER TABLE identity.consents DROP CONSTRAINT consents_capability_check;
ALTER TABLE identity.consents ADD CONSTRAINT consents_capability_check CHECK (capability IN (
 'telegram.username.read','wallet.address.read','wallet.balances.read',
 'jpegpe.collection.read','notifications.send','storage.self','scores'));
-- The same transaction lock serializes consent changes and capability operations.
CREATE FUNCTION identity.lock_app_consent(p_app text, p_permission text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s uuid := identity.current_subject();
BEGIN
 IF s IS NULL THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(s::text || ':' || p_app, 59));
 RETURN EXISTS (SELECT FROM identity.consents WHERE subject_id=s AND app_id=p_app
   AND capability=p_permission AND revoked_at IS NULL);
END $$;
CREATE FUNCTION identity.serialize_app_consent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.subject_id::text || ':' || NEW.app_id, 59));
 RETURN NEW;
END $$;
CREATE TRIGGER serialize_app_consent BEFORE INSERT OR UPDATE ON identity.consents
 FOR EACH ROW EXECUTE FUNCTION identity.serialize_app_consent();
REVOKE ALL ON FUNCTION identity.lock_app_consent(text,text), identity.serialize_app_consent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.lock_app_consent(text,text) TO apps_owner;
RESET ROLE;
SET LOCAL ROLE identity_owner;
CREATE FUNCTION identity.erase_revoked_app_records() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
  PERFORM apps.erase_personal_records(NEW.subject_id,NEW.app_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER erase_revoked_app_records AFTER UPDATE ON identity.consents
 FOR EACH ROW EXECUTE FUNCTION identity.erase_revoked_app_records();
REVOKE ALL ON FUNCTION identity.erase_revoked_app_records() FROM PUBLIC;
RESET ROLE;
