import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const directory =
  process.argv[2] ??
  fileURLToPath(new URL("../db/migrations", import.meta.url));
const names = readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
if (
  !names.length ||
  names.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) ||
  new Set(names.map((name) => name.slice(0, 4))).size !== names.length
) {
  throw new Error(
    "Migrations require unique four-digit versions and SQL files",
  );
}
const migrations = names.map((name) => {
  const sql = readFileSync(resolve(directory, name), "utf8");
  return {
    name,
    sql,
    checksum: createHash("sha256").update(sql).digest("hex"),
  };
});
// One connection, transaction and lock cover validation, DDL and the ledger.
const sql = `BEGIN;
SELECT pg_advisory_xact_lock(726232441);
CREATE SCHEMA IF NOT EXISTS platform_migrations;
REVOKE ALL ON SCHEMA platform_migrations FROM PUBLIC;
CREATE TABLE IF NOT EXISTS platform_migrations.applied (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
DO $validation$ BEGIN
  IF EXISTS (SELECT 1 FROM platform_migrations.applied WHERE name NOT IN (${names.map((name) => `'${name}'`).join(",")})) THEN
    RAISE EXCEPTION 'Applied migration missing from source';
  END IF;
END $validation$;
${migrations
  .map(
    ({ name, sql, checksum }) => `
DO $validation$ BEGIN
  IF EXISTS (SELECT 1 FROM platform_migrations.applied WHERE name = '${name}' AND checksum <> '${checksum}') THEN
    RAISE EXCEPTION 'Migration checksum mismatch: ${name}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform_migrations.applied WHERE name = '${name}') AND EXISTS (SELECT 1 FROM platform_migrations.applied WHERE name > '${name}') THEN
    RAISE EXCEPTION 'Out-of-order migration: ${name}';
  END IF;
END $validation$;
SELECT NOT EXISTS (SELECT 1 FROM platform_migrations.applied WHERE name = '${name}') AS apply_migration \\gset
\\if :apply_migration
${sql}
INSERT INTO platform_migrations.applied(name, checksum) VALUES ('${name}', '${checksum}');
\\endif
`,
  )
  .join("\n")}
COMMIT;`;
const container = process.env.PG_CONTAINER;
const command = container ? "docker" : "psql";
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
const result = spawnSync(command, args, {
  input: sql,
  encoding: "utf8",
  stdio: ["pipe", "pipe", "pipe"],
});
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
console.log("Migrations verified and applied.");
