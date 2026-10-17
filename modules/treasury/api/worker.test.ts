// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import { test } from "node:test";
import type pg from "pg";
import { projectTreasury, treasuryWorkerEnabled } from "./worker.ts";
await test("worker is explicitly enabled and never runs in synthetic mode", () => {
  for (const mode of ["production", "allowlist", "synthetic"]) {
    assert.equal(treasuryWorkerEnabled(mode, undefined), false);
    assert.equal(treasuryWorkerEnabled(mode, "true"), mode !== "synthetic");
  }
});
await test("projection failure records a stale attempt and always releases the session lock", async () => {
  const calls: { sql: string; args?: unknown[] }[] = [];
  let released = false;
  const client = {
    query: async (sql: string, args?: unknown[]) => {
      calls.push({ sql, ...(args ? { args } : {}) });
      return {
        rows: sql.includes("try_advisory")
          ? [{ locked: true }]
          : sql.includes("wallets()")
            ? [{ address: "fixture", version: "1" }]
            : [],
      };
    },
    release: () => {
      released = true;
    },
  };
  await projectTreasury(
    { connect: async () => client } as unknown as pg.Pool,
    async () => {
      throw new Error("offline");
    },
  );
  assert.deepEqual(calls.find((c) => c.sql.includes("record("))?.args, [
    "fixture",
    "1",
    null,
  ]);
  assert.ok(calls.some((c) => c.sql.includes("advisory_unlock")));
  assert.equal(released, true);
});
