BEGIN;
CREATE FUNCTION pg_temp.payment_assert(value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Payment assertion failed'; END IF; END $$;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(101) AS first_subject \gset
SELECT identity.resolve_telegram(102) AS second_subject \gset
RESET ROLE;
SET LOCAL ROLE wallet_service;
SELECT set_config('rada.subject_id', :'first_subject', true);
INSERT INTO wallet.payment_intents(intent_id,subject_id,app_id,idempotency_key,token,amount,recipient,sender,purpose)
VALUES ('10000000-0000-4000-8000-000000000001',identity.current_subject(),'fixture.sql.payments','fixture_key','TON',9007199254740993,'0:'||repeat('9',64),'0:'||repeat('7',64),'Fixture payment');
-- Same scoped key is one intent; a different app has an independent key space.
INSERT INTO wallet.payment_intents(intent_id,subject_id,app_id,idempotency_key,token,amount,recipient,sender,purpose)
VALUES ('10000000-0000-4000-8000-000000000002',identity.current_subject(),'fixture.sql.payments','fixture_key','TON',1,'0:'||repeat('9',64),'0:'||repeat('7',64),'Fixture payment')
ON CONFLICT(subject_id,app_id,idempotency_key) DO NOTHING;
SELECT pg_temp.payment_assert((SELECT count(*)=1 FROM wallet.payment_intents WHERE app_id='fixture.sql.payments'));
SELECT pg_temp.payment_assert((SELECT amount=9007199254740993 FROM wallet.payment_intents WHERE intent_id='10000000-0000-4000-8000-000000000001'));
INSERT INTO wallet.payment_intents(intent_id,subject_id,app_id,idempotency_key,token,amount,recipient,sender,purpose)
VALUES ('10000000-0000-4000-8000-000000000003',identity.current_subject(),'fixture.sql.other','fixture_key','TON',1,'0:'||repeat('9',64),'0:'||repeat('7',64),'Fixture payment');
UPDATE wallet.payment_intents SET status='paid',receipt_hash=repeat('f',64) WHERE intent_id='10000000-0000-4000-8000-000000000001';
DO $$ BEGIN
  BEGIN
    UPDATE wallet.payment_intents SET status='paid',receipt_hash=repeat('f',64) WHERE intent_id='10000000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'Duplicate receipt accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END $$;
SELECT set_config('rada.subject_id', :'second_subject', true);
SELECT pg_temp.payment_assert((SELECT count(*)=0 FROM wallet.payment_intents WHERE app_id IN ('fixture.sql.payments','fixture.sql.other')));
WITH changed AS (UPDATE wallet.payment_intents SET status='cancelled' WHERE intent_id='10000000-0000-4000-8000-000000000001' RETURNING intent_id)
SELECT pg_temp.payment_assert((SELECT count(*)=0 FROM changed));
DO $$ BEGIN
  BEGIN
    INSERT INTO wallet.payment_intents(intent_id,subject_id,app_id,idempotency_key,token,amount,recipient,sender,purpose)
    SELECT '10000000-0000-4000-8000-000000000004',subject_id,'fixture.sql.payments','fixture_other','TON',1,'0:'||repeat('9',64),'0:'||repeat('7',64),'Fixture payment' FROM wallet.payment_intents;
    -- The SELECT is hidden by RLS, so it must insert nothing.
    IF FOUND THEN RAISE EXCEPTION 'Foreign intent exposed'; END IF;
  END;
  BEGIN
    DELETE FROM wallet.payment_intents;
    RAISE EXCEPTION 'Wallet service deleted payment history';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
-- WITH CHECK prevents writing a row for the other identity, even with a known UUID.
SELECT set_config('rada.fixture_foreign_subject', :'first_subject', true);
DO $$ BEGIN
  BEGIN
    INSERT INTO wallet.payment_intents(intent_id,subject_id,app_id,idempotency_key,token,amount,recipient,sender,purpose)
    VALUES ('10000000-0000-4000-8000-000000000005',current_setting('rada.fixture_foreign_subject')::uuid,'fixture.sql.payments','fixture_other','TON',1,'0:'||repeat('9',64),'0:'||repeat('7',64),'Fixture payment');
    RAISE EXCEPTION 'Foreign subject insert accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
SELECT set_config('rada.subject_id', :'first_subject', true);
SELECT pg_temp.payment_assert((SELECT status='paid' FROM wallet.payment_intents WHERE intent_id='10000000-0000-4000-8000-000000000001'));
SELECT pg_temp.payment_assert((SELECT status='prepared' AND receipt_hash IS NULL FROM wallet.payment_intents WHERE intent_id='10000000-0000-4000-8000-000000000003'));
SELECT set_config('rada.subject_id', '', true);
SELECT pg_temp.payment_assert((SELECT count(*)=0 FROM wallet.payment_intents));
RESET ROLE;
-- Platform intents: only they carry a signing deadline, a paid time needs a paid
-- status, and wallet.platform_payment publishes only platform rows of the named app.
DO $$ BEGIN
  INSERT INTO wallet.payment_intents(intent_id,subject_id,app_id,idempotency_key,token,amount,recipient,sender,purpose,sign_before)
  SELECT '10000000-0000-4000-8000-000000000007',subject_id,'fixture.sql.platform','fixture_app_deadline','JPEGPE',1,'0:'||repeat('9',64),'0:'||repeat('7',64),'splash:x',now()
  FROM identity.subjects LIMIT 1;
  RAISE EXCEPTION 'Deadline on an app intent';
EXCEPTION WHEN check_violation THEN NULL; END $$;
INSERT INTO wallet.payment_intents(intent_id,subject_id,app_id,idempotency_key,token,amount,recipient,sender,purpose,platform,sign_before)
VALUES ('10000000-0000-4000-8000-000000000006',:'second_subject','fixture.sql.platform','fixture_platform','JPEGPE',5,'0:'||repeat('9',64),'0:'||repeat('7',64),'splash:x',true,now()+interval '1 hour');
SELECT pg_temp.payment_assert((SELECT subject_id=:'second_subject' AND amount=5 AND status='prepared'
  FROM wallet.platform_payment('fixture.sql.platform','10000000-0000-4000-8000-000000000006')));
SELECT pg_temp.payment_assert((SELECT count(*)=0 FROM wallet.platform_payment('fixture.sql.other','10000000-0000-4000-8000-000000000006')));
SELECT pg_temp.payment_assert((SELECT count(*)=0 FROM wallet.platform_payment('fixture.sql.other','10000000-0000-4000-8000-000000000003')));
DO $$ BEGIN
  UPDATE wallet.payment_intents SET paid_on_chain_at=now() WHERE intent_id='10000000-0000-4000-8000-000000000006';
  RAISE EXCEPTION 'Paid time without payment';
EXCEPTION WHEN check_violation THEN NULL; END $$;
SET LOCAL ROLE wallet_service;
DO $$ BEGIN
  PERFORM * FROM wallet.platform_payment('fixture.sql.platform','10000000-0000-4000-8000-000000000006');
  RAISE EXCEPTION 'Wallet service read platform payments of any subject';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
RESET ROLE;
ROLLBACK;
