import pg from "pg";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";

export const LOCAL_TOKEN = "synthetic-fixture-bot-token";
export const LOCAL_API = "http://127.0.0.1:8000";
export const LOCAL_WEB = "http://127.0.0.1:4173";
export const LOCAL_ARTIFACTS = "https://127.0.0.1:8443";

/** Do not import application credentials or implicit libpq defaults into fixtures.
 * @param {NodeJS.ProcessEnv} source
 */
export function localEnvironment(source) {
  /** @type {NodeJS.ProcessEnv} */
  const result = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "DENO_DIR",
    "XDG_CACHE_HOME",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "RADA_LOCAL_COLIMA_TUNNEL",
  ]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

/** Fixed fixture identities still pass the normal server HMAC validator.
 * @param {101 | 102} [id]
 * @param {number} [timestamp]
 */
export function localLaunch(
  id = 101,
  timestamp = Math.floor(Date.now() / 1000),
) {
  const fields = new URLSearchParams({
    auth_date: String(timestamp),
    user: JSON.stringify({ id }),
  });
  const key = createHmac("sha256", "WebAppData").update(LOCAL_TOKEN).digest();
  const data = [...fields.entries()]
    .sort()
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  fields.set("hash", createHmac("sha256", key).update(data).digest("hex"));
  return fields.toString();
}

/** Fail before starting any child when another task owns a listener.
 * @param {number} port
 */
export async function requireFreePort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
  await new Promise((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve(undefined);
    }),
  );
}

/** @param {string} databaseUrl @param {string} username @param {string} password */
export function roleUrl(databaseUrl, username, password) {
  const url = new URL(databaseUrl);
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/rada_local"
  )
    throw new Error("Only the owned disposable local database is allowed");
  url.username = username;
  url.password = password;
  return url.toString();
}

/** Docker must resolve to a local socket, never a remote daemon.
 * @param {string} endpoint
 */
export function requireLocalDocker(endpoint) {
  if (
    !endpoint.startsWith("unix:///") &&
    !endpoint.startsWith("npipe:////./pipe/")
  )
    throw new Error("Local development requires a local Docker socket");
}

/** Verify the final host-forwarded database, not PostgreSQL's temporary init socket.
 * @param {string} databaseUrl @param {() => void} check
 */
export async function waitForDatabase(databaseUrl, check) {
  roleUrl(databaseUrl, "postgres", "fixture");
  for (let attempt = 0; attempt < 100; attempt++) {
    check();
    const client = new pg.Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1000,
      query_timeout: 1000,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return;
    } catch {
      /* The local VM's port forwarding may lag container readiness. */
    } finally {
      await client.end();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Host-forwarded local PostgreSQL did not become ready");
}
