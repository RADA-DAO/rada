SET LOCAL ROLE governance_owner;
REVOKE ALL ON ALL TABLES IN SCHEMA governance FROM PUBLIC, governance_service;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA governance FROM PUBLIC, governance_service;
-- No direct table access, identity grants, funds, or owner membership for runtime.
RESET ROLE;
