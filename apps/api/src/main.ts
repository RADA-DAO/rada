import {
  NotificationStore,
  NotificationWorker,
  notificationConfig,
  startNotificationScheduler,
} from "../../../modules/notifications/index.ts";
import { PostgresArtworkStore } from "../../../modules/jpegpe/index.ts";
import { resolveTelegramSubject } from "../../../modules/identity/index.ts";
import {
  PostgresGovernanceStore,
  startGovernanceScheduler,
} from "../../../modules/governance/index.ts";
import {
  PostgresRankingStore,
  startHolderScheduler,
} from "../../../modules/rankings/index.ts";
import { PostgresHolderSource } from "../../../modules/wallet/index.ts";
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
  ClaimService,
  PostgresClaimDb,
  PostgresSplashStore,
  startRoundScheduler,
} from "../../../modules/splash/index.ts";
import {
  PaymentChain,
  PostgresWalletStore,
  PostgresPaymentStore,
} from "../../../modules/wallet/index.ts";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function secondsSetting(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (
    (raw !== undefined && !/^\d+$/.test(raw)) ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 31_536_000
  )
    throw new Error(`Invalid ${name}`);
  return value;
}

/** Production keeps its scheduler; staging requires a deliberate opt-in. */
export function rankingsWorkerEnabled(
  mode: "production" | "allowlist" | "synthetic",
  flag: string | undefined,
): boolean {
  return mode === "production" || (mode === "allowlist" && flag === "true");
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
  const splashPool = splashUrl
    ? new pg.Pool({ connectionString: splashUrl })
    : undefined;
  const splash = splashPool
    ? new PostgresSplashStore(auth, splashPool)
    : undefined;
  const payments = walletUrl
    ? new PostgresPaymentStore(
        auth,
        new pg.Pool({ connectionString: walletUrl }),
        new PaymentChain(fetch, undefined, {
          safetyMarginSeconds: secondsSetting(
            "WALLET_INDEX_SAFETY_MARGIN_SECONDS",
            600,
          ),
        }),
      )
    : undefined;
  // SPLASH claims pay through wallet platform intents, so they need both logins.
  const claims =
    splashPool && payments
      ? new ClaimService(
          new PostgresClaimDb(auth, splashPool),
          payments,
          undefined,
          undefined,
          secondsSetting("SPLASH_CLAIM_MAX_DEFERRAL_SECONDS", 86_400) * 1000,
        )
      : undefined;
  const clientErrorsUrl = Deno.env.get("CLIENT_ERRORS_DATABASE_URL");
  const failureCounts = new Map<string, number>();
  const rankingsUrl = Deno.env.get("RANKINGS_SERVICE_DATABASE_URL");
  const rankingsWorkerUrl = Deno.env.get("RANKINGS_WORKER_DATABASE_URL");
  if (Boolean(rankingsUrl) !== Boolean(rankingsWorkerUrl))
    throw new Error(
      "Ranking service and worker credentials must be configured together",
    );
  const rankings = rankingsUrl
    ? new PostgresRankingStore(new pg.Pool({ connectionString: rankingsUrl }))
    : undefined;
  const governanceUrl = Deno.env.get("GOVERNANCE_SERVICE_DATABASE_URL");
  const governance = governanceUrl
    ? new PostgresGovernanceStore(
        auth,
        new pg.Pool({ connectionString: governanceUrl }),
        membership,
      )
    : undefined;
  const notificationUrl = Deno.env.get("NOTIFICATIONS_SERVICE_DATABASE_URL");
  const notificationPool = notificationUrl
    ? new pg.Pool({ connectionString: notificationUrl })
    : undefined;
  const notificationSettings = notificationConfig(Deno.env.toObject());
  const app = createApp(
    token,
    new PostgresIdentityStore(auth, service),
    allowedOrigins,
    membership,
    policy,
    registry ? new PostgresRegistryStore(auth, registry) : undefined,
    artifactOrigin,
    wallet,
    payments,
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
    claims,
    rankings,
    governance,
    new PostgresArtworkStore(service, (viewer) =>
      resolveTelegramSubject(auth, viewer),
    ),
    notificationPool
      ? new NotificationStore(auth, notificationPool)
      : undefined,
  );
  if (
    rankingsWorkerUrl &&
    rankingsWorkerEnabled(policy.mode, Deno.env.get("RANKINGS_WORKER_ENABLED"))
  ) {
    const worker = new pg.Pool({ connectionString: rankingsWorkerUrl });
    startHolderScheduler(worker, new PostgresHolderSource(worker), console.log);
  }
  if (notificationPool)
    startNotificationScheduler(
      new NotificationWorker(notificationPool, notificationSettings),
    );
  // SPLASH: close due rounds, open the next one and settle claims, every minute.
  if (splash) startRoundScheduler(splash, 60_000, console.log, claims);
  if (governance) startGovernanceScheduler(governance, console.log);
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
