import pg from "pg";
import { writeFile } from "node:fs/promises";
import { readSource } from "./source.ts";
import { runImport, type Mode } from "./runner.ts";
const mode = process.argv[2] as Mode;
if (!["dry-run", "import", "verify"].includes(mode))
  throw new Error("Usage: main.ts dry-run|import|verify");
function url(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Explicit ${name} required`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${name}`);
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.pathname.length < 2
  )
    throw new Error(`Invalid ${name}`);
  return value;
}
// Explicit isolated-restore acknowledgement; no environment fallbacks or default hosts.
if (process.env.IMPORT_ISOLATED_RESTORE !== "yes")
  throw new Error("IMPORT_ISOLATED_RESTORE=yes required");
const sourceUrl = url("IMPORT_SOURCE_URL"),
  targetUrl = url("IMPORT_TARGET_URL");
if (sourceUrl === targetUrl)
  throw new Error("Source and target must be separate databases");
const source = new pg.Client({ connectionString: sourceUrl });
const target = new pg.Client({ connectionString: targetUrl });
try {
  await source.connect();
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const snapshot = await readSource(source);
  await source.query("COMMIT");
  await target.connect();
  await target.query("SET ROLE legacy_import");
  const report = await runImport(
    target,
    snapshot,
    mode,
    Number(process.env.IMPORT_BATCH_SIZE ?? 100),
  );
  const json = JSON.stringify(report, null, 2) + "\n";
  if (process.env.IMPORT_REPORT)
    await writeFile(process.env.IMPORT_REPORT, json, { mode: 0o600 });
  process.stdout.write(json);
  process.stderr.write(
    `${mode}: ${report.ok ? "ok" : "review required"}; ${String(report.conflicts.length)} conflicts; ` +
      Object.entries(report.entities)
        .map(([key, e]) => `${key} ${String(e.imported)}/${String(e.planned)}`)
        .join(", ") +
      "\n",
  );
  if (!report.ok) process.exitCode = 2;
} catch {
  // PostgreSQL error details can contain private source values and credentials.
  process.stderr.write(
    "Import failed; batch rolled back. Inspect isolated database with restricted access.\n",
  );
  process.exitCode = 1;
} finally {
  await source.end();
  await target.end();
}
