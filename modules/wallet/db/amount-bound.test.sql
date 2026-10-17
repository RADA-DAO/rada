BEGIN;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(629101) AS subject \gset
RESET ROLE;
SET LOCAL ROLE wallet_service;
SELECT set_config('rada.subject_id', :'subject', true);
INSERT INTO wallet.payment_intents(intent_id, subject_id, app_id, idempotency_key,
  token, amount, recipient, sender, purpose, platform, sign_before)
VALUES (gen_random_uuid(), :'subject', 'splash', 'fixture_maximum', 'JPEGPE',
  1329227995784915872903807060280344575, '0:' || repeat('1', 64),
  '0:' || repeat('2', 64), 'splash:fixture', true, now() + interval '1 hour');
DO $$ BEGIN
  INSERT INTO wallet.payment_intents(intent_id, subject_id, app_id, idempotency_key,
    token, amount, recipient, sender, purpose, platform, sign_before)
  VALUES (gen_random_uuid(), identity.current_subject(), 'splash', 'fixture_excess', 'JPEGPE',
    1329227995784915872903807060280344576, '0:' || repeat('1', 64),
    '0:' || repeat('2', 64), 'splash:fixture', true, now() + interval '1 hour');
  RAISE EXCEPTION 'Payment exceeded encoding maximum';
EXCEPTION WHEN check_violation THEN NULL; END $$;
RESET ROLE;
ROLLBACK;
