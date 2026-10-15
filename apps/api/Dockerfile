FROM denoland/deno:2.9.7@sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432
WORKDIR /app
COPY apps/api/deno.json apps/api/deno.lock ./apps/api/
COPY apps/api/src ./apps/api/src
COPY packages/platform-sdk/src/app-manifest.ts ./packages/platform-sdk/src/app-manifest.ts
RUN deno cache --frozen --config apps/api/deno.json apps/api/src/main.ts
USER deno
CMD ["run", "--cached-only", "--frozen", "--allow-env", "--allow-net", "--config", "apps/api/deno.json", "apps/api/src/main.ts"]
