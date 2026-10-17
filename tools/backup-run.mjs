import { spawn } from "node:child_process";
import { promises as fs, createReadStream } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { sanitizeStderr } from "./backup-diagnostics.mjs";
import { retention, parseReceipt } from "./backup-policy.mjs";

process.umask(0o077);
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const state = resolve(process.env.BACKUP_STATE ?? "/var/lib/rada-backup");
const config = resolve(process.env.BACKUP_CONFIG ?? "/etc/rada-backup");
const image = process.env.BACKUP_IMAGE;
const network = process.env.BACKUP_NETWORK;
const hook = process.env.BACKUP_COPY_HOOK;
const prefix = `rada-backup-${randomUUID()}`;
const work = join(state, "work");
let log = Buffer.alloc(0);
let locked = false;
/** @type {import("node:child_process").ChildProcess | undefined} */
let active;
let interrupted = false;
const secrets = Object.entries(process.env)
  .filter(([name]) => /password|secret|token|key|url|dsn/i.test(name))
  .flatMap(([, value]) => (value ? [value] : []));
/** @param {string} value */
const sanitize = (value) => sanitizeStderr(value, secrets);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    interrupted = true;
    active?.kill("SIGTERM");
  });

/** @param {Buffer} chunk */
function record(chunk) {
  log = Buffer.concat([log, Buffer.from(sanitize(chunk.toString()))]).subarray(
    -1024 * 1024,
  );
}
/** @param {string} command @param {string[]} args @param {string} [input] */
async function run(command, args, input) {
  if (interrupted) throw new Error("Interrupted");
  return await new Promise(
    /** @param {(value: string) => void} accept */ (accept, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      });
      active = child;
      let output = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      const timer = setTimeout(() => child.kill("SIGKILL"), 25 * 60 * 1000);
      child.stdout.on("data", (/** @type {Buffer} */ chunk) => {
        output = Buffer.concat([output, chunk]).subarray(-1024 * 1024);
      });
      child.stderr.on("data", (/** @type {Buffer} */ chunk) => {
        stderr = Buffer.concat([stderr, chunk]).subarray(-64 * 1024);
      });
      child.stdin.on("error", () => {});
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(
          new Error(
            `exit=unavailable ${"code" in error ? String(error.code) : "spawn-error"}`,
          ),
        );
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        active = undefined;
        if (code !== 0 || interrupted) {
          const detail = sanitize(stderr.toString());
          const marker = /BACKUP_STAGE=(snapshot|encrypt|round-trip)\b/.exec(
            detail,
          );
          if (marker?.[1]) phase = marker[1];
          reject(
            new Error(
              `exit=${String(code)}${signal ? ` signal=${signal}` : ""}\n${detail}`,
            ),
          );
        } else accept(output.toString());
      });
      child.stdin.end(input);
    },
  );
}
/** @param {string[]} args @param {string} [input] */
const docker = (args, input) => run("docker", args, input);
const sandbox = `${prefix}-verify`;
const capture = `${prefix}-capture`;
let failed = false;
let successLine;
let phase = "snapshot";
let failureLine = "";
try {
  if (!image || !/^sha256:[a-f0-9]{64}$/.test(image) || !network || !hook)
    throw new Error("Missing configuration");
  // Read only for redaction; never execute configuration on the host.
  for (const file of ["source.env"]) {
    const content = await fs.readFile(join(config, file), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const value = line
        .slice(line.indexOf("=") + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      if (value && !line.startsWith("#")) secrets.push(value);
    }
  }
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  await fs.chmod(state, 0o700);
  await fs.mkdir(join(state, "lock"));
  locked = true;
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { mode: 0o700 });
  const archives = join(state, "archives");
  await fs.mkdir(archives, { recursive: true, mode: 0o700 });
  await fs.chmod(archives, 0o700);
  const stamp = new Date()
    .toISOString()
    .replace(/:/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const name = `${stamp}.tar.age`;
  phase = "snapshot";
  await docker([
    "run",
    "--name",
    capture,
    "--log-driver",
    "none",
    "--network",
    network,
    "--read-only",
    "--tmpfs",
    "/tmp",
    // Bind-mounted private files belong to the invoking user. With all
    // capabilities dropped, container root cannot bypass their 0700/0600 modes.
    "--user",
    `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${config}:/config:ro`,
    "-v",
    `${work}:/work`,
    "--entrypoint",
    "bash",
    image,
    "/backup/capture.sh",
  ]);
  phase = "restore";
  // The same pinned image, no TCP connectivity, no host data mounts or app processes.
  await docker([
    "run",
    "-d",
    "--name",
    sandbox,
    "--network",
    "none",
    "--log-driver",
    "none",
    "--tmpfs",
    "/var/lib/postgresql/data:rw",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e",
    "POSTGRES_DB=verify",
    image,
    "-c",
    "listen_addresses=",
    "-c",
    "shared_preload_libraries=",
  ]);
  await docker([
    "exec",
    sandbox,
    "bash",
    "-c",
    "for i in {1..60}; do pg_isready -U postgres -d verify >/dev/null && exit 0; sleep 1; done; exit 1",
  ]);
  await docker(["cp", `${work}/restored/.`, `${sandbox}:/tmp/backup`]);
  await docker([
    "exec",
    sandbox,
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "verify",
    "-f",
    "/tmp/backup/verify-roles.sql",
  ]);
  phase = "restore";
  await docker([
    "exec",
    sandbox,
    "pg_restore",
    "--exit-on-error",
    "--no-owner",
    "-U",
    "postgres",
    "-d",
    "verify",
    "/tmp/backup/database.dump",
  ]);
  phase = "compare";
  await docker([
    "exec",
    sandbox,
    "bash",
    "-c",
    "psql -XqAt -v ON_ERROR_STOP=1 -U postgres -d verify -f /backup/counts.sql > /tmp/actual.jsonl",
  ]);
  await docker(["cp", `${sandbox}:/tmp/actual.jsonl`, `${work}/actual.jsonl`]);
  phase = "compare";
  const expected = await fs.readFile(join(work, "restored/counts.jsonl"));
  if (!expected.equals(await fs.readFile(join(work, "actual.jsonl"))))
    throw new Error("Inventory or counts differ");
  const candidate = join(work, "candidate.tar.age");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(candidate)) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Invalid file chunk");
    hash.update(chunk);
  }
  const digest = hash.digest("hex");
  // Hook must durably copy and verify this encrypted file; failure preserves all history.
  phase = "copy";
  await run(hook, [candidate, name, digest]);
  const receipt = parseReceipt(
    JSON.stringify({
      version: 1,
      status: "verified",
      archive: name,
      sha256: digest,
    }),
  );
  phase = "publish";
  await fs.link(candidate, join(archives, name));
  await fs.writeFile(
    join(state, "receipt.tmp"),
    `${JSON.stringify(receipt)}\n`,
  );
  await fs.rename(join(state, "receipt.tmp"), join(state, "last-success.json"));
  const names = (await fs.readdir(archives)).filter((entry) =>
    entry.endsWith(".tar.age"),
  );
  for (const obsolete of retention(names))
    await fs.unlink(join(archives, obsolete));
  successLine = JSON.stringify(receipt);
} catch (error) {
  const detail = error instanceof Error ? error.message : "Unknown failure";
  failureLine = `RADA_BACKUP_FAILED stage=${phase} ${detail.startsWith("exit=") ? detail : `exit=n/a\n${sanitize(detail)}`}`;
  record(Buffer.from(`${failureLine}\nBACKUP_PHASE=${phase}\n`));
  failed = true;
} finally {
  // Cleanup also on timeouts/signals; do not leave plaintext or disposable databases.
  interrupted = false;
  for (const name of [capture, sandbox]) {
    try {
      await docker(["rm", "-fv", name]);
    } catch {
      /* May not have been created. */
    }
  }
  try {
    if (locked) {
      await fs.writeFile(join(state, "last-run.log"), log, { mode: 0o600 });
      await fs.rm(work, { recursive: true, force: true });
      await fs.rmdir(join(state, "lock"));
    }
  } catch {
    failed = true;
  }
}
if (failed) {
  console.error(
    failureLine || `RADA_BACKUP_FAILED stage=publish exit=n/a\nCleanup failed`,
  );
  process.exitCode = 1;
}

if (!failed && successLine) console.log(successLine);
