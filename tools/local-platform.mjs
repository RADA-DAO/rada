import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_API,
  LOCAL_WEB,
  LOCAL_ARTIFACTS,
  LOCAL_TOKEN,
  localEnvironment,
  requireFreePort,
  roleUrl,
  localLaunch,
  waitForDatabase,
  requireLocalDocker,
} from "./local-platform-support.mjs";
import { artifactServer, localWebServer } from "./local-platform-services.mjs";
import { command, service, waitFor } from "./local-platform-process.mjs";
import { colimaTunnel, wantsColimaTunnel } from "./local-platform-tunnel.mjs";

const image =
  "postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826";
const arguments_ = process.argv.slice(2);
if (
  arguments_.length &&
  arguments_[0] !== "--check" &&
  arguments_[0] !== "--exec"
)
  throw new Error(
    "Usage: node tools/local-platform.mjs [--check | --exec COMMAND ARGS...]",
  );
if (
  (arguments_[0] === "--check" && arguments_.length !== 1) ||
  (arguments_[0] === "--exec" && arguments_.length < 2)
)
  throw new Error("Invalid local command arguments");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
const env = localEnvironment(process.env);
// Vite must not see inherited VITE_* provider configuration or load .env files.
process.env = { ...env };
wantsColimaTunnel(env);
/** @type {[string, string[]][]} */
const prerequisites = [
  ["docker", ["version", "--format", "{{.Client.Version}}"]],
  ["deno", ["--version"]],
  ["openssl", ["version"]],
];
for (const [tool, args] of prerequisites) await command(tool, args, env);
if (env.DOCKER_HOST && !env.DOCKER_CONTEXT) requireLocalDocker(env.DOCKER_HOST);
else
  requireLocalDocker(
    await command(
      "docker",
      [
        "context",
        "inspect",
        "--format",
        "{{.Endpoints.docker.Host}}",
        ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []),
      ],
      env,
    ),
  );
for (const port of [8000, 4173, 8443]) await requireFreePort(port);
if (arguments_[0] === "--check") {
  console.log("Local toolchain and ports available; no services started.");
} else {
  await run();
}

