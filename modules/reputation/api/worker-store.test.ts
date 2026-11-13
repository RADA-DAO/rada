import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { PostgresReputationWorkerStore } from "./worker-store.ts";

test("worker commits only frozen rule identity and attributed source, never points", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return Promise.resolve({ rows: [{ result: { state: "completed" } }] });
    },
  } as unknown as pg.Pool;
  const store = new PostgresReputationWorkerStore(pool);
  await store.commitReport("item", "lease", {
    rulesHash: "frozen-v1",
    ruleKey: "help",
    semanticKey: "occurrence",
    sourceId: "item",
    points: "99999",
    category: "work",
  } as Parameters<typeof store.commitReport>[2]);
  assert.deepEqual(calls, [
    {
      sql: "SELECT reputation.complete_report($1::uuid,$2::uuid,$3,$4,$5,$6) AS result",
      values: ["item", "lease", "frozen-v1", "help", "occurrence", "item"],
    },
  ]);
});
test("worker provider work is outside adapter queries; leases and retry use role functions", async () => {
  const calls: string[] = [];
  const pool = {
    query: (sql: string) => {
      calls.push(sql);
      return Promise.resolve({ rows: [{ result: null }] });
    },
  } as unknown as pg.Pool;
  const store = new PostgresReputationWorkerStore(pool);
  await store.claim(["interpretation"], 60);
  await store.rules("item", "lease", "hash");
  await store.saveProposal("item", "lease", {
    state: "needs_interpretation",
    reason: "Ambiguous report",
  });
  await store.retry("item", "lease", 300, "provider_unavailable");
  assert.equal(calls.length, 4);
  assert.ok(calls.every((sql) => !sql.includes("BEGIN")));
  assert.ok(calls.every((sql) => /^SELECT reputation\.[a-z_]+\(/.test(sql)));
});
