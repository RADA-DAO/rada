import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { discoverMigrations } from "./migrations.mjs";

test("module discovery preserves global ledger order and source checksums", () => {
  const migrations = discoverMigrations();
  assert.deepEqual(
    migrations.slice(0, 3).map(({ name }) => name),
    ["0001_identity.sql", "0002_apps.sql", "0003_jpegpe.sql"],
  );
  assert.deepEqual(
    migrations
      .slice(0, 3)
      .map(({ path }) => basename(dirname(dirname(dirname(path))))),
    ["identity", "apps", "jpegpe"],
  );
  const names = migrations.map(({ name }) => name);
  assert.deepEqual(names, [...names].sort());
  assert.equal(
    new Set(names.map((name) => name.slice(0, 4))).size,
    names.length,
  );
  for (const migration of migrations) {
    assert.equal(
      migration.checksum,
      createHash("sha256").update(readFileSync(migration.path)).digest("hex"),
    );
  }
});

test("flat fixture discovery sorts versions and rejects duplicate or malformed names", () => {
  const directory = mkdtempSync(join(tmpdir(), "rada-migrations-unit-"));
  try {
    writeFileSync(join(directory, "0002_second.sql"), "SELECT 2;\n");
    writeFileSync(join(directory, "0001_first.sql"), "SELECT 1;\n");
    assert.deepEqual(
      discoverMigrations(directory).map(({ name }) => name),
      ["0001_first.sql", "0002_second.sql"],
    );
    writeFileSync(join(directory, "0001_duplicate.sql"), "SELECT 3;\n");
    assert.throws(
      () => discoverMigrations(directory),
      /unique four-digit versions/,
    );
    rmSync(join(directory, "0001_duplicate.sql"));
    writeFileSync(join(directory, "invalid.sql"), "SELECT 3;\n");
    assert.throws(
      () => discoverMigrations(directory),
      /unique four-digit versions/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
