import pg from "pg";
import { createApp } from "./app.ts";
import {
  TelegramMembershipProvider,
  identityAuthPolicy,
  unavailableMembership,
} from "../../../modules/identity/index.ts";
import { PostgresIdentityStore } from "../../../modules/identity/index.ts";
import { PostgresRegistryStore } from "../../../modules/apps/index.ts";
import {
  FailureDigest,
  PostgresAlertStore,
  PostgresClientErrorStore,
  alertConfig,
  startDigestScheduler,
} from "../../../modules/ops/index.ts";
import {
  PostgresSplashStore,
  startRoundScheduler,
} from "../../../modules/splash/index.ts";
import {
  PostgresWalletStore,
  PostgresPaymentStore,
} from "../../../modules/wallet/index.ts";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
if (import.meta.main) {
  const policy = identityAuthPolicy(Deno.env.toObject());
  const auth = new pg.Pool({
    connectionString: required("IDENTITY_AUTH_DATABASE_URL"),
  });
  const service = new pg.Pool({
    connectionString: required("IDENTITY_SERVICE_DATABASE_URL"),
  });
  const registryUrl = Deno.env.get("APPS_SERVICE_DATABASE_URL");
  const artifactOrigin = Deno.env.get("APP_ARTIFACT_ORIGIN");
  if (Boolean(registryUrl) !== Boolean(artifactOrigin))
    throw new Error(
      "Registry credentials and artifact origin must be configured together",
    );
  const registry = registryUrl
    ? new pg.Pool({ connectionString: registryUrl })
    : undefined;
  const walletUrl = Deno.env.get("WALLET_SERVICE_DATABASE_URL");
  const walletOrigin = Deno.env.get("WALLET_APP_ORIGIN");
  if (Boolean(walletUrl) !== Boolean(walletOrigin))
    throw new Error(
      "Wallet credentials and app origin must be configured together",
    );
  let walletDomain: string | undefined;
  if (walletOrigin) {
    const origin = new URL(walletOrigin);
    if (
      origin.origin !== walletOrigin ||
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.hostname === "localhost" ||
      origin.hostname === "127.0.0.1" ||
      origin.hostname.endsWith(".localhost") ||
      origin.hostname.startsWith("[") ||
      /^\d+(?:\.\d+){3}$/.test(origin.hostname)
    )
      throw new Error("Invalid WALLET_APP_ORIGIN");
    walletDomain = origin.hostname;
  }
  const wallet =
    walletUrl && walletDomain
      ? new PostgresWalletStore(
          auth,
          new pg.Pool({ connectionString: walletUrl }),
          walletDomain,
        )
      : undefined;
  const allowedOrigins = (Deno.env.get("API_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    allowedOrigins.some(
      (origin) => new URL(origin).origin !== origin || !/^https?:/.test(origin),
    )
  )
    throw new Error("Invalid API_ALLOWED_ORIGINS");
  const token = required("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("DAO_TELEGRAM_CHAT_ID")?.trim();
  const membership =
    policy.mode === "production" && chatId
      ? new TelegramMembershipProvider(token, chatId)
      : unavailableMembership;
  const splashUrl = Deno.env.get("SPLASH_SERVICE_DATABASE_URL");
  const splash = splashUrl
    ? new PostgresSplashStore(
        auth,
        new pg.Pool({ connectionString: splashUrl }),
      )
    : undefined;
  const clientErrorsUrl = Deno.env.get("CLIENT_ERRORS_DATABASE_URL");
  const failureCounts = new Map<string, number>();
  const app = createApp(
    token,
    new PostgresIdentityStore(auth, service),
    allowedOrigins,
    membership,
    policy,
    registry ? new PostgresRegistryStore(auth, registry) : undefined,
    artifactOrigin,
    wallet,
    walletUrl
      ? new PostgresPaymentStore(
          auth,
          new pg.Pool({ connectionString: walletUrl }),
        )
      : undefined,
    {
      token: Deno.env.get("API_OPS_TOKEN")?.trim() || undefined,
      counts: failureCounts,
      clientErrors: clientErrorsUrl
        ? new PostgresClientErrorStore(
            new pg.Pool({ connectionString: clientErrorsUrl }),
          )
        : undefined,
    },
    splash,
  );
  // SPLASH rounds: close due rounds and open the next one, every minute.
  if (splash) startRoundScheduler(splash);
  const alerts = alertConfig(Deno.env.toObject());
  if (Deno.env.get("ALERTS_ENABLED")?.trim() === "true" && !alerts)
    console.log("alert digest disabled: incomplete or invalid configuration");
  if (alerts)
    startDigestScheduler(
      new FailureDigest({
        config: alerts,
        counts: failureCounts,
        store: clientErrorsUrl
          ? new PostgresAlertStore(
              new pg.Pool({ connectionString: clientErrorsUrl }),
            )
          : undefined,
      }),
    );
  Deno.serve(
    { hostname: Deno.env.get("API_HOST") ?? "127.0.0.1", port: 8000 },
    app.fetch,
  );
}
