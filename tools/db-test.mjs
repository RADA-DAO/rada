import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  appendFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
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
migrate();
migrate();
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
const result = spawnSync(container ? "docker" : "psql", args, {
  input: readFileSync(join(root, "db/identity.test.sql")),
  encoding: "utf8",
});
assert.equal(result.status, 0, result.stderr);
const temporary = mkdtempSync(join(tmpdir(), "rada-migration-test-"));
try {
  cpSync(join(root, "db/migrations"), temporary, { recursive: true });
  appendFileSync(
    join(temporary, "0001_identity.sql"),
    "\n-- changed fixture\n",
  );
  const mismatch = migrate([temporary], false);
  assert.match(mismatch.stderr, /Migration checksum mismatch/);
  rmSync(join(temporary, "0001_identity.sql"));
  appendFileSync(join(temporary, "0002_fixture.sql"), "SELECT 1;\n");
  assert.match(
    migrate([temporary], false).stderr,
    /Applied migration missing from source/,
  );
  cpSync(
    join(root, "db/migrations/0001_identity.sql"),
    join(temporary, "0001_identity.sql"),
  );
  appendFileSync(join(temporary, "0000_fixture.sql"), "SELECT 1;\n");
  assert.match(migrate([temporary], false).stderr, /Out-of-order migration/);
  rmSync(join(temporary, "0000_fixture.sql"));
  rmSync(join(temporary, "0002_fixture.sql"));
  appendFileSync(
    join(temporary, "0002_fixture.sql"),
    "CREATE TABLE identity.rollback_fixture(id integer); SELECT 1 / 0;\n",
  );
  assert.match(migrate([temporary], false).stderr, /division by zero/);
  const rollback = spawnSync(container ? "docker" : "psql", args, {
    input:
      "DO $$ BEGIN IF to_regclass('identity.rollback_fixture') IS NOT NULL OR EXISTS (SELECT 1 FROM platform_migrations.applied WHERE name = '0002_fixture.sql') THEN RAISE EXCEPTION 'Failed migration did not roll back'; END IF; END $$;",
    encoding: "utf8",
  });
  assert.equal(rollback.status, 0, rollback.stderr);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
migrate();
console.log(
  "PostgreSQL 17 identity isolation, constraints, repeat-run and checksum checks passed.",
);
