CREATE ROLE rankings_owner NOLOGIN;
CREATE ROLE rankings_service NOLOGIN;
CREATE ROLE rankings_worker NOLOGIN;
CREATE SCHEMA rankings AUTHORIZATION rankings_owner;
GRANT USAGE ON SCHEMA rankings TO rankings_service, rankings_worker;
GRANT USAGE ON SCHEMA identity TO rankings_owner, rankings_worker;
SET LOCAL ROLE rankings_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
RESET ROLE;
