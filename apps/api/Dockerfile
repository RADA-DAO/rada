FROM denoland/deno:2.9.8@sha256:a0d88a7fcbd44f062cba2748e19df67d30290ad12aa203c7c1e0b12462c483f0
WORKDIR /app
COPY apps/api/deno.json apps/api/deno.lock ./apps/api/
COPY apps/api/src ./apps/api/src
COPY modules ./modules
COPY packages/platform-sdk/src/app-manifest.ts ./packages/platform-sdk/src/app-manifest.ts
COPY packages/platform-sdk/src/launcher-layout.ts ./packages/platform-sdk/src/launcher-layout.ts
COPY packages/i18n/locales ./packages/i18n/locales
COPY packages/http ./packages/http
COPY packages/payment-encoding ./packages/payment-encoding
RUN deno cache --frozen --config apps/api/deno.json apps/api/src/main.ts
USER deno
CMD ["run", "--cached-only", "--frozen", "--allow-env", "--allow-net", "--config", "apps/api/deno.json", "apps/api/src/main.ts"]
