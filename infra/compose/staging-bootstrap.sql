\getenv rankings_password RANKINGS_PASSWORD
\getenv rankings_worker_password RANKINGS_WORKER_PASSWORD
\getenv auth_password AUTH_PASSWORD
\getenv service_password SERVICE_PASSWORD
\getenv wallet_password WALLET_PASSWORD
\getenv ops_password OPS_PASSWORD
\getenv splash_password SPLASH_PASSWORD
\getenv governance_password GOVERNANCE_PASSWORD
BEGIN;
REVOKE ALL ON DATABASE rada_staging FROM PUBLIC;
SELECT 'CREATE ROLE staging_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_auth') \gexec
SELECT 'CREATE ROLE staging_service LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_service') \gexec
SELECT 'CREATE ROLE staging_wallet LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_wallet') \gexec
SELECT 'CREATE ROLE staging_ops LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_ops') \gexec
ALTER ROLE staging_ops PASSWORD :'ops_password';
GRANT ops_service TO staging_ops;
SELECT 'CREATE ROLE staging_splash LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_splash') \gexec
ALTER ROLE staging_splash PASSWORD :'splash_password';
GRANT splash_service TO staging_splash;
SELECT 'CREATE ROLE staging_governance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_governance') \gexec
ALTER ROLE staging_governance PASSWORD :'governance_password';
GRANT governance_service TO staging_governance;
ALTER ROLE staging_wallet PASSWORD :'wallet_password';
GRANT wallet_service TO staging_wallet;
ALTER ROLE staging_auth PASSWORD :'auth_password';
ALTER ROLE staging_service PASSWORD :'service_password';
GRANT CONNECT ON DATABASE rada_staging TO staging_auth, staging_service, staging_wallet, staging_ops, staging_splash, staging_governance;
GRANT identity_auth TO staging_auth;
GRANT identity_service TO staging_service;
SELECT 'CREATE ROLE staging_rankings LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_rankings') \gexec
SELECT 'CREATE ROLE staging_rankings_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'staging_rankings_worker') \gexec
ALTER ROLE staging_rankings PASSWORD :'rankings_password';
ALTER ROLE staging_rankings_worker PASSWORD :'rankings_worker_password';
GRANT rankings_service TO staging_rankings;
GRANT rankings_worker TO staging_rankings_worker;
GRANT CONNECT ON DATABASE rada_staging TO staging_rankings, staging_rankings_worker;
COMMIT;
