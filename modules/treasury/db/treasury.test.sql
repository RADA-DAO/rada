BEGIN;
CREATE FUNCTION pg_temp.assert_true(value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Treasury assertion failed'; END IF; END $$;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(955001) AS steward \gset
SELECT identity.resolve_telegram(955002) AS person \gset
RESET ROLE;
SET LOCAL ROLE identity_owner;
INSERT INTO identity.role_grants(subject_id,role_name) VALUES(:'steward','treasury.steward');
RESET ROLE;
SET LOCAL ROLE jpegpe_operator;
SELECT jpegpe.create_frog('55000000-0000-4000-8000-000000000001','TreasuryFrog',:'person');
RESET ROLE;
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id',:'person',true);
SELECT identity.select_frog('55000000-0000-4000-8000-000000000001');
RESET ROLE;
SET LOCAL ROLE wallet_service;
SELECT identity.wallet_link('0:'||repeat('2',64),'fixture');
RESET ROLE;
SET LOCAL ROLE treasury_service;
DO $$ BEGIN
 BEGIN PERFORM treasury.configure('0:'||repeat('1',64),true,'Unauthorized'); RAISE EXCEPTION 'nonsteward configured';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM * FROM treasury.movements; RAISE EXCEPTION 'private table readable';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM identity.treasury_person('0:'||repeat('2',64)); RAISE EXCEPTION 'arbitrary person lookup';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT set_config('rada.subject_id',:'steward',true);
SELECT treasury.configure('0:'||repeat('1',64),true,'DAO wallet');
SELECT version AS version FROM treasury.wallets() \gset
SELECT jsonb_build_object('balances','{"TON":"100","JPEGPE":"200"}'::jsonb,'balanceAt',now()-interval '11 minutes',
 'signers',jsonb_build_array('0:'||repeat('2',64),'0:'||repeat('3',64)),
 'movements',jsonb_build_array(jsonb_build_object('key','fixture','hash',repeat('a',64),'at',now(),
 'direction','in','token','TON','amount','100','counterparty','0:'||repeat('2',64))),
 'indexedThrough',now(),'incomplete',false) AS sample \gset
SELECT treasury.record('0:'||repeat('1',64),:'version',:'sample');
SELECT treasury.record('0:'||repeat('1',64),:'version',:'sample');
SELECT pg_temp.assert_true(jsonb_array_length(treasury.transactions(NULL,NULL,NULL))=1);
SELECT pg_temp.assert_true(treasury.transactions(NULL,NULL,NULL)#>>'{0,person,name}'='TreasuryFrog');
SELECT pg_temp.assert_true(treasury.overview()#>>'{wallets,0,signers,0,name}'='TreasuryFrog');
SELECT pg_temp.assert_true(treasury.overview()#>'{wallets,0,signers,1}'='null'::jsonb);
SELECT pg_temp.assert_true((treasury.overview()#>>'{wallets,0,stale}')::boolean);
SELECT pg_temp.assert_true(NOT (treasury.overview()#>>'{wallets,0,historyStale}')::boolean);
SELECT pg_temp.assert_true(treasury.transactions(NULL,NULL,NULL)::text !~ repeat('2',64));
SELECT pg_temp.assert_true(treasury.overview()::text !~ repeat('2',64));
SELECT pg_temp.assert_true(jsonb_array_length(treasury.transactions(NULL,'out',NULL))=0);
SELECT pg_temp.assert_true(jsonb_array_length(treasury.transactions(NULL,NULL,'JPEGPE'))=0);
SELECT treasury.record('0:'||repeat('1',64),:'version',NULL);
SELECT pg_temp.assert_true((treasury.overview()#>>'{wallets,0,historyStale}')::boolean);
SELECT pg_temp.assert_true(treasury.overview()#>>'{wallets,0,balances,TON}'='100');
RESET ROLE;
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id',:'person',true);
SELECT identity.select_frog(NULL);
RESET ROLE;
SET LOCAL ROLE treasury_service;
SELECT pg_temp.assert_true(treasury.transactions(NULL,NULL,NULL)#>'{0,person}'='null'::jsonb);
SELECT pg_temp.assert_true(treasury.overview()#>'{wallets,0,signers,0}'='null'::jsonb);
RESET ROLE;
SET LOCAL ROLE governance_owner;
INSERT INTO governance.proposals(proposal_id,author,title,body) VALUES('56000000-0000-4000-8000-000000000001',:'steward','Treasury decision','Purpose');
INSERT INTO governance.openings(proposal_id,actor,opened_at,closes_at,settings_version,members,checked_at)
 SELECT '56000000-0000-4000-8000-000000000001',:'steward',now()-interval '3 days',now()-interval '1 day',version,'{}',now() FROM governance.settings ORDER BY version DESC LIMIT 1;
INSERT INTO governance.closures(proposal_id,tally,excluded_receipts,membership_checked_at) VALUES('56000000-0000-4000-8000-000000000001','{"for":1,"against":0,"abstain":0}','{}',now());
INSERT INTO governance.decisions(proposal_id,actor,outcome,reason) VALUES('56000000-0000-4000-8000-000000000001',:'steward','accept','Approved');
INSERT INTO governance.evidence(proposal_id,actor,body,tx_hash) VALUES('56000000-0000-4000-8000-000000000001',:'steward','Recorded execution',repeat('a',64));
RESET ROLE;
SET LOCAL ROLE treasury_service;
SELECT pg_temp.assert_true(treasury.transactions(NULL,NULL,NULL)#>>'{0,decisions,0,proposalId}'='56000000-0000-4000-8000-000000000001');
SELECT pg_temp.assert_true(treasury.transactions(NULL,NULL,NULL)::text !~ 'subject_id|telegram|actor');
SELECT set_config('rada.subject_id',:'steward',true);
SELECT treasury.configure('0:'||repeat('1',64),false,'Disabled');
SELECT treasury.record('0:'||repeat('1',64),:'version',:'sample');
SELECT pg_temp.assert_true(treasury.overview()->'wallets'='[]'::jsonb);
SELECT pg_temp.assert_true(jsonb_array_length(treasury.history(NULL))=2);
RESET ROLE;
SET LOCAL ROLE treasury_owner;
DO $$ BEGIN
 BEGIN UPDATE treasury.configuration SET reason='Changed'; RAISE EXCEPTION 'history changed';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
-- Stable cursor pages are disjoint even after new projection records arrive.
INSERT INTO treasury.movements(address,movement_key,tx_hash,occurred_at,direction,token,amount,counterparty)
 SELECT '0:'||repeat('1',64),'page-'||n,repeat('b',64),now(),'out','JPEGPE','1','0:'||repeat('3',64) FROM generate_series(1,110) n;
INSERT INTO treasury.movements(address,movement_key,tx_hash,occurred_at,direction,token,amount,counterparty)
 VALUES('0:'||repeat('1',64),'late-old',repeat('c',64),now()-interval '1 day','in','TON','1','0:'||repeat('3',64));
RESET ROLE;
SET LOCAL ROLE treasury_service;
SELECT treasury.configure('0:'||repeat('1',64),true,'Reenabled');
SELECT pg_temp.assert_true(treasury.transactions(NULL,NULL,NULL)->0->>'hash'<>repeat('c',64));
SELECT treasury.transactions(NULL,NULL,NULL)->50->>'id' AS next_row \gset
SELECT pg_temp.assert_true(jsonb_array_length(treasury.transactions(NULL,NULL,NULL))=51);
SELECT pg_temp.assert_true((treasury.transactions((:'next_row')::bigint+1,NULL,NULL)->0->>'id')=:'next_row');
ROLLBACK;
