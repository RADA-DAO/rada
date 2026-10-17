-- Synthetic fixtures only. Run by test:db in a fresh disposable database.
BEGIN;
SET LOCAL ROLE identity_owner;
INSERT INTO identity.subjects(subject_id) VALUES
 ('40000000-0000-4000-8000-000000000001'),
 ('40000000-0000-4000-8000-000000000002');
INSERT INTO identity.role_grants(subject_id,role_name)
 VALUES('40000000-0000-4000-8000-000000000002','governance.steward');
RESET ROLE;
SET LOCAL ROLE governance_service;
SELECT set_config('rada.subject_id','40000000-0000-4000-8000-000000000001',true);
DO $$ BEGIN
 IF governance.viewer()->>'steward' <> 'false' THEN
   RAISE EXCEPTION 'member received steward controls'; END IF;
 BEGIN
   PERFORM governance.create_proposal('Title','Body',false,clock_timestamp());
   RAISE EXCEPTION 'nonmember created proposal';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
   PERFORM governance.change_settings(governance.current_settings()->'rules','Unauthorized');
   RAISE EXCEPTION 'nonsteward changed settings';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT governance.create_proposal('Member proposal','Plain text',true,clock_timestamp());
RESET ROLE;
SET LOCAL ROLE governance_owner;
INSERT INTO governance.proposals(proposal_id,author,title,body) VALUES
 ('41000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','Voting','Test'),
 ('41000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001','Due','Test'),
 ('41000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000001','Open membership','Test'),
 ('41000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000001','No changes','Test'),
 ('41000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000001','Exclude departed','Test');
RESET ROLE;
SET LOCAL ROLE governance_service;
DO $$ BEGIN
 BEGIN
   PERFORM governance.open_proposal('41000000-0000-4000-8000-000000000001','{}',clock_timestamp(),
     (governance.current_settings()->>'version')::bigint);
   RAISE EXCEPTION 'author opened under steward-only defaults';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT set_config('rada.subject_id','40000000-0000-4000-8000-000000000002',true);
DO $$ BEGIN
 IF governance.viewer()->>'steward' <> 'true' THEN
   RAISE EXCEPTION 'steward role projection missing'; END IF;
END $$;
SELECT governance.open_proposal('41000000-0000-4000-8000-000000000001','{}',clock_timestamp(),
 (governance.current_settings()->>'version')::bigint);
SELECT set_config('rada.subject_id','40000000-0000-4000-8000-000000000001',true);
SELECT governance.cast_vote('41000000-0000-4000-8000-000000000001','for',true,clock_timestamp());
SELECT governance.cast_vote('41000000-0000-4000-8000-000000000001','against',true,clock_timestamp());
DO $$ DECLARE p jsonb; BEGIN
 p := governance.read_proposal('41000000-0000-4000-8000-000000000001');
 IF p->'tally' <> '{"for":0,"against":1,"abstain":0}'::jsonb THEN RAISE EXCEPTION 'one-current-vote violated'; END IF;
 IF p->'author' <> 'null'::jsonb THEN RAISE EXCEPTION 'private author exposed'; END IF;
 IF p->'rules'->>'duration_hours' <> '48' THEN RAISE EXCEPTION 'wrong duration'; END IF;
 BEGIN
   PERFORM governance.cast_vote('41000000-0000-4000-8000-000000000001','abstain',false,clock_timestamp());
   RAISE EXCEPTION 'nonmember voted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT governance.cast_vote('41000000-0000-4000-8000-000000000001',NULL,true,clock_timestamp());
DO $$ DECLARE v jsonb; BEGIN
 IF governance.read_proposal('41000000-0000-4000-8000-000000000001')->'tally' <>
   '{"for":0,"against":0,"abstain":0}'::jsonb THEN RAISE EXCEPTION 'withdrawal counted'; END IF;
 v := governance.public_votes('41000000-0000-4000-8000-000000000001');
 IF jsonb_array_length(v) <> 3 THEN RAISE EXCEPTION 'history lost'; END IF;
 IF v->0->'voter' <> 'null'::jsonb OR v->0->>'receipt' IS NULL
   OR v::text ~ 'subject_id|telegram' THEN RAISE EXCEPTION 'private voter exposed'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE governance_owner;
-- Synthetic expired opening and votes; no wall-clock sleeps or mutable production rows.
INSERT INTO governance.openings
 SELECT '41000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002',
 clock_timestamp()-interval '10 days',clock_timestamp()-interval '8 days',version,'{}',clock_timestamp()
 FROM governance.settings ORDER BY version DESC LIMIT 1;
