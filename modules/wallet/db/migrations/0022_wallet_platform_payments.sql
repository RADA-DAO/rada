SET LOCAL ROLE wallet_owner;
-- Platform intents: terms fixed server-side by a platform module (no app release
-- grant), with a signing deadline. paid_on_chain_at is the recipient transaction
-- time of the finalized receipt.
ALTER TABLE wallet.payment_intents
  ADD COLUMN platform boolean NOT NULL DEFAULT false,
  ADD COLUMN sign_before timestamptz,
  ADD COLUMN paid_on_chain_at timestamptz,
  ADD CONSTRAINT payment_intents_sign_before_platform CHECK (sign_before IS NULL OR platform),
  ADD CONSTRAINT payment_intents_paid_time CHECK (paid_on_chain_at IS NULL OR status = 'paid');

-- Published to platform modules: one platform intent of the given app, any subject.
CREATE FUNCTION wallet.platform_payment(target_app_id text, target_intent_id uuid)
RETURNS TABLE(
  intent_id uuid, subject_id uuid, token text, amount numeric, recipient text,
  sender text, purpose text, status text, paid_on_chain_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.intent_id, p.subject_id, p.token, p.amount, p.recipient, p.sender,
    p.purpose, p.status, p.paid_on_chain_at
  FROM wallet.payment_intents AS p
  WHERE p.intent_id = target_intent_id AND p.app_id = target_app_id AND p.platform
$$;
REVOKE ALL ON FUNCTION wallet.platform_payment(text, uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA wallet TO splash_owner;
GRANT EXECUTE ON FUNCTION wallet.platform_payment(text, uuid) TO splash_owner;
RESET ROLE;
