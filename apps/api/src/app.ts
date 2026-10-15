import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  identityAuthPolicy,
  telegramAuthenticator,
  registerStagingGuard,
  type IdentityAuthPolicy,
  type IdentityStore,
  registerIdentityRoutes,
  unavailableMembership,
  type MembershipProvider,
} from "../../../modules/identity/index.ts";
import {
  type RegistryStore,
  registerRegistryRoutes,
} from "../../../modules/apps/index.ts";
import {
  type WalletStore,
  registerWalletRoutes,
  type PostgresPaymentStore,
  registerPaymentRoutes,
} from "../../../modules/wallet/index.ts";

export function createApp(
  token: string,
  store: IdentityStore,
  allowedOrigins: string[] = [],
  membership: MembershipProvider = unavailableMembership,
  access: IdentityAuthPolicy | boolean = false,
  registry?: RegistryStore,
  artifactOrigin?: string,
  wallet?: WalletStore,
  payments?: PostgresPaymentStore,
) {
  const policy =
    typeof access === "boolean"
      ? identityAuthPolicy(
          access
            ? {
                STAGING_RUNTIME: "true",
                STAGING_AUTH_MODE: "synthetic",
                STAGING_SYNTHETIC_ONLY: "true",
              }
            : {},
        )
      : access;
  const authenticated = telegramAuthenticator(token, policy);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin) =>
        allowedOrigins.includes(origin) ? origin : undefined,
      allowMethods: ["GET", "PUT", "POST"],
      allowHeaders: ["Authorization", "Content-Type"],
      credentials: false,
    }),
  );
  registerStagingGuard(app, authenticated, policy);
  app.get("/health", (c) => c.json({ status: "ok" }));
  if (registry && artifactOrigin)
    registerRegistryRoutes(app, registry, artifactOrigin, authenticated);
  registerIdentityRoutes(
    app,
    store,
    authenticated,
    membership,
    policy.mode !== "production",
  );
  if (wallet) registerWalletRoutes(app, wallet, authenticated);
  if (payments) registerPaymentRoutes(app, payments, authenticated);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  // Never log credentials, raw initData, database errors or Telegram profile data.
  app.onError(
    () =>
      new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }),
  );
  return app;
}
