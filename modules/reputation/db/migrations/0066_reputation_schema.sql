CREATE ROLE reputation_owner NOLOGIN;
CREATE ROLE reputation_service NOLOGIN;
CREATE ROLE reputation_ingress NOLOGIN;
CREATE ROLE reputation_operator NOLOGIN;
CREATE SCHEMA reputation AUTHORIZATION reputation_owner;
GRANT USAGE ON SCHEMA identity TO reputation_owner;
GRANT EXECUTE ON FUNCTION identity.current_subject() TO reputation_owner;
GRANT USAGE ON SCHEMA reputation TO reputation_service,reputation_ingress,reputation_operator;
SET LOCAL ROLE reputation_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE reputation.subjects (
 subject_id uuid PRIMARY KEY, revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), lifetime_units numeric NOT NULL DEFAULT 0
);
-- Each UUID denotes one occurrence. New rules/occurrences require a new UUID.
CREATE TABLE reputation.missions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version integer NOT NULL CHECK(version>0),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 description text NOT NULL CHECK(length(description) BETWEEN 1 AND 8000),
 category text NOT NULL CHECK(category IN ('work','content','help','participation')),
 units bigint NOT NULL CHECK(units>=0), rule_hash text NOT NULL CHECK(length(rule_hash) BETWEEN 1 AND 256),
 verifier text NOT NULL CHECK(verifier IN ('acknowledgement','external')),
 action_url text CHECK(action_url ~ '^https://[^[:space:]]+$'), enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE reputation.items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject_id uuid NOT NULL,
 title text NOT NULL, description text NOT NULL, category text NOT NULL CHECK(category IN ('work','content','help','participation')),
 units bigint NOT NULL DEFAULT 0, status text NOT NULL CHECK(status IN ('accepted','pending','excluded','superseded')),
 reason text NOT NULL, occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 rule_hash text, evidence jsonb NOT NULL DEFAULT '[]', mission_id uuid REFERENCES reputation.missions,
 source text, source_id text, CHECK((source IS NULL)=(source_id IS NULL)),
 UNIQUE(subject_id,mission_id), UNIQUE(source,source_id),
 CHECK(status='accepted' OR units=0)
);
CREATE INDEX items_subject_period ON reputation.items(subject_id,occurred_at DESC,id DESC);
-- Exact compact projections. Day keys use the community calendar, not UTC.
CREATE TABLE reputation.day_totals (
 subject_id uuid NOT NULL, day date NOT NULL, category text NOT NULL,
 units numeric NOT NULL DEFAULT 0, pending bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(subject_id,day,category)
);
CREATE TABLE reputation.category_totals (
 subject_id uuid NOT NULL, category text NOT NULL, units numeric NOT NULL DEFAULT 0, pending bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(subject_id,category)
);
CREATE TABLE reputation.changes (
 subject_id uuid NOT NULL, revision bigint NOT NULL, type text NOT NULL CHECK(type IN ('item','appeal')),
 item_id uuid NOT NULL REFERENCES reputation.items, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(subject_id,revision)
);
-- The durable changes table is also the outbox. NOTIFY is only a lossy delivery hint.
CREATE TABLE reputation.commands (
 subject_id uuid NOT NULL, request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
 fingerprint jsonb NOT NULL, receipt jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(subject_id,request_id)
);
CREATE TABLE reputation.appeals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject_id uuid NOT NULL,
 item_id uuid NOT NULL REFERENCES reputation.items, message text NOT NULL CHECK(length(message) BETWEEN 1 AND 4000),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')), resolution text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX appeals_subject_item ON reputation.appeals(subject_id,item_id,created_at);