async function run() {
  const directory = await mkdtemp(join(tmpdir(), "rada-local-"));
  const artifacts = join(directory, "published");
  await mkdir(join(artifacts, "artifacts"), { recursive: true });
  const name = `rada-local-${randomBytes(8).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  /** @type {ReturnType<typeof service> | undefined} */
  let api;
  /** @type {ReturnType<typeof service> | undefined} */
  let executable;
  /** @type {(() => Promise<void>) | undefined} */
  let closeWeb;
  /** @type {(() => Promise<void>) | undefined} */
  let closeArtifacts;
  /** @type {Awaited<ReturnType<typeof colimaTunnel>> | undefined} */
  let tunnel;
  let containerCreated = false;
  let stopped = false;
  /** @type {(value?: unknown) => void} */
  let stop = () => {};
  const shutdown = new Promise((resolve) => {
    stop = resolve;
  });
  const onSignal = () => {
    stopped = true;
    stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const check = () => {
    if (stopped) throw new Error("Local session stopped");
    api?.check();
    tunnel?.check();
  };
  try {
    await command(
      "docker",
      [
        "create",
        "--name",
        name,
        "--label",
        `io.rada.local-run=${name}`,
        "--publish",
        "127.0.0.1::5432",
        "--env",
        "POSTGRES_DB=rada_local",
        "--env",
        `POSTGRES_PASSWORD=${password}`,
        "--tmpfs",
        "/var/lib/postgresql/data:rw,size=536870912",
        image,
      ],
      env,
    );
    containerCreated = true;
    check();
    await command("docker", ["start", name], env);
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      check();
      try {
        await command(
          "docker",
          [
            "exec",
            "-e",
            `PGPASSWORD=${password}`,
            name,
            "psql",
            "-X",
            "--no-password",
            "-h",
            "127.0.0.1",
            "-U",
            "postgres",
            "-d",
            "rada_local",
            "-v",
            "ON_ERROR_STOP=1",
            "-q",
            "-c",
            "SELECT 1",
          ],
          env,
        );
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!ready) throw new Error("Disposable PostgreSQL did not become ready");
    const port = await command("docker", ["port", name, "5432/tcp"], env);
    if (!/^127\.0\.0\.1:[0-9]+$/.test(port))
      throw new Error("Unexpected local database binding");
    let databasePort = port.split(":")[1];
    if (wantsColimaTunnel(env)) {
      tunnel = await colimaTunnel(directory, Number(databasePort), env);
      databasePort = String(tunnel.port);
    }
    const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${databasePort ?? ""}/rada_local`;
    await waitForDatabase(databaseUrl, check);
    await command(process.execPath, ["tools/db-migrate.mjs"], {
      ...env,
      PG_CONTAINER: name,
      PGUSER: "postgres",
      PGDATABASE: "rada_local",
    });
    /** @type {[string, string][]} */
    const roles = [
      ["local_auth", "identity_auth"],
      ["local_identity", "identity_service"],
      ["local_apps", "apps_service"],
    ];
    const sql = `BEGIN; REVOKE ALL ON DATABASE rada_local FROM PUBLIC;\n${roles.map(([login, role]) => `CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT; GRANT ${role} TO ${login}; GRANT CONNECT ON DATABASE rada_local TO ${login};`).join("\n")}\nSET LOCAL ROLE identity_owner;\nINSERT INTO identity.subjects(subject_id) VALUES ('00000000-0000-4000-8000-000000000101'),('00000000-0000-4000-8000-000000000102');\nINSERT INTO identity.telegram_accounts(subject_id,telegram_user_id) VALUES ('00000000-0000-4000-8000-000000000101',101),('00000000-0000-4000-8000-000000000102',102);\nINSERT INTO identity.role_grants(subject_id,role_name) VALUES ('00000000-0000-4000-8000-000000000102','apps.reviewer'),('00000000-0000-4000-8000-000000000102','apps.steward'); COMMIT;`;
    await command(
      "docker",
      [
        "exec",
        "-i",
        name,
        "psql",
        "-X",
        "--no-password",
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
        "-U",
        "postgres",
        "-d",
        "rada_local",
      ],
      env,
      sql,
    );
    await command(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      env,
    );
    closeArtifacts = await artifactServer({
      directory: artifacts,
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    });
    api = service(
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
        ...env,
        STAGING_RUNTIME: "true",
        STAGING_AUTH_MODE: "synthetic",
        STAGING_SYNTHETIC_ONLY: "true",
        TELEGRAM_BOT_TOKEN: LOCAL_TOKEN,
        API_HOST: "127.0.0.1",
        API_ALLOWED_ORIGINS: LOCAL_WEB,
        IDENTITY_AUTH_DATABASE_URL: roleUrl(
          databaseUrl,
          "local_auth",
          password,
        ),
        IDENTITY_SERVICE_DATABASE_URL: roleUrl(
          databaseUrl,
          "local_identity",
          password,
        ),
        APPS_SERVICE_DATABASE_URL: roleUrl(databaseUrl, "local_apps", password),
        APP_ARTIFACT_ORIGIN: LOCAL_ARTIFACTS,
      },
    );
    await waitFor(`${LOCAL_API}/health`, check);
    const signedHeaders = { Authorization: `tma ${localLaunch()}` };
    // Process liveness does not prove the host-forwarded DB or restricted roles work.
    await waitFor(`${LOCAL_API}/me`, check, signedHeaders);
    await waitFor(`${LOCAL_API}/apps/published`, check, signedHeaders);
    check();
    if (arguments_[0] !== "--exec") {
      const { seedExample } =
        await import("../packages/platform-sdk/scripts/example-lifecycle.ts");
      await seedExample({
        apiOrigin: LOCAL_API,
        artifactsDirectory: artifacts,
      });
    }
    closeWeb = await localWebServer();
    await waitFor(LOCAL_WEB, check);
    console.log(
      `Synthetic local platform: ${LOCAL_WEB}\nAPI: ${LOCAL_API}\nArtifacts: ${LOCAL_ARTIFACTS}\nFor interactive use, open ${LOCAL_ARTIFACTS}/health once and accept this session's local certificate. No system trust store is changed.\nCtrl-C removes only this session's disposable services and data.`,
    );
    if (arguments_[0] === "--exec") {
      const program = arguments_[1];
      if (!program) throw new Error("Missing local command");
      executable = service(program, arguments_.slice(2), {
        ...env,
        RADA_LOCAL_API_ORIGIN: LOCAL_API,
        RADA_LOCAL_WEB_ORIGIN: LOCAL_WEB,
        RADA_LOCAL_ARTIFACT_ORIGIN: LOCAL_ARTIFACTS,
        RADA_LOCAL_ARTIFACT_DIR: artifacts,
        RADA_LOCAL_CERTIFICATE: join(directory, "cert.pem"),
        RADA_LOCAL_DATABASE_URL: databaseUrl,
      });
      const checkApi = setInterval(() => {
        try {
          check();
        } catch (error) {
          console.error(error);
          stop();
        }
      }, 1000);
      /** @type {unknown} */
      let status;
      try {
        status = await Promise.race([
          new Promise((resolve) => {
            executable?.child.once("close", (code) => {
              resolve(code);
            });
          }),
          shutdown.then(() => 130),
        ]);
      } finally {
        clearInterval(checkApi);
      }
      process.exitCode = typeof status === "number" ? status : 1;
    } else {
      const interval = setInterval(() => {
        try {
          check();
        } catch (error) {
          console.error(error);
          process.exitCode = 1;
          stop();
        }
      }, 1000);
      try {
        await shutdown;
      } finally {
        clearInterval(interval);
      }
    }
  } finally {
    await cleanup();
  }
  async function cleanup() {
    try {
      const results = await Promise.allSettled([
        executable?.stop(),
        closeWeb?.(),
        api?.stop(),
        closeArtifacts?.(),
        tunnel?.stop(),
        removeContainer(),
      ]);
      await rm(directory, { recursive: true, force: true });
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
      for (const port of [8000, 4173, 8443]) await requireFreePort(port);
    } finally {
      // npm may forward repeated signals; keep them handled throughout teardown.
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
  async function removeContainer() {
    if (!containerCreated) return;
    const owner = await command(
      "docker",
      [
        "inspect",
        "--format",
        '{{index .Config.Labels "io.rada.local-run"}}',
        name,
      ],
      env,
    );
    if (owner !== name)
      throw new Error(
        "Refusing to remove a container not owned by this session",
      );
    await command("docker", ["rm", "--force", "--volumes", name], env);
  }
}
