import { spawn, spawnSync } from "node:child_process";
import pg from "pg";
const databaseUrl = process.env.E2E_DATABASE_URL;
if (
  !databaseUrl ||
  !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)
)
  throw new Error(
    "E2E_DATABASE_URL must name a disposable local PostgreSQL 17 database",
  );
const url = new URL(databaseUrl);
const db = new pg.Pool({ connectionString: databaseUrl });
/** @type {import("node:child_process").ChildProcess | undefined} */
let api;
try {
  const version =
    /** @type {import("pg").QueryResult<{server_version_num: string}>} */ (
      await db.query("SHOW server_version_num")
    );
  const serverVersion = version.rows[0];
  if (!serverVersion) throw new Error("PostgreSQL version unavailable");
  if (
    Number(serverVersion.server_version_num) < 170000 ||
    Number(serverVersion.server_version_num) >= 180000
  )
    throw new Error("PostgreSQL 17 required");
  const migrations = spawnSync(process.execPath, ["tools/db-migrate.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || "5432",
      PGUSER: url.username,
      PGPASSWORD: url.password,
      PGDATABASE: url.pathname.slice(1),
    },
  });
  if (migrations.status !== 0) throw new Error("E2E migrations failed");
  await db.query(
    "CREATE ROLE shell_fixture_auth LOGIN PASSWORD 'fixture-only' INHERIT; GRANT identity_auth TO shell_fixture_auth; CREATE ROLE shell_fixture_service LOGIN PASSWORD 'fixture-only' INHERIT; GRANT identity_service TO shell_fixture_service; CREATE ROLE shell_fixture_apps LOGIN PASSWORD 'fixture-only' INHERIT; GRANT apps_service TO shell_fixture_apps; CREATE ROLE shell_fixture_wallet LOGIN PASSWORD 'fixture-only' INHERIT; GRANT wallet_service TO shell_fixture_wallet; CREATE ROLE shell_fixture_ops LOGIN PASSWORD 'fixture-only' INHERIT; GRANT ops_service TO shell_fixture_ops; CREATE ROLE shell_fixture_notifications LOGIN PASSWORD 'fixture-only' INHERIT; GRANT notifications_service TO shell_fixture_notifications;",
  );
  const auth = new URL(url);
  auth.username = "shell_fixture_auth";
  auth.password = "fixture-only";
  const service = new URL(auth);
  service.username = "shell_fixture_service";
  const registry = new URL(auth);
  registry.username = "shell_fixture_apps";
  const wallet = new URL(auth);
  wallet.username = "shell_fixture_wallet";
  const ops = new URL(auth);
  ops.username = "shell_fixture_ops";
  const notifications = new URL(auth);
  notifications.username = "shell_fixture_notifications";
  api = spawn(
    "deno",
    [
      "run",
      "--allow-env",
      "--allow-net",
      "--config",
      "apps/api/deno.json",
      "apps/api/src/main.ts",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        STAGING_RUNTIME: "true",
        STAGING_AUTH_MODE: "synthetic",
        STAGING_ALLOWED_TELEGRAM_IDS: "",
        STAGING_SYNTHETIC_ONLY: "true",
        APPS_SERVICE_DATABASE_URL: registry.toString(),
        WALLET_SERVICE_DATABASE_URL: wallet.toString(),
        CLIENT_ERRORS_DATABASE_URL: ops.toString(),
        NOTIFICATIONS_SERVICE_DATABASE_URL: notifications.toString(),
        NOTIFICATIONS_ENABLED: "false",
        WALLET_APP_ORIGIN: "https://wallet.fixture.example",
        APP_ARTIFACT_ORIGIN: "https://artifacts.example",
        TELEGRAM_BOT_TOKEN: "synthetic-fixture-bot-token",
        API_ALLOWED_ORIGINS: "http://127.0.0.1:4173",
        IDENTITY_AUTH_DATABASE_URL: auth.toString(),
        IDENTITY_SERVICE_DATABASE_URL: service.toString(),
      },
    },
  );
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      ready = (await fetch("http://127.0.0.1:8000/health")).ok;
    } catch {
      /* startup */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("Local API did not start");
  const test = spawn(
    process.execPath,
    [
      "node_modules/@playwright/test/cli.js",
      "test",
      "--config",
      "apps/miniapp/playwright.config.ts",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, VITE_API_ORIGIN: "http://127.0.0.1:8000" },
    },
  );
  process.exitCode = await new Promise((resolve) =>
    test.on("exit", (code) => {
      resolve(code ?? 1);
    }),
  );
} finally {
  if (api) {
    api.kill("SIGTERM");
    await new Promise((resolve) => api?.on("exit", resolve));
  }
  await db.query(
    "DROP ROLE IF EXISTS shell_fixture_auth; DROP ROLE IF EXISTS shell_fixture_service; DROP ROLE IF EXISTS shell_fixture_apps; DROP ROLE IF EXISTS shell_fixture_wallet; DROP ROLE IF EXISTS shell_fixture_ops; DROP ROLE IF EXISTS shell_fixture_notifications;",
  );
  await db.end();
}
