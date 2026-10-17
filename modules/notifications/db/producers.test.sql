BEGIN;
SELECT identity.resolve_telegram(90503) AS subject \gset
SELECT set_config('rada.subject_id',:'subject',true);
SELECT notifications.set_preference('splash',true,'en',NULL,NULL);
SELECT notifications.set_preference('governance',true,'en',NULL,NULL);
SELECT gen_random_uuid() AS frog, gen_random_uuid() AS proposal \gset
INSERT INTO splash.submissions(submission_id,author_subject_id) VALUES(:'frog',gen_random_uuid());
INSERT INTO splash.rounds(starts_at,ends_at) VALUES(now()-interval '2 days',now()-interval '1 day') RETURNING round_id \gset
INSERT INTO splash.lots VALUES(:round_id,:'frog');
INSERT INTO splash.bids(round_id,submission_id,bidder_subject_id,amount,username,placed_at,amount_since,name_chosen_at)
 VALUES(:round_id,:'frog',:'subject',1,'NotificationFixture',now(),now(),now()) RETURNING bid_id \gset
INSERT INTO splash.round_closures(round_id) VALUES(:round_id);
INSERT INTO splash.lot_results(round_id,submission_id,bidder_count,winning_bid_id,winner_subject_id,amount,requested_username,name_outcome,claim_deadline)
 VALUES(:round_id,:'frog',1,:bid_id,:'subject',1,'NotificationFixture','conflict',now()+interval '5 hours');
SELECT splash.notification_reminders();
SELECT splash.notification_reminders();
DO $$ BEGIN
 IF (SELECT count(*) FROM notifications.events WHERE subject_id=identity.current_subject() AND kind IN ('won','deadline'))<>2 THEN RAISE EXCEPTION 'win and deduped reminder'; END IF;
END $$;
INSERT INTO splash.claim_outcomes(submission_id,outcome) VALUES(:'frog','burned');
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM notifications.events WHERE subject_id=identity.current_subject() AND kind='burned')
 OR EXISTS(SELECT FROM notifications.events WHERE subject_id=identity.current_subject() AND kind IN ('won','deadline') AND status='pending') THEN RAISE EXCEPTION 'burn cancels obsolete notices'; END IF;
END $$;
INSERT INTO governance.proposals(proposal_id,author,title,body) VALUES(:'proposal',:'subject','Private fixture title','Not in the message');
INSERT INTO governance.openings(proposal_id,actor,closes_at,settings_version,members,checked_at)
 VALUES(:'proposal',:'subject',now()+interval '11 hours',(SELECT max(version) FROM governance.settings),'{}',now());
SELECT governance.notification_reminders();
SELECT governance.notification_reminders();
DO $$ BEGIN
 IF (SELECT count(*) FROM notifications.events WHERE subject_id=identity.current_subject() AND kind IN ('opened','closing'))<>2 THEN RAISE EXCEPTION 'opened and closing notices'; END IF;
END $$;
INSERT INTO governance.closures(proposal_id,tally,excluded_receipts,membership_checked_at) VALUES(:'proposal','{}','{}',now());
INSERT INTO governance.decisions(proposal_id,actor,outcome,reason) VALUES(:'proposal',:'subject','defer','Fixture reason');
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM notifications.events WHERE subject_id=identity.current_subject() AND kind='decision')
 OR EXISTS(SELECT FROM notifications.events WHERE subject_id=identity.current_subject() AND kind IN ('opened','closing') AND status='pending') THEN RAISE EXCEPTION 'decision and obsolete cancellation'; END IF;
END $$;
ROLLBACK;
