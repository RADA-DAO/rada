import { discoverMigrations, moduleDirectories } from "./migrations.mjs";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  appendFileSync,
  rmSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const migrations = discoverMigrations();
const migrationNames = migrations.map(({ name }) => name);
const nextVersion =
  Math.max(...migrationNames.map((name) => Number(name.slice(0, 4)))) + 1;
assert.ok(
  nextVersion <= 9999,
  "No migration version available for a rollback fixture",
);
const fixtureName = `${String(nextVersion).padStart(4, "0")}_fixture.sql`;
/** @param {string[]} args @param {boolean} [success] */
function migrate(args = [], success = true) {
  const result = spawnSync(
    process.execPath,
    ["tools/db-migrate.mjs", ...args],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status === 0, success, result.stderr);
  return result;
}
// Seed the legacy flat-layout ledger before switching to module discovery.
const legacy = mkdtempSync(join(tmpdir(), "rada-legacy-migrations-"));
try {
  for (const migration of migrations)
    copyFileSync(migration.path, join(legacy, migration.name));
  migrate([legacy]);
} finally {
  rmSync(legacy, { recursive: true, force: true });
}
const container = process.env.PG_CONTAINER;
const args = container ? ["exec", "-i", container, "psql"] : [];
args.push(
  "-X",
  "--no-password",
  "-v",
  "ON_ERROR_STOP=1",
  "-q",
  "-U",
  process.env.PGUSER ?? "postgres",
  "-d",
  process.env.PGDATABASE ?? "rada_test",
);
for (const directory of moduleDirectories()) {
  for (const name of readdirSync(join(directory, "db"))
    .filter((name) => name.endsWith(".test.sql"))
    .sort()) {
    const result = spawnSync(container ? "docker" : "psql", args, {
      input: readFileSync(join(directory, "db", name)),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
}
const temporary = mkdtempSync(join(tmpdir(), "rada-migration-test-"));
try {
  for (const migration of migrations)
    copyFileSync(migration.path, join(temporary, migration.name));
  // A pre-existing flat-layout ledger must remain identical after module discovery.
  const ledgerQuery =
    "SELECT name, checksum, applied_at FROM platform_migrations.applied ORDER BY name;";
  const before = spawnSync(container ? "docker" : "psql", args, {
    input: ledgerQuery,
    encoding: "utf8",
  });
  assert.equal(before.status, 0, before.stderr);
  migrate();
  migrate();
  migrate([temporary]);
  const after = spawnSync(container ? "docker" : "psql", args, {
    input: ledgerQuery,
    encoding: "utf8",
  });
  assert.equal(after.status, 0, after.stderr);
  assert.equal(
    after.stdout,
    before.stdout,
    "Moving migration sources changed the existing ledger",
  );
  appendFileSync(
    join(temporary, "0001_identity.sql"),
    "\n-- changed fixture\n",
  );
  const mismatch = migrate([temporary], false);
  assert.match(mismatch.stderr, /Migration checksum mismatch/);
  rmSync(join(temporary, "0001_identity.sql"));
  appendFileSync(join(temporary, fixtureName), "SELECT 1;\n");
  assert.match(
    migrate([temporary], false).stderr,
    /Applied migration missing from source/,
  );
  copyFileSync(
    migrations.find(({ name }) => name === "0001_identity.sql")?.path ?? "",
    join(temporary, "0001_identity.sql"),
  );
  appendFileSync(join(temporary, "0000_fixture.sql"), "SELECT 1;\n");
  assert.match(migrate([temporary], false).stderr, /Out-of-order migration/);
  rmSync(join(temporary, "0000_fixture.sql"));
  rmSync(join(temporary, fixtureName));
  appendFileSync(
    join(temporary, fixtureName),
    "CREATE TABLE identity.rollback_fixture(id integer); SELECT 1 / 0;\n",
  );
  assert.match(migrate([temporary], false).stderr, /division by zero/);
  const rollback = spawnSync(container ? "docker" : "psql", args, {
    input: `DO $$ BEGIN IF to_regclass('identity.rollback_fixture') IS NOT NULL OR EXISTS (SELECT 1 FROM platform_migrations.applied WHERE name = '${fixtureName}') THEN RAISE EXCEPTION 'Failed migration did not roll back'; END IF; END $$;`,
    encoding: "utf8",
  });
  assert.equal(rollback.status, 0, rollback.stderr);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
migrate();
console.log(
  "PostgreSQL 17 module isolation, constraints, repeat-run and checksum checks passed.",
);
