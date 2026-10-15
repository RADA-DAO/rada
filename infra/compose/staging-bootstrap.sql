\getenv auth_password AUTH_PASSWORD
\getenv service_password SERVICE_PASSWORD
BEGIN;
REVOKE ALL ON DATABASE rada_staging FROM PUBLIC;
SELECT 'CREATE ROLE staging_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_auth') \gexec
SELECT 'CREATE ROLE staging_service LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_service') \gexec
ALTER ROLE staging_auth PASSWORD :'auth_password';
ALTER ROLE staging_service PASSWORD :'service_password';
GRANT CONNECT ON DATABASE rada_staging TO staging_auth, staging_service;
GRANT identity_auth TO staging_auth;
GRANT identity_service TO staging_service;
COMMIT;