CREATE TABLE reputation.decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), subject_id uuid NOT NULL, item_id uuid NOT NULL REFERENCES reputation.items,
 source text NOT NULL, source_id text NOT NULL, units bigint NOT NULL, status text NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 4000), evidence jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(source,source_id)
);
CREATE FUNCTION reputation.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'immutable_record' USING ERRCODE='23514'; END $$;
CREATE TRIGGER commands_immutable BEFORE UPDATE OR DELETE ON reputation.commands FOR EACH ROW EXECUTE FUNCTION reputation.immutable();
CREATE TRIGGER decisions_immutable BEFORE UPDATE OR DELETE ON reputation.decisions FOR EACH ROW EXECUTE FUNCTION reputation.immutable();
CREATE TRIGGER changes_immutable BEFORE UPDATE OR DELETE ON reputation.changes FOR EACH ROW EXECUTE FUNCTION reputation.immutable();
CREATE FUNCTION reputation.mission_rules_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(OLD)-'enabled') IS DISTINCT FROM (to_jsonb(NEW)-'enabled') THEN
 RAISE EXCEPTION 'immutable_rule' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER missions_immutable BEFORE UPDATE OR DELETE ON reputation.missions FOR EACH ROW EXECUTE FUNCTION reputation.mission_rules_immutable();
CREATE FUNCTION reputation.points(units numeric) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN units=0 THEN '0' WHEN mod(units,10000)=0 THEN trunc(units/10000)::text
 ELSE rtrim(rtrim((units/10000)::text,'0'),'.') END
$$;
CREATE FUNCTION reputation.lock_subject(s uuid) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF s IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE='28000'; END IF;
 INSERT INTO reputation.subjects(subject_id) VALUES(s) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM reputation.subjects WHERE subject_id=s FOR UPDATE;
END $$;
CREATE FUNCTION reputation.adjust_totals(s uuid,at_time timestamptz,c text,u numeric,p bigint)
RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 PERFORM reputation.lock_subject(s);
 INSERT INTO reputation.day_totals(subject_id,day,category,units,pending)
 VALUES(s,(at_time AT TIME ZONE 'Europe/Kyiv')::date,c,u,p)
 ON CONFLICT(subject_id,day,category) DO UPDATE SET units=reputation.day_totals.units+excluded.units,pending=reputation.day_totals.pending+excluded.pending;
 INSERT INTO reputation.category_totals(subject_id,category,units,pending) VALUES(s,c,u,p)
 ON CONFLICT(subject_id,category) DO UPDATE SET units=reputation.category_totals.units+excluded.units,pending=reputation.category_totals.pending+excluded.pending;
 UPDATE reputation.subjects SET lifetime_units=lifetime_units+u WHERE subject_id=s;
END $$;
CREATE FUNCTION reputation.project_item() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN
 PERFORM reputation.adjust_totals(OLD.subject_id,OLD.occurred_at,OLD.category,
 CASE WHEN OLD.status='accepted' THEN -OLD.units::numeric ELSE 0 END,
 CASE WHEN OLD.status='pending' THEN -1::bigint ELSE 0::bigint END);
 END IF;
 IF TG_OP<>'DELETE' THEN
 PERFORM reputation.adjust_totals(NEW.subject_id,NEW.occurred_at,NEW.category,
 CASE WHEN NEW.status='accepted' THEN NEW.units::numeric ELSE 0 END,
 CASE WHEN NEW.status='pending' THEN 1::bigint ELSE 0::bigint END);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER project_item AFTER INSERT OR UPDATE OR DELETE ON reputation.items FOR EACH ROW EXECUTE FUNCTION reputation.project_item();
CREATE FUNCTION reputation.emit(s uuid, kind text, item uuid) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r bigint;
BEGIN
 UPDATE reputation.subjects SET revision=revision+1,updated_at=clock_timestamp() WHERE subject_id=s RETURNING revision INTO r;
 INSERT INTO reputation.changes(subject_id,revision,type,item_id) VALUES(s,r,kind,item);
 PERFORM pg_notify('reputation_changes',jsonb_build_object('subject',s,'revision',r::text)::text);
END $$;
RESET ROLE;