INSERT INTO governance.votes(proposal_id,subject_id,choice,membership_checked_at)
 VALUES('41000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000001','for',clock_timestamp());
RESET ROLE;
SET LOCAL ROLE governance_service;
DO $$ BEGIN
 IF NOT governance.close_proposal('41000000-0000-4000-8000-000000000002',NULL,NULL) THEN RAISE EXCEPTION 'did not close'; END IF;
 IF governance.close_proposal('41000000-0000-4000-8000-000000000002',NULL,NULL) THEN RAISE EXCEPTION 'closed twice'; END IF;
 IF governance.read_proposal('41000000-0000-4000-8000-000000000002')->'tally'->>'for' <> '1' THEN RAISE EXCEPTION 'departed vote lost'; END IF;
 IF governance.read_proposal('41000000-0000-4000-8000-000000000002')->>'decision_status' <> 'awaiting_decision' THEN RAISE EXCEPTION 'premature deadline'; END IF;
 BEGIN
   PERFORM governance.cast_vote('41000000-0000-4000-8000-000000000002','against',true,clock_timestamp());
   RAISE EXCEPTION 'late vote allowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
   PERFORM governance.decide('41000000-0000-4000-8000-000000000002','accept','Public reason');
   RAISE EXCEPTION 'nonsteward decided';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT set_config('rada.subject_id','40000000-0000-4000-8000-000000000002',true);
DO $$ BEGIN
 BEGIN
   PERFORM governance.decide('41000000-0000-4000-8000-000000000002','reject','');
   RAISE EXCEPTION 'empty reason accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
   PERFORM governance.attach_evidence('41000000-0000-4000-8000-000000000002','Proof',NULL,NULL);
   RAISE EXCEPTION 'evidence before acceptance';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
SELECT governance.decide('41000000-0000-4000-8000-000000000002','accept','Public reason');
SELECT governance.attach_evidence('41000000-0000-4000-8000-000000000002','Execution recorded',NULL,'https://example.test/proof');
SELECT governance.change_settings(
 jsonb_set(governance.current_settings()->'rules','{require_membership_at_open}','true'),'Opening membership required');
SELECT governance.open_proposal('41000000-0000-4000-8000-000000000003','{}',clock_timestamp(),
 (governance.current_settings()->>'version')::bigint);
SELECT set_config('rada.subject_id','40000000-0000-4000-8000-000000000001',true);
DO $$ BEGIN
 BEGIN
   PERFORM governance.cast_vote('41000000-0000-4000-8000-000000000003','for',true,clock_timestamp());
   RAISE EXCEPTION 'missing opening membership allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT set_config('rada.subject_id','40000000-0000-4000-8000-000000000002',true);
SELECT governance.change_settings(
 jsonb_set(jsonb_set(governance.current_settings()->'rules','{require_membership_at_open}','false'),
 '{allow_vote_changes}','false'),'Disable vote changes');
SELECT governance.open_proposal('41000000-0000-4000-8000-000000000004','{}',clock_timestamp(),
 (governance.current_settings()->>'version')::bigint);
SELECT set_config('rada.subject_id','40000000-0000-4000-8000-000000000001',true);
SELECT governance.cast_vote('41000000-0000-4000-8000-000000000004','abstain',true,clock_timestamp());
DO $$ BEGIN
 BEGIN
   PERFORM governance.cast_vote('41000000-0000-4000-8000-000000000004',NULL,true,clock_timestamp());
   RAISE EXCEPTION 'disabled withdrawal allowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
SELECT set_config('rada.subject_id','40000000-0000-4000-8000-000000000002',true);
SELECT governance.change_settings(
 jsonb_set(governance.current_settings()->'rules','{keep_departed_votes}','false'),'Exclude departed votes');
DO $$ BEGIN
 IF governance.read_proposal('41000000-0000-4000-8000-000000000001')->'rules'->>'keep_departed_votes' <> 'true'
 THEN RAISE EXCEPTION 'opening settings mutated'; END IF;
END $$;
RESET ROLE;
SET LOCAL ROLE governance_owner;
INSERT INTO governance.openings
 SELECT '41000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000002',
 clock_timestamp()-interval '3 days',clock_timestamp()-interval '1 day',version,'{}',clock_timestamp()
 FROM governance.settings ORDER BY version DESC LIMIT 1;
INSERT INTO governance.votes(proposal_id,subject_id,choice,membership_checked_at)
 VALUES('41000000-0000-4000-8000-000000000005','40000000-0000-4000-8000-000000000001','for',clock_timestamp());
