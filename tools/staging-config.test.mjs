import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Caddy entrypoint accepts only a plain DNS hostname before executing", () => {
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

test("migration seeds only explicit synthetic mode and rejects conflicts before writes", () => {
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
          PATH: `${bin}:${process.env.PATH}`,
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
      const result = migrate(mode, synthetic);
      assert.equal(result.status, 2);
      assert.equal(result.stdout, "");
    }
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
