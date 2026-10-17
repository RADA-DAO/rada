SET LOCAL ROLE governance_owner;
CREATE FUNCTION governance.notify_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF TG_TABLE_NAME='openings' THEN
 PERFORM notifications.broadcast('governance:opened:'||NEW.proposal_id,'opened',NEW.closes_at);
 ELSE
 PERFORM notifications.broadcast('governance:decision:'||NEW.proposal_id,'decision',clock_timestamp()+interval '1 day');
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER notify_open AFTER INSERT ON governance.openings FOR EACH ROW EXECUTE FUNCTION governance.notify_event();
CREATE TRIGGER notify_decision AFTER INSERT ON governance.decisions FOR EACH ROW EXECUTE FUNCTION governance.notify_event();
CREATE FUNCTION governance.notification_reminders() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM governance.openings o WHERE closes_at>clock_timestamp()
 AND closes_at<=clock_timestamp()+interval '12 hours'
 AND NOT EXISTS(SELECT FROM governance.closures c WHERE c.proposal_id=o.proposal_id)
 AND NOT EXISTS(SELECT FROM governance.withdrawals w WHERE w.proposal_id=o.proposal_id) LOOP
 PERFORM notifications.broadcast('governance:closing:'||r.proposal_id,'closing',r.closes_at);
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA governance TO notifications_service;
GRANT EXECUTE ON FUNCTION governance.notification_reminders() TO notifications_service;

CREATE FUNCTION governance.cancel_notifications() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 PERFORM notifications.cancel('governance:opened:'||NEW.proposal_id);
 PERFORM notifications.cancel('governance:closing:'||NEW.proposal_id);
 RETURN NEW;
END $$;
CREATE TRIGGER cancel_notifications AFTER INSERT ON governance.withdrawals
 FOR EACH ROW EXECUTE FUNCTION governance.cancel_notifications();
CREATE TRIGGER cancel_closed_notifications AFTER INSERT ON governance.closures
 FOR EACH ROW EXECUTE FUNCTION governance.cancel_notifications();
RESET ROLE;
