FROM denoland/deno:2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432 AS deno
FROM postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c
COPY --from=deno /usr/bin/deno /usr/local/bin/deno
WORKDIR /app
COPY tools/db-migrate.mjs tools/migrations.mjs ./tools/
COPY modules ./modules
COPY infra/compose/staging-bootstrap.sql infra/compose/staging-seed.sql infra/compose/migrate.sh ./
ENTRYPOINT ["sh", "/app/migrate.sh"]
