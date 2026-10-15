FROM denoland/deno:2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432 AS deno
FROM postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
COPY --from=deno /usr/bin/deno /usr/local/bin/deno
WORKDIR /app
COPY tools/db-migrate.mjs tools/migrations.mjs ./tools/
COPY modules ./modules
COPY infra/compose/staging-bootstrap.sql infra/compose/staging-seed.sql infra/compose/migrate.sh ./
ENTRYPOINT ["sh", "/app/migrate.sh"]
