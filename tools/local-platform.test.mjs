import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { test } from "node:test";
import {
  LOCAL_TOKEN,
  localEnvironment,
  localLaunch,
  requireFreePort,
  requireLocalDocker,
  roleUrl,
} from "./local-platform-support.mjs";
import { service } from "./local-platform-process.mjs";
import {
  wantsColimaTunnel,
  validateColimaConfig,
} from "./local-platform-tunnel.mjs";

void test("fixture environment excludes provider, database, auth and Vite overrides", () => {
  const env = localEnvironment({
    PATH: "/bin",
    HOME: "/home/fixture",
    DOCKER_CONTEXT: "colima",
    DATABASE_URL: "postgresql://remote/prod",
    PGHOST: "remote",
    TELEGRAM_BOT_TOKEN: "private",
    VITE_API_ORIGIN: "https://remote",
    NODE_OPTIONS: "--require=unsafe",
    STAGING_AUTH_MODE: "production",
  });
  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/home/fixture",
    DOCKER_CONTEXT: "colima",
  });
});
void test("synthetic actor signatures use canonical HMAC and distinct identities", () => {
  const launch = new URLSearchParams(localLaunch(102, 123));
  const expected = createHmac(
    "sha256",
    createHmac("sha256", "WebAppData").update(LOCAL_TOKEN).digest(),
  )
    .update('auth_date=123\nuser={"id":102}')
    .digest("hex");
  assert.equal(launch.get("hash"), expected);
  assert.equal(launch.get("auth_date"), "123");
  assert.equal(launch.get("user"), '{"id":102}');
  assert.notEqual(localLaunch(101, 123), localLaunch(102, 123));
});
void test("role credentials cannot be redirected to external databases", () => {
  const value = new URL(
    roleUrl(
      "postgresql://postgres:fixture@127.0.0.1:1234/rada_local",
      "local_apps",
      "other",
    ),
  );
  assert.equal(value.username, "local_apps");
  assert.equal(value.password, "other");
  for (const url of [
    "postgresql://remote/rada_local",
    "postgresql://127.0.0.1/production",
    "https://127.0.0.1/rada_local",
  ])
    assert.throws(() => roleUrl(url, "local_apps", "fixture"));
});
void test("remote Docker transports are refused", () => {
  requireLocalDocker("unix:///var/run/docker.sock");
  requireLocalDocker("npipe:////./pipe/docker_engine");
  for (const endpoint of [
    "ssh://production",
    "tcp://remote:2376",
    "tcp://127.0.0.1:2375",
  ])
    assert.throws(() => {
      requireLocalDocker(endpoint);
    });
});
void test("occupied ports fail without closing the existing listener", async () => {
  const server = createServer();
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve(undefined);
    }),
  );
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No local address");
    await assert.rejects(requireFreePort(address.port));
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
void test("owned child is stopped and reaped, repeated cleanup is safe", async () => {
  const child = service(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    localEnvironment(process.env),
  );
  await new Promise((resolve, reject) => {
    child.child.once("spawn", resolve);
    child.child.once("error", reject);
  });
  child.check();
  await child.stop();
  await child.stop();
  assert.ok(child.child.signalCode || child.child.exitCode !== null);
  assert.throws(() => {
    child.check();
  });
});

void test("Colima tunnel requires explicit opt-in and the local context", () => {
  assert.equal(wantsColimaTunnel({}), false);
  assert.equal(
    wantsColimaTunnel({
      DOCKER_CONTEXT: "colima",
      RADA_LOCAL_COLIMA_TUNNEL: "true",
    }),
    true,
  );
  assert.throws(() => wantsColimaTunnel({ RADA_LOCAL_COLIMA_TUNNEL: "true" }));
  assert.throws(() =>
    wantsColimaTunnel({
      DOCKER_CONTEXT: "remote",
      RADA_LOCAL_COLIMA_TUNNEL: "true",
    }),
  );
  assert.throws(() => wantsColimaTunnel({ RADA_LOCAL_COLIMA_TUNNEL: "auto" }));
  validateColimaConfig("Host colima\n  Hostname 127.0.0.1\n  Port 12345\n");
  assert.throws(() => {
    validateColimaConfig("Host colima\n  Hostname remote\n  Port 22\n");
  });
});
