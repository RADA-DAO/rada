FROM denoland/deno:2.9.8@sha256:a0d88a7fcbd44f062cba2748e19df67d30290ad12aa203c7c1e0b12462c483f0 AS deno
FROM postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
COPY --from=deno /usr/bin/deno /usr/local/bin/deno
WORKDIR /app
COPY tools/db-migrate.mjs tools/migrations.mjs ./tools/
COPY modules ./modules
COPY infra/compose/staging-bootstrap.sql infra/compose/staging-seed.sql infra/compose/migrate.sh ./
ENTRYPOINT ["sh", "/app/migrate.sh"]
