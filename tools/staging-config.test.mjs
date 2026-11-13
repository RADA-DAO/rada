import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

await test("Caddy entrypoint accepts only a plain DNS hostname before executing", () => {
  /** @param {string} hostname */
  const validate = (hostname) =>
    spawnSync(
      "sh",
      ["infra/compose/caddy-entrypoint.sh", "sh", "-c", "printf validated"],
      {
        encoding: "utf8",
        env: { ...process.env, STAGING_API_HOSTNAME: hostname },
      },
    );
  for (const hostname of [
    "api.staging.example.invalid",
    "192-0-2-1.sslip.io",
  ]) {
    const result = validate(hostname);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "validated");
  }
  for (const hostname of [
    "",
    "https://api.example",
    "api.example:443",
    "api.example/path",
    "api.example\n{\n}",
    "api.example {",
    "api. example",
    "api.example\t",
    "api..example",
    "-api.example",
    "api-.example",
    "api.example.",
    "a".repeat(64) + ".example",
    ("a".repeat(63) + ".").repeat(4) + "test",
  ]) {
    const result = validate(hostname);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Invalid staging API hostname\n");
  }
});

await test("migration seeds only explicit synthetic mode and rejects conflicts before writes", () => {
  const bin = mkdtempSync(join(tmpdir(), "rada-migrate-fixture-"));
  try {
    writeFileSync(join(bin, "deno"), '#!/bin/sh\nprintf "migration\\n"\n', {
      mode: 0o700,
    });
    writeFileSync(join(bin, "psql"), '#!/bin/sh\nprintf "%s\\n" "$*"\n', {
      mode: 0o700,
    });
    /** @param {string} mode @param {string} synthetic */
    const migrate = (mode, synthetic) =>
      spawnSync("sh", ["infra/compose/migrate.sh"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          STAGING_AUTH_MODE: mode,
          STAGING_SYNTHETIC_ONLY: synthetic,
        },
      });
    const fixture = migrate("synthetic", "true");
    assert.equal(fixture.status, 0);
    assert.match(fixture.stdout, /staging-seed\.sql/);
    const testers = migrate("allowlist", "false");
    assert.equal(testers.status, 0);
    assert.match(testers.stdout, /staging-bootstrap\.sql/);
    assert.doesNotMatch(testers.stdout, /staging-seed\.sql/);
    for (const [mode, synthetic] of [
      ["", "false"],
      ["allowlist", "true"],
      ["synthetic", "false"],
      ["unknown", "false"],
    ]) {
      assert.ok(mode !== undefined && synthetic !== undefined);
      const result = migrate(mode, synthetic);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
    }
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

await test("staging registry requires its own login and exact artifact origin configuration", () => {
  const compose = readFileSync("infra/compose/staging.yaml", "utf8");
  assert.match(compose, /APPS_PASSWORD: \$\{APPS_PASSWORD:\?[^}]+\}/);
  assert.match(
    compose,
    /APPS_SERVICE_DATABASE_URL: postgresql:\/\/staging_apps:\$\{APPS_PASSWORD:\?[^}]+\}@postgres:5432\/rada_staging/,
  );
  assert.match(
    compose,
    /APP_ARTIFACT_ORIGIN: \$\{APP_ARTIFACT_ORIGIN:\?[^}]+\}/,
  );
  const bootstrap = readFileSync("infra/compose/staging-bootstrap.sql", "utf8");
  assert.match(bootstrap, /\\getenv apps_password APPS_PASSWORD/);
  assert.match(
    bootstrap,
    /CREATE ROLE staging_apps LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/,
  );
  assert.match(bootstrap, /ALTER ROLE staging_apps PASSWORD :'apps_password'/);
  const grants = bootstrap
    .split("\n")
    .filter((line) => /GRANT .*TO staging_apps;/.test(line));
  assert.deepEqual(grants, [
    "GRANT apps_service TO staging_apps;",
    "GRANT CONNECT ON DATABASE rada_staging TO staging_apps;",
  ]);
  for (const file of ["tools/check-staging.sh", "tools/test-staging.sh"]) {
    const harness = readFileSync(file, "utf8");
    assert.match(harness, /APPS_PASSWORD=synthetic-apps-password/);
    assert.match(
      harness,
      /APP_ARTIFACT_ORIGIN=https:\/\/artifacts\.staging\.example\.invalid/,
    );
  }
});

await test("staging smoke cleanup is isolated even when configuration fails", () => {
  const bin = mkdtempSync(join(tmpdir(), "rada-staging-smoke-fixture-"));
  try {
    writeFileSync(
      join(bin, "docker"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS_FILE"\ncase "$*" in *" config --quiet") exit 7;; esac\n',
      { mode: 0o700 },
    );
    const projects = [];
    for (const iteration of [1, 2]) {
      const calls = join(bin, `calls-${String(iteration)}`);
      const result = spawnSync("sh", ["tools/test-staging.sh"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          CALLS_FILE: calls,
        },
      });
      assert.equal(result.status, 7);
      const lines = readFileSync(calls, "utf8").trim().split("\n");
      assert.equal(lines.length, 2);
      const project = lines[0]?.match(/compose -p ([a-z0-9-]+) /)?.[1];
      assert.ok(project !== undefined);
      assert.ok(project.startsWith("rada-staging-smoke-"));
      assert.match(lines[1] ?? "", / down --volumes --remove-orphans$/);
      assert.ok(lines.every((line) => line.includes(`compose -p ${project} `)));
      projects.push(project);
    }
    assert.notEqual(projects[0], projects[1]);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
