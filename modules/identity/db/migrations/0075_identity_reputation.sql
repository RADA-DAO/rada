SET LOCAL ROLE identity_owner;
-- Worker-only membership checks receive a verified account through this narrow
-- identity interface. Public reputation readers cannot call it or enumerate IDs.
CREATE FUNCTION identity.reputation_telegram_user(s uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT telegram_user_id::text FROM identity.telegram_accounts WHERE subject_id=s
$$;
REVOKE ALL ON FUNCTION identity.reputation_telegram_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.reputation_telegram_user(uuid) TO reputation_owner;
SET LOCAL ROLE reputation_owner;
-- Retain the claim/lease implementation unchanged; only the outer private
-- worker interface enriches external jobs with verified Telegram attribution.
ALTER FUNCTION reputation.claim_job(text[],integer) RENAME TO claim_job_internal;
REVOKE EXECUTE ON FUNCTION reputation.claim_job_internal(text[],integer) FROM reputation_worker;
CREATE FUNCTION reputation.claim_job(lanes text[],lease_seconds integer DEFAULT 60) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 result:=reputation.claim_job_internal(lanes,lease_seconds);
 IF result->>'lane'='external' THEN
 result:=result||jsonb_build_object('telegramUserId',identity.reputation_telegram_user((result->>'subjectId')::uuid));
 END IF;
 RETURN result;
END $$;
GRANT EXECUTE ON FUNCTION reputation.claim_job(text[],integer) TO reputation_worker;
RESET ROLE;
