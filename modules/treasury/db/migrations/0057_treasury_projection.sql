SET LOCAL ROLE treasury_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE treasury.configuration (
 version bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 address text NOT NULL CHECK(address ~ '^-?[0-9]+:[a-f0-9]{64}$'),
 enabled boolean NOT NULL,
 actor uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000 AND reason !~ '[[:cntrl:]]'),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION treasury.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
 BEGIN RAISE EXCEPTION 'immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON treasury.configuration FOR EACH ROW EXECUTE FUNCTION treasury.immutable();
CREATE TABLE treasury.samples (
 address text PRIMARY KEY,
 balances jsonb, balance_at timestamptz,
 signers text[], signers_at timestamptz,
 indexed_through timestamptz, history_at timestamptz,
 attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 incomplete boolean NOT NULL DEFAULT true
);
CREATE TABLE treasury.movements (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 address text NOT NULL,
 movement_key text NOT NULL,
 tx_hash text NOT NULL CHECK(tx_hash ~ '^[a-f0-9]{64}$'),
 occurred_at timestamptz NOT NULL,
 direction text NOT NULL CHECK(direction IN ('in','out')),
 token text NOT NULL CHECK(token IN ('TON','JPEGPE')),
 amount text NOT NULL CHECK(amount ~ '^[0-9]{1,80}$'),
 counterparty text NOT NULL,
 UNIQUE(address,movement_key)
);
CREATE FUNCTION treasury.configure(a text, enabled boolean, reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT identity.can_steward_treasury() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(724223,1);
 IF enabled AND NOT EXISTS(SELECT FROM treasury.configuration c WHERE c.address=a)
 AND (SELECT count(DISTINCT address) FROM treasury.configuration)>=16 THEN
 RAISE EXCEPTION 'wallet_limit' USING ERRCODE='23514'; END IF;
 INSERT INTO treasury.configuration(address,enabled,actor,reason) VALUES(a,enabled,identity.current_subject(),reason);
END $$;
CREATE FUNCTION treasury.wallets() RETURNS TABLE(address text, version bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT c.address,c.version FROM (SELECT DISTINCT ON(address) * FROM treasury.configuration ORDER BY address,version DESC) c WHERE enabled
$$;
CREATE FUNCTION treasury.record(a text, v bigint, sample jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE m jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(724223,1);
 IF NOT EXISTS(SELECT FROM treasury.wallets() w WHERE w.address=a AND w.version=v) THEN RETURN; END IF;
 INSERT INTO treasury.samples(address) VALUES(a) ON CONFLICT DO NOTHING;
 UPDATE treasury.samples SET attempted_at=clock_timestamp(), incomplete=true WHERE address=a;
 IF sample IS NULL THEN RETURN; END IF;
 IF sample->'balances' IS NOT NULL AND sample->>'balanceAt' IS NOT NULL THEN
 UPDATE treasury.samples SET balances=sample->'balances',balance_at=(sample->>'balanceAt')::timestamptz WHERE address=a;
 END IF;
 IF jsonb_typeof(sample->'signers')='array' THEN
 UPDATE treasury.samples SET signers=ARRAY(SELECT jsonb_array_elements_text(sample->'signers')),
 signers_at=clock_timestamp() WHERE address=a;
 END IF;
 IF jsonb_typeof(sample->'movements')='array' THEN
 FOR m IN SELECT jsonb_array_elements(sample->'movements') LOOP
 INSERT INTO treasury.movements(address,movement_key,tx_hash,occurred_at,direction,token,amount,counterparty)
 VALUES(a,m->>'key',m->>'hash',(m->>'at')::timestamptz,m->>'direction',m->>'token',m->>'amount',m->>'counterparty')
 ON CONFLICT(address,movement_key) DO NOTHING;
 END LOOP;
 UPDATE treasury.samples SET history_at=clock_timestamp(),indexed_through=(sample->>'indexedThrough')::timestamptz,
 incomplete=coalesce((sample->>'incomplete')::boolean,true) WHERE address=a;
 END IF;
END $$;
GRANT EXECUTE ON FUNCTION treasury.configure(text,boolean,text),treasury.wallets(),treasury.record(text,bigint,jsonb) TO treasury_service;
RESET ROLE;
