SET LOCAL ROLE notifications_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE notifications.preferences (
 subject_id uuid NOT NULL, category text NOT NULL CHECK(category IN ('splash','governance')),
 enabled boolean NOT NULL DEFAULT false, consent_at timestamptz, revoked_at timestamptz,
 locale text NOT NULL DEFAULT 'en' CHECK(locale IN ('en','uk')),
 quiet_start integer CHECK(quiet_start BETWEEN 0 AND 23),
 quiet_end integer CHECK(quiet_end BETWEEN 0 AND 23),
 PRIMARY KEY(subject_id,category),
 CHECK (NOT enabled OR consent_at IS NOT NULL),
 CHECK ((quiet_start IS NULL AND quiet_end IS NULL) OR
   (quiet_start IS NOT NULL AND quiet_end IS NOT NULL AND quiet_start<>quiet_end))
);
CREATE TABLE notifications.consent_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, subject_id uuid NOT NULL,
 category text NOT NULL, enabled boolean NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE notifications.events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_key text NOT NULL UNIQUE CHECK(length(event_key) BETWEEN 1 AND 200),
 kind text NOT NULL CHECK(kind IN ('won','deadline','claimed','burned','opened','closing','decision','test')),
 category text NOT NULL CHECK(category IN ('splash','governance')),
 subject_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 day',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','dead','uncertain','cancelled')),
 next_at timestamptz NOT NULL DEFAULT clock_timestamp(), attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX pending_events ON notifications.events(next_at,id) WHERE status='pending';
CREATE TABLE notifications.attempts (
 event_id bigint NOT NULL REFERENCES notifications.events, attempt integer NOT NULL,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
 outcome text CHECK(outcome IN ('sent','retry','dead','uncertain')), PRIMARY KEY(event_id,attempt)
);
CREATE INDEX subject_events ON notifications.events(subject_id,category);
CREATE FUNCTION notifications.preferences() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT jsonb_agg(jsonb_build_object('category',c,'enabled',coalesce(p.enabled,false),
 'consent_at',p.consent_at,'locale',coalesce(p.locale,'en'),
 'quiet_start',p.quiet_start,'quiet_end',p.quiet_end) ORDER BY c)
 FROM (VALUES ('splash'),('governance')) categories(c)
 LEFT JOIN notifications.preferences p ON (p.category=c) AND p.subject_id=identity.current_subject()
$$;
CREATE FUNCTION notifications.set_preference(c text, on_off boolean, lang text, qs integer, qe integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s uuid:=identity.current_subject(); old_enabled boolean;
BEGIN
 IF s IS NULL OR on_off IS NULL THEN RAISE EXCEPTION 'invalid_subject' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(s::text,50));
 SELECT enabled INTO old_enabled FROM notifications.preferences WHERE subject_id=s AND category=c;
 INSERT INTO notifications.preferences(subject_id,category,enabled,consent_at,revoked_at,locale,quiet_start,quiet_end)
 VALUES(s,c,on_off,CASE WHEN on_off THEN clock_timestamp() END,
 CASE WHEN NOT on_off THEN clock_timestamp() END,lang,qs,qe)
 ON CONFLICT(subject_id,category) DO UPDATE SET enabled=on_off,
 consent_at=CASE WHEN on_off AND NOT notifications.preferences.enabled THEN clock_timestamp()
 ELSE notifications.preferences.consent_at END,
 revoked_at=CASE WHEN NOT on_off THEN clock_timestamp() END,locale=lang,quiet_start=qs,quiet_end=qe;
 IF old_enabled IS DISTINCT FROM on_off THEN
 INSERT INTO notifications.consent_history(subject_id,category,enabled) VALUES(s,c,on_off);
 END IF;
 IF NOT on_off THEN UPDATE notifications.events SET status='cancelled'
 WHERE subject_id=s AND category=c AND status='pending'; END IF;
END $$;
-- Public producer interface; no payload or recipient identity is returned.
CREATE FUNCTION notifications.enqueue(k text, kind text, category text, recipient uuid, expires timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM notifications.preferences p WHERE p.subject_id=recipient
 AND p.category=enqueue.category AND p.enabled) THEN RETURN; END IF;
 INSERT INTO notifications.events(event_key,kind,category,subject_id,expires_at)
 VALUES(k,kind,category,recipient,expires) ON CONFLICT(event_key) DO NOTHING;
