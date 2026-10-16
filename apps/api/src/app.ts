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
import {
  type ClaimService,
  type SplashStore,
  registerSplashRoutes,
} from "../../../modules/splash/index.ts";
import { registerClientErrorRoutes } from "../../../modules/ops/index.ts";
import {
  createErrorReporter,
  registerErrorCounts,
  registerRequestId,
  type OpsOptions,
} from "./observability.ts";

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
  ops: OpsOptions = {},
  splash?: SplashStore,
  claims?: ClaimService,
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
  const reporter = createErrorReporter(ops);
  registerRequestId(app);
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
  registerErrorCounts(app, reporter.counts, ops.token);
  // Before the staging guard: browsers cannot sign beacons; the route is strict itself.
  if (ops.clientErrors)
    registerClientErrorRoutes(app, ops.clientErrors, ops.clientErrorLimiter);
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
  if (splash) registerSplashRoutes(app, splash, authenticated, claims);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  // Records hold only route pattern, error class and code; see observability.ts.
  app.onError((error, c) => reporter.onError(error, c));
  return app;
}
