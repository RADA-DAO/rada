\getenv auth_password AUTH_PASSWORD
\getenv service_password SERVICE_PASSWORD
\getenv wallet_password WALLET_PASSWORD
BEGIN;
REVOKE ALL ON DATABASE rada_staging FROM PUBLIC;
SELECT 'CREATE ROLE staging_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_auth') \gexec
SELECT 'CREATE ROLE staging_service LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_service') \gexec
SELECT 'CREATE ROLE staging_wallet LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_wallet') \gexec
ALTER ROLE staging_wallet PASSWORD :'wallet_password';
GRANT wallet_service TO staging_wallet;
ALTER ROLE staging_auth PASSWORD :'auth_password';
ALTER ROLE staging_service PASSWORD :'service_password';
GRANT CONNECT ON DATABASE rada_staging TO staging_auth, staging_service, staging_wallet;
GRANT identity_auth TO staging_auth;
GRANT identity_service TO staging_service;
COMMIT;
