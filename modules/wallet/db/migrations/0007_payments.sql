SET LOCAL ROLE wallet_owner;
CREATE TABLE wallet.payment_intents (
  intent_id uuid PRIMARY KEY,
  subject_id uuid NOT NULL,
  app_id text NOT NULL CHECK (app_id ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  token text NOT NULL CHECK (token IN ('TON', 'JPEGPE')),
  amount numeric(78,0) NOT NULL CHECK (amount > 0),
  recipient text NOT NULL CHECK (recipient ~ '^0:[0-9a-f]{64}$'),
  sender text NOT NULL CHECK (sender ~ '^0:[0-9a-f]{64}$'),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  send_started_at timestamptz,
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','unknown','paid','cancelled')),
  receipt_hash text UNIQUE,
  UNIQUE(subject_id, app_id, idempotency_key)
);
CREATE INDEX payment_intents_subject ON wallet.payment_intents(subject_id, created_at DESC);
ALTER TABLE wallet.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet.payment_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_access ON wallet.payment_intents TO wallet_owner USING (true) WITH CHECK (true);
CREATE POLICY own_access ON wallet.payment_intents TO wallet_service
  USING (subject_id = nullif(current_setting('rada.subject_id', true), '')::uuid)
  WITH CHECK (subject_id = nullif(current_setting('rada.subject_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON wallet.payment_intents TO wallet_service;
RESET ROLE;
