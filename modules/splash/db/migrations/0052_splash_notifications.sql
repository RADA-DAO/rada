SET LOCAL ROLE splash_owner;
CREATE FUNCTION splash.notify_win() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NEW.winner_subject_id IS NOT NULL THEN
 PERFORM notifications.enqueue('splash:won:'||NEW.submission_id,'won','splash',NEW.winner_subject_id,NEW.claim_deadline);
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER notify_win AFTER INSERT ON splash.lot_results FOR EACH ROW EXECUTE FUNCTION splash.notify_win();
CREATE FUNCTION splash.notify_outcome() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s uuid;
BEGIN
 PERFORM notifications.cancel('splash:deadline:'||NEW.submission_id);
 PERFORM notifications.cancel('splash:won:'||NEW.submission_id);
 SELECT winner_subject_id INTO s FROM splash.lot_results WHERE submission_id=NEW.submission_id AND winner_subject_id IS NOT NULL;
 PERFORM notifications.enqueue('splash:'||NEW.outcome||':'||NEW.submission_id,NEW.outcome,'splash',s,clock_timestamp()+interval '1 day');
 RETURN NEW;
END $$;
CREATE TRIGGER notify_outcome AFTER INSERT ON splash.claim_outcomes FOR EACH ROW EXECUTE FUNCTION splash.notify_outcome();
CREATE FUNCTION splash.notification_reminders() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM splash.lot_results l WHERE winner_subject_id IS NOT NULL
 AND claim_deadline>clock_timestamp() AND claim_deadline<=clock_timestamp()+interval '6 hours'
 AND NOT EXISTS(SELECT FROM splash.claim_outcomes o WHERE o.submission_id=l.submission_id) LOOP
 PERFORM notifications.enqueue('splash:deadline:'||r.submission_id,'deadline','splash',r.winner_subject_id,r.claim_deadline);
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA splash TO notifications_service;
GRANT EXECUTE ON FUNCTION splash.notification_reminders() TO notifications_service;

RESET ROLE;
