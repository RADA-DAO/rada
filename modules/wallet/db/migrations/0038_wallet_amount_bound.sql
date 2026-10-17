SET LOCAL ROLE wallet_owner;
-- Existing records remain readable; all new or updated intents fit the encoding.
ALTER TABLE wallet.payment_intents ADD CONSTRAINT payment_intents_amount_bound
  CHECK (amount <= 1329227995784915872903807060280344575) NOT VALID;
RESET ROLE;