RESET ROLE;
SET LOCAL ROLE governance_service;
SELECT governance.close_proposal('41000000-0000-4000-8000-000000000005','{}',clock_timestamp());
DO $$ DECLARE v jsonb; BEGIN
 IF governance.read_proposal('41000000-0000-4000-8000-000000000005')->'tally'->>'for' <> '0' THEN RAISE EXCEPTION 'departure not excluded'; END IF;
 v := governance.public_votes('41000000-0000-4000-8000-000000000005');
 IF v->0->>'excluded' <> 'true' OR v->0->>'exclusion_reason' <> 'membership_lost_at_close' THEN RAISE EXCEPTION 'exclusion history missing'; END IF;
END $$;
-- A separate, backdated closure verifies pending never becomes a decision.
RESET ROLE;
SET LOCAL ROLE governance_owner;
INSERT INTO governance.proposals(proposal_id,author,title,body) VALUES
 ('41000000-0000-4000-8000-000000000006','40000000-0000-4000-8000-000000000001','Pending','Test');
INSERT INTO governance.openings
 SELECT '41000000-0000-4000-8000-000000000006','40000000-0000-4000-8000-000000000002',
 clock_timestamp()-interval '12 days',clock_timestamp()-interval '10 days',version,'{}',clock_timestamp()
 FROM governance.settings ORDER BY version DESC LIMIT 1;
INSERT INTO governance.closures VALUES('41000000-0000-4000-8000-000000000006',
 clock_timestamp()-interval '8 days','{"for":0,"against":0,"abstain":0}','{}',clock_timestamp());
RESET ROLE;
SET LOCAL ROLE governance_service;
DO $$ DECLARE p jsonb; BEGIN
 p := governance.read_proposal('41000000-0000-4000-8000-000000000006');
 IF p->>'decision_status' <> 'decision_pending' OR p->'decision' <> 'null'::jsonb
   OR p->>'execution_status' <> 'no_evidence' THEN RAISE EXCEPTION 'pending auto-decided'; END IF;
END $$;
SELECT governance.change_settings(jsonb_set(jsonb_set(governance.current_settings()->'rules',
 '{allow_majority_override}','false'),'{who_opens}','"author-opens"'),'Author opening, no majority override');
RESET ROLE;
SET LOCAL ROLE governance_owner;
INSERT INTO governance.proposals(proposal_id,author,title,body) VALUES
 ('41000000-0000-4000-8000-000000000007','40000000-0000-4000-8000-000000000001','No override','Test'),
 ('41000000-0000-4000-8000-000000000008','40000000-0000-4000-8000-000000000001','Author opens','Test');
INSERT INTO governance.openings
 SELECT '41000000-0000-4000-8000-000000000007','40000000-0000-4000-8000-000000000002',
 clock_timestamp()-interval '12 days',clock_timestamp()-interval '10 days',version,'{}',clock_timestamp()
 FROM governance.settings ORDER BY version DESC LIMIT 1;
INSERT INTO governance.closures VALUES('41000000-0000-4000-8000-000000000007',
 clock_timestamp(),' {"for":2,"against":1,"abstain":4}','{}',clock_timestamp());
RESET ROLE;
SET LOCAL ROLE governance_service;
DO $$ BEGIN
 BEGIN
   PERFORM governance.decide('41000000-0000-4000-8000-000000000007','reject','Disagree');
   RAISE EXCEPTION 'majority override accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
SELECT governance.decide('41000000-0000-4000-8000-000000000007','defer','More evidence needed');
SELECT set_config('rada.subject_id','40000000-0000-4000-8000-000000000001',true);
SELECT governance.open_proposal('41000000-0000-4000-8000-000000000008','{}',clock_timestamp(),
 (governance.current_settings()->>'version')::bigint);
RESET ROLE;
SET LOCAL ROLE governance_owner;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['settings','proposals','openings','withdrawals','votes','closures','decisions','evidence'] LOOP
   IF has_table_privilege('governance_service','governance.'||t,'SELECT,INSERT,UPDATE,DELETE') THEN
     RAISE EXCEPTION 'runtime table privilege'; END IF;
 END LOOP;
 BEGIN UPDATE governance.votes SET choice='against'; RAISE EXCEPTION 'votes mutable'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN DELETE FROM governance.votes; RAISE EXCEPTION 'history deletable'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE governance.openings SET closes_at=clock_timestamp(); RAISE EXCEPTION 'duration mutable'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN UPDATE governance.settings SET reason='changed'; RAISE EXCEPTION 'settings mutable'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN DELETE FROM governance.closures; RAISE EXCEPTION 'closure mutable'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN DELETE FROM governance.decisions; RAISE EXCEPTION 'decision mutable'; EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN DELETE FROM governance.evidence; RAISE EXCEPTION 'evidence mutable'; EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
