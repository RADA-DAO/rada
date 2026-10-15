BEGIN;
CREATE FUNCTION pg_temp.wallet_assert(value boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'Wallet assertion failed'; END IF; END $$;
SET LOCAL ROLE identity_auth;
SELECT identity.resolve_telegram(510001) AS first_subject \gset
SELECT identity.resolve_telegram(510002) AS second_subject \gset
RESET ROLE;
SET LOCAL ROLE wallet_service;
SELECT set_config('rada.subject_id', :'first_subject', true);
INSERT INTO wallet.challenges(payload, subject_id, domain, expires_at)
  VALUES (repeat('a', 64), identity.current_subject(), 'app.test', now() + interval '10 minutes');
SELECT pg_temp.wallet_assert((SELECT count(*) = 1 FROM wallet.challenges));
SELECT identity.wallet_link('0:' || repeat('1', 64), 'UQfixture-one');
SELECT identity.wallet_link('0:' || repeat('2', 64), 'UQfixture-two');
SELECT pg_temp.wallet_assert((SELECT count(*) = 2 FROM identity.own_wallet()));
SELECT pg_temp.wallet_assert((SELECT count(*) = 2 FROM identity.own_wallet_history()));
SELECT pg_temp.wallet_assert(identity.wallet_revoke('0:' || repeat('1', 64)));
SELECT pg_temp.wallet_assert(NOT identity.wallet_revoke('0:' || repeat('1', 64)));
SELECT pg_temp.wallet_assert((SELECT count(*) = 1 FROM identity.own_wallet()));
SELECT pg_temp.wallet_assert((SELECT count(*) = 3 FROM identity.own_wallet_history()));
DO $$ BEGIN
  FOR i IN 3..17 LOOP
    PERFORM identity.wallet_link('0:' || lpad(to_hex(i), 64, '0'), 'UQfixture-' || i::text);
  END LOOP;
  BEGIN
    PERFORM identity.wallet_link('0:' || lpad(to_hex(18), 64, '0'), 'UQfixture-limit');
    RAISE EXCEPTION 'Wallet link limit was bypassed';
  EXCEPTION WHEN program_limit_exceeded THEN NULL; END;
END $$;
SELECT pg_temp.wallet_assert((SELECT count(*) = 16 FROM identity.own_wallet()));
SELECT pg_temp.wallet_assert(NOT identity.wallet_consent('fixture.app', 'wallet.balances.read'));
DO $$ BEGIN
  PERFORM * FROM identity.wallet_links;
  RAISE EXCEPTION 'Wallet service read identity base table';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
SELECT set_config('rada.subject_id', :'second_subject', true);
SELECT pg_temp.wallet_assert((SELECT count(*) = 0 FROM wallet.challenges));
SELECT pg_temp.wallet_assert((SELECT count(*) = 0 FROM identity.own_wallet()));
SELECT pg_temp.wallet_assert((SELECT count(*) = 0 FROM identity.own_wallet_history()));
RESET ROLE;
SET LOCAL ROLE identity_service;
SELECT set_config('rada.subject_id', :'first_subject', true);
INSERT INTO identity.consents(subject_id, app_id, capability)
  VALUES (identity.current_subject(), 'fixture.app', 'wallet.balances.read');
RESET ROLE;
SET LOCAL ROLE wallet_service;
SELECT pg_temp.wallet_assert(identity.wallet_consent('fixture.app', 'wallet.balances.read'));
RESET ROLE;
SET LOCAL ROLE identity_service;
UPDATE identity.consents SET revoked_at = now()
  WHERE subject_id = identity.current_subject() AND app_id = 'fixture.app';
RESET ROLE;
SET LOCAL ROLE wallet_service;
SELECT pg_temp.wallet_assert(NOT identity.wallet_consent('fixture.app', 'wallet.balances.read'));
RESET ROLE;
ROLLBACK;
