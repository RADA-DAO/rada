BEGIN;
SELECT identity.resolve_telegram(90501) AS subject \gset
SELECT set_config('rada.subject_id', :'subject', true);
SET LOCAL ROLE notifications_service;
DO $$ BEGIN
 IF (notifications.preferences()->0->>'enabled')::boolean THEN RAISE EXCEPTION 'default on'; END IF;
 IF notifications.test_message('splash') THEN RAISE EXCEPTION 'test without consent'; END IF;
END $$;
SELECT notifications.set_preference('splash',true,'uk',NULL,NULL);
RESET ROLE;
SELECT notifications.enqueue('fixture:won','won','splash',:'subject',now()+interval '1 day');
SELECT notifications.enqueue('fixture:won','won','splash',:'subject',now()+interval '1 day');
DO $$ DECLARE e jsonb; BEGIN
 IF (SELECT count(*) FROM notifications.events WHERE event_key='fixture:won')<>1 THEN RAISE EXCEPTION 'dedupe'; END IF;
 IF notifications.reserve(ARRAY['999']) IS NOT NULL THEN RAISE EXCEPTION 'allowlist'; END IF;
 e:=notifications.reserve(ARRAY['90501']);
 IF e IS NULL OR e->>'locale'<>'uk' THEN RAISE EXCEPTION 'reserve'; END IF;
 IF notifications.reserve(NULL) IS NOT NULL THEN RAISE EXCEPTION 'double reserve'; END IF;
 IF notifications.authorize((e->>'id')::bigint)<>'90501' THEN RAISE EXCEPTION 'destination'; END IF;
 PERFORM notifications.finish((e->>'id')::bigint,'retry',120);
 IF notifications.reserve(NULL) IS NOT NULL THEN RAISE EXCEPTION 'backoff'; END IF;
 IF NOT EXISTS(SELECT FROM notifications.events WHERE event_key='fixture:won' AND next_at>now()+interval '119 seconds') THEN RAISE EXCEPTION 'retry after'; END IF;
END $$;
SELECT notifications.set_preference('splash',false,'uk',NULL,NULL);
DO $$ BEGIN
 IF EXISTS(SELECT FROM notifications.events WHERE event_key='fixture:won' AND status<>'cancelled') THEN RAISE EXCEPTION 'opt out'; END IF;
 IF (SELECT count(*) FROM notifications.consent_history WHERE subject_id=identity.current_subject())<>2 THEN RAISE EXCEPTION 'consent audit'; END IF;
 IF NOT notifications.quiet(22,8,'2026-01-01 23:00Z') OR NOT notifications.quiet(22,8,'2026-01-01 07:59Z')
 OR notifications.quiet(22,8,'2026-01-01 08:00Z') OR notifications.quiet(NULL,NULL,now())
 OR NOT notifications.quiet(9,17,'2026-01-01 12:00Z') THEN RAISE EXCEPTION 'quiet hours'; END IF;
END $$;
SELECT notifications.set_preference('splash',true,'en',extract(hour FROM now() AT TIME ZONE 'UTC')::int,(extract(hour FROM now() AT TIME ZONE 'UTC')::int+1)%24);
SELECT notifications.enqueue('fixture:quiet','won','splash',:'subject',now()+interval '1 day');
DO $$ BEGIN IF notifications.reserve(NULL) IS NOT NULL THEN RAISE EXCEPTION 'quiet delivery'; END IF; END $$;
SELECT notifications.set_preference('splash',true,'en',NULL,NULL);
DO $$ DECLARE e jsonb; BEGIN
 FOR i IN 1..4 LOOP
 PERFORM notifications.enqueue('fixture:rate:'||i,'won','splash',identity.current_subject(),now()+interval '1 day');
 e:=notifications.reserve(NULL);
 IF e IS NULL THEN RAISE EXCEPTION 'quota prematurely exhausted'; END IF;
 PERFORM notifications.finish((e->>'id')::bigint,'sent');
 END LOOP;
 IF notifications.reserve(NULL) IS NOT NULL THEN RAISE EXCEPTION 'rate limit'; END IF;
 IF NOT notifications.test_message('splash') OR notifications.test_message('splash') THEN RAISE EXCEPTION 'test rate limit'; END IF;
 IF has_table_privilege('notifications_service','notifications.events','SELECT')
 OR has_function_privilege('splash_service','notifications.enqueue(text,text,text,uuid,timestamptz)','EXECUTE') THEN RAISE EXCEPTION 'privilege leak'; END IF;
END $$;
ROLLBACK;
