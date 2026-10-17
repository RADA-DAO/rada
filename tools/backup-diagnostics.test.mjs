import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeStderr } from "./backup-diagnostics.mjs";

await test("diagnostics keep useful stderr while redacting credentials and keys", () => {
  const safe = sanitizeStderr(
    [
      "psql: connection failed: password authentication failed",
      "postgresql://operator:private@db.example/rada",
      "PGPASSWORD='private password'",
      "host=db.example user=postgres password='private password'",
      "AGE-SECRET-KEY-1ABCDEF",
      "age1abcd1234",
      "-----BEGIN PRIVATE KEY-----\nprivate bytes\n-----END PRIVATE KEY-----",
      "echoed configured-password",
      "pg_restore: error: input file is too short",
    ].join("\n"),
    ["configured-password"],
  );
  for (const secret of [
    "private",
    "operator",
    "db.example",
    "AGE-SECRET",
    "age1",
    "configured-password",
  ])
    assert.ok(!safe.includes(secret));
  assert.match(safe, /password authentication failed/);
  assert.match(safe, /pg_restore: error: input file is too short/);
});

await test("diagnostics bound stderr lines and remove terminal control characters", () => {
  const safe = sanitizeStderr(
    Array.from({ length: 50 }, (_, i) => `line ${String(i)}\x1b`).join("\n"),
  );
  assert.equal(safe.split("\n").length, 20);
  assert.ok(safe.startsWith("line 30"));
  assert.ok(!safe.includes("\x1b"));
  assert.equal(sanitizeStderr("x".repeat(10000)).length, 500);
});
