// Run only against the disposable test database after tools/db-test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReceipt } from "./backup-policy.mjs";

/** @param {string} cmd @param {string[]} args @param {object} [options] */
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const source = process.env.PG_CONTAINER;
assert.ok(
  source,
  "Set PG_CONTAINER to the CI/disposable test Postgres container",
);
assert.equal(process.env.PGDATABASE ?? "rada_test", "rada_test");
const base = mkdtempSync(join(tmpdir(), "rada-backup-test-"));
try {
  const config = join(base, "config");
  const state = join(base, "state");
  mkdirSync(config, { mode: 0o700 });
  const tag = "rada-backup:rehearsal";
  run("docker", [
    "build",
    "-f",
    "infra/compose/backups/Dockerfile",
    "-t",
    tag,
    ".",
  ]);
  const image = run("docker", ["image", "inspect", "--format", "{{.Id}}", tag]);
  run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${config}:/config`,
    "--user",
    `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
    "--entrypoint",
    "age-keygen",
    image,
    "-o",
    "/config/identity.txt",
  ]);
  const recipient = run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${config}:/config`,
    "--user",
    `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`,
    "--entrypoint",
    "age-keygen",
    image,
    "-y",
    "/config/identity.txt",
  ]);
  writeFileSync(join(config, "recipients.txt"), `${recipient}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    join(config, "source.env"),
    "PGHOST=source\nPGUSER=postgres\nPGDATABASE=rada_test\nPGPASSWORD=fixture-password\n",
    { mode: 0o600 },
  );
  // A dedicated internal network reaches only the disposable source.
  const network = `rada-backup-test-${String(process.pid)}`;
  run("docker", ["network", "create", "--internal", network]);
  try {
    run("docker", ["network", "connect", "--alias", "source", network, source]);
    run("docker", [
      "exec",
      source,
      "psql",
      "-U",
      "postgres",
      "-d",
      "rada_test",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      'DROP SCHEMA IF EXISTS backup_fixture CASCADE; CREATE SCHEMA backup_fixture; CREATE TABLE backup_fixture."quoted table" (id int) PARTITION BY RANGE(id); CREATE TABLE backup_fixture.leaf PARTITION OF backup_fixture."quoted table" FOR VALUES FROM (0) TO (10); INSERT INTO backup_fixture."quoted table" VALUES (1),(2); CREATE TABLE backup_fixture.empty(id int);',
    ]);
    const hook = join(base, "copy-hook");
    writeFileSync(
      hook,
      '#!/bin/sh\nset -eu\ncp "$1" "$(dirname "$0")/offhost-$2"\n',
      { mode: 0o700 },
    );
    const env = {
      ...process.env,
      BACKUP_CONFIG: config,
      BACKUP_STATE: state,
      BACKUP_IMAGE: image,
      BACKUP_NETWORK: network,
      BACKUP_COPY_HOOK: hook,
    };
    const receipt = parseReceipt(
      run(process.execPath, ["tools/backup-run.mjs"], { env }),
    );
    assert.equal(
      readFileSync(join(state, "last-success.json"), "utf8").trim(),
      JSON.stringify(receipt),
    );
    const before = readdirSync(join(state, "archives"));
    // Capture failures report the inner stage, not just the outer docker run.
    for (const [stage, file, contents] of [
      [
        "snapshot",
        "source.env",
        "PGHOST=source\nPGPORT=1\nPGCONNECT_TIMEOUT=2\nPGUSER=postgres\nPGDATABASE=rada_test\nPGPASSWORD=fixture-password\n",
      ],
      ["encrypt", "recipients.txt", "invalid-recipient\n"],
      ["round-trip", "identity.txt", "AGE-SECRET-KEY-1INVALIDTESTKEY\n"],
    ]) {
      assert.ok(stage && file && contents);
      const path = join(config, file);
      // Read key material only in memory, never include it in assertion messages.
      const original = readFileSync(path);
      try {
        writeFileSync(path, contents);
        const failure = spawnSync(process.execPath, ["tools/backup-run.mjs"], {
          env,
          encoding: "utf8",
        });
        assert.equal(failure.status, 1);
        assert.match(
          failure.stderr,
          new RegExp(`^RADA_BACKUP_FAILED stage=${stage} exit=[1-9]`),
        );
        assert.ok(!failure.stderr.includes("fixture-password"));
        assert.ok(!failure.stderr.includes("AGE-SECRET-KEY-"));
        assert.equal(failure.stdout, "");
        assert.deepEqual(readdirSync(join(state, "archives")), before);
        assert.equal(
          readFileSync(join(state, "last-success.json"), "utf8").trim(),
          JSON.stringify(receipt),
        );
      } finally {
        writeFileSync(path, original);
      }
    }
    // Fault injection only in disposable test images: restore errors and a
    // mismatched inventory must block publication before the copy hook.
    for (const [kind, file] of [
      ["restore", "database.dump"],
      ["compare", "counts.jsonl"],
    ]) {
      assert.ok(kind && file);
      const badTag = `rada-backup:bad-${kind}`;
      run("docker", ["build", "-t", badTag, "-"], {
        input: `FROM ${tag}\nRUN printf '\\ntruncate -s 0 /work/restored/${file}\\n' >> /backup/capture.sh\n`,
      });
      const badImage = run("docker", [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        badTag,
      ]);
      const failure = spawnSync(process.execPath, ["tools/backup-run.mjs"], {
        env: { ...env, BACKUP_IMAGE: badImage },
        encoding: "utf8",
      });
      assert.equal(failure.status, 1);
      assert.match(
        failure.stderr,
        new RegExp(
          `^RADA_BACKUP_FAILED stage=${kind} exit=${kind === "restore" ? "1" : "n/a"}\\n`,
        ),
      );
      assert.equal(failure.stdout, "");
      assert.ok(
        readFileSync(join(state, "last-run.log"), "utf8").includes(
          `BACKUP_PHASE=${kind}`,
        ),
      );
      assert.deepEqual(readdirSync(join(state, "archives")), before);
      assert.equal(
        parseReceipt(readFileSync(join(state, "last-success.json"), "utf8"))
          .archive,
        receipt.archive,
      );
    }
    // A failed off-host copy must preserve the last receipt and every existing archive.
    writeFileSync(
      hook,
      '#!/bin/sh\ni=0; while [ "$i" -lt 30 ]; do echo "copy failed: $PGPASSWORD" >&2; i=$((i+1)); done\nexit 23\n',
      { mode: 0o700 },
    );
    const failure = spawnSync(process.execPath, ["tools/backup-run.mjs"], {
      env,
      encoding: "utf8",
    });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /^RADA_BACKUP_FAILED stage=copy exit=23/);
    assert.equal(failure.stdout, "");
    assert.ok(!failure.stderr.includes("fixture-password"));
    assert.ok(failure.stderr.trim().split("\n").length <= 21);
    assert.ok(
      !readFileSync(join(state, "last-run.log"), "utf8").includes(
        "fixture-password",
      ),
    );
    assert.ok(
      readFileSync(join(state, "last-run.log"), "utf8").includes(
        "BACKUP_PHASE=copy",
      ),
    );
    assert.deepEqual(readdirSync(join(state, "archives")), before);
    assert.equal(
      parseReceipt(readFileSync(join(state, "last-success.json"), "utf8"))
        .archive,
      receipt.archive,
    );
    assert.ok(readFileSync(join(state, "last-run.log")).length <= 1024 * 1024);
    assert.ok(!readdirSync(state).includes("work"));
    console.log(
      "Encrypted backup, isolated restore, exact partition counts and failed-copy preservation passed.",
    );
  } finally {
    run("docker", [
      "exec",
      source,
      "psql",
      "-U",
      "postgres",
      "-d",
      "rada_test",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "DROP SCHEMA IF EXISTS backup_fixture CASCADE;",
    ]);
    run("docker", ["network", "disconnect", network, source]);
    run("docker", ["network", "rm", network]);
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}
