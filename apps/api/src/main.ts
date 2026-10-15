import pg from "pg";
import { createApp } from "./app.ts";
import {
  TelegramMembershipProvider,
  unavailableMembership,
} from "../../../modules/identity/index.ts";
import { PostgresIdentityStore } from "../../../modules/identity/index.ts";
import { PostgresRegistryStore } from "../../../modules/apps/index.ts";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
if (import.meta.main) {
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
  const syntheticOnly = Deno.env.get("STAGING_SYNTHETIC_ONLY") === "true";
  const membership =
    !syntheticOnly && chatId
      ? new TelegramMembershipProvider(token, chatId)
      : unavailableMembership;
  const app = createApp(
    token,
    new PostgresIdentityStore(auth, service),
    allowedOrigins,
    membership,
    syntheticOnly,
    registry ? new PostgresRegistryStore(auth, registry) : undefined,
    artifactOrigin,
  );
  Deno.serve(
    { hostname: Deno.env.get("API_HOST") ?? "127.0.0.1", port: 8000 },
    app.fetch,
  );
}