END $$;
CREATE FUNCTION notifications.broadcast(k text, kind text, expires timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s uuid;
BEGIN
 FOR s IN SELECT subject_id FROM notifications.preferences WHERE category='governance' AND enabled LOOP
 PERFORM notifications.enqueue(k||':'||s,kind,'governance',s,expires);
 END LOOP;
END $$;
CREATE FUNCTION notifications.test_message(c text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s uuid:=identity.current_subject();
BEGIN
 IF s IS NULL THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(s::text,50));
 IF NOT EXISTS(SELECT FROM notifications.preferences WHERE subject_id=s AND category=c AND enabled)
 OR EXISTS(SELECT FROM notifications.events WHERE subject_id=s AND kind='test'
 AND created_at>clock_timestamp()-interval '1 minute') THEN RETURN false; END IF;
 PERFORM notifications.enqueue('test:'||gen_random_uuid(),'test',c,s,clock_timestamp()+interval '1 hour');
 RETURN true;
END $$;
GRANT USAGE ON SCHEMA notifications TO notifications_service,splash_owner,governance_owner;
GRANT EXECUTE ON FUNCTION notifications.preferences(),notifications.set_preference(text,boolean,text,integer,integer),notifications.test_message(text) TO notifications_service;
GRANT EXECUTE ON FUNCTION notifications.enqueue(text,text,text,uuid,timestamptz) TO splash_owner;
GRANT EXECUTE ON FUNCTION notifications.broadcast(text,text,timestamptz) TO governance_owner;

SET LOCAL ROLE notifications_owner;
CREATE FUNCTION notifications.quiet(qs integer, qe integer, at_time timestamptz)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
 SELECT coalesce(CASE WHEN qs<qe THEN extract(hour FROM at_time AT TIME ZONE 'UTC')>=qs
 AND extract(hour FROM at_time AT TIME ZONE 'UTC')<qe
 ELSE extract(hour FROM at_time AT TIME ZONE 'UTC')>=qs OR extract(hour FROM at_time AT TIME ZONE 'UTC')<qe END,false)
$$;
-- Called only while the worker holds the global session lock (726232450).
CREATE FUNCTION notifications.recover() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
 UPDATE notifications.events SET status='uncertain' WHERE status='sending';
 UPDATE notifications.attempts SET outcome='uncertain',finished_at=clock_timestamp() WHERE outcome IS NULL;
$$;
CREATE FUNCTION notifications.reserve(allowed text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e notifications.events; p notifications.preferences;
BEGIN
 UPDATE notifications.events SET status='cancelled' WHERE status='pending' AND expires_at<=clock_timestamp();
 FOR e IN SELECT * FROM notifications.events WHERE status='pending'
 AND next_at<=clock_timestamp()
 AND (allowed IS NULL OR identity.notification_destination(subject_id)=ANY(allowed))
 AND EXISTS(SELECT FROM notifications.preferences pref WHERE pref.subject_id=events.subject_id
   AND pref.category=events.category AND NOT notifications.quiet(pref.quiet_start,pref.quiet_end,clock_timestamp()))
 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1000 LOOP
 SELECT * INTO p FROM notifications.preferences WHERE subject_id=e.subject_id AND category=e.category;
 IF p.enabled IS DISTINCT FROM true OR p.consent_at>e.created_at THEN
 UPDATE notifications.events SET status='cancelled' WHERE id=e.id; CONTINUE; END IF;
 IF notifications.quiet(p.quiet_start,p.quiet_end,clock_timestamp()) THEN CONTINUE; END IF;
 IF allowed IS NOT NULL AND NOT (identity.notification_destination(e.subject_id)=ANY(allowed)) THEN CONTINUE; END IF;
 -- Each network attempt consumes quota, including retries and tests.
 IF (SELECT count(*) FROM notifications.attempts a JOIN notifications.events n ON (n.id=a.event_id)
 WHERE n.subject_id=e.subject_id AND a.started_at>clock_timestamp()-interval '1 hour')>=5
 OR (SELECT count(*) FROM notifications.attempts a JOIN notifications.events n ON (n.id=a.event_id)
 WHERE n.subject_id=e.subject_id AND a.started_at>clock_timestamp()-interval '1 day')>=20 THEN
 UPDATE notifications.events SET next_at=clock_timestamp()+interval '1 hour' WHERE id=e.id;
 CONTINUE; END IF;
 UPDATE notifications.events SET status='sending',attempts=attempts+1 WHERE id=e.id;
 INSERT INTO notifications.attempts(event_id,attempt) VALUES(e.id,e.attempts+1);
 RETURN jsonb_build_object('id',e.id::text,'kind',e.kind,'locale',p.locale);
 END LOOP;
 RETURN NULL;
END $$;
-- Hold this preference row lock until the bounded send completes. Revocation
-- serializes with an already-started send; all later sends observe revocation.
CREATE FUNCTION notifications.authorize(event bigint) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e notifications.events; p notifications.preferences;
BEGIN
 SELECT * INTO e FROM notifications.events WHERE id=event AND status='sending';
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO p FROM notifications.preferences WHERE subject_id=e.subject_id AND category=e.category FOR UPDATE;
 IF p.enabled IS DISTINCT FROM true OR p.consent_at>e.created_at OR e.expires_at<=clock_timestamp()
 OR notifications.quiet(p.quiet_start,p.quiet_end,clock_timestamp()) THEN RETURN NULL; END IF;
 RETURN identity.notification_destination(e.subject_id);
END $$;
CREATE FUNCTION notifications.finish(event bigint, result text, retry_seconds integer DEFAULT 0)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e notifications.events;
BEGIN
 IF result NOT IN ('sent','retry','dead','uncertain') OR retry_seconds<0 THEN
 RAISE EXCEPTION 'invalid_result' USING ERRCODE='22023'; END IF;
 SELECT * INTO e FROM notifications.events WHERE id=event AND status='sending' FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE notifications.attempts SET outcome=result,finished_at=clock_timestamp()
 WHERE event_id=e.id AND attempt=e.attempts;
 UPDATE notifications.events SET status=CASE WHEN result='retry' AND attempts<5 THEN 'pending'
 WHEN result='retry' THEN 'dead' ELSE result END,
 next_at=clock_timestamp()+make_interval(secs=>greatest(retry_seconds,60*power(2,attempts-1)::integer)) WHERE id=e.id;
END $$;
GRANT EXECUTE ON FUNCTION notifications.recover(),notifications.reserve(text[]),notifications.authorize(bigint),notifications.finish(bigint,text,integer) TO notifications_service;

CREATE FUNCTION notifications.cancel(k text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
 UPDATE notifications.events SET status='cancelled' WHERE status='pending'
 AND (event_key=k OR left(event_key,length(k)+1)=k||':')
$$;
GRANT EXECUTE ON FUNCTION notifications.cancel(text) TO splash_owner,governance_owner;
RESET ROLE;
