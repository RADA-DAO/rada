import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { PostgresReputationStore } from "./store.ts";

test("overview uses one read-only repeatable snapshot and transaction-local identity", async () => {
  const subject = "00000000-0000-4000-8000-000000000001";
  const queries: { sql: string; values: unknown[] | undefined }[] = [];
  let releases = 0;
  const expected = {
    summary: { revision: "3" },
    page: { items: [], nextCursor: null },
  };
  const auth = {
    query: (sql: string, values: unknown[]) => {
      assert.equal(
        sql,
        "SELECT identity.resolve_telegram($1::bigint) AS subject_id",
      );
      assert.deepEqual(values, ["12345"]);
      return Promise.resolve({ rows: [{ subject_id: subject }] });
    },
  } as unknown as pg.Pool;
  const client = {
    query: (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return Promise.resolve({ rows: [{ result: expected }] });
    },
    release: () => {
      releases++;
    },
  };
  const store = new PostgresReputationStore(auth, {
    connect: () => Promise.resolve(client),
  } as unknown as pg.Pool);
  assert.deepEqual(
    await store.overview("12345", "history", "today", null),
    expected,
  );
  assert.deepEqual(queries, [
    {
      sql: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      values: undefined,
    },
    { sql: "SELECT set_config('rada.subject_id',$1,true)", values: [subject] },
    {
      sql: "SELECT reputation.overview($1,$2,$3) AS result",
      values: ["history", "today", null],
    },
    { sql: "COMMIT", values: undefined },
  ]);
  assert.equal(releases, 1);
  await store.dispose();
});

test("failed snapshot rolls back and returns only its own pooled client", async () => {
  const queries: string[] = [];
  let releases = 0;
  const auth = {
    query: () =>
      Promise.resolve({
        rows: [{ subject_id: "00000000-0000-4000-8000-000000000001" }],
      }),
  } as unknown as pg.Pool;
  const client = {
    query: (sql: string) => {
      queries.push(sql);
      return sql.includes("reputation.overview")
        ? Promise.reject(new Error("synthetic SQL error"))
        : Promise.resolve({ rows: [] });
    },
    release: () => {
      releases++;
    },
  };
  const store = new PostgresReputationStore(auth, {
    connect: () => Promise.resolve(client),
  } as unknown as pg.Pool);
  await assert.rejects(
    store.overview("12345", "tasks", "today", null),
    /synthetic SQL error/,
  );
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(releases, 1);
  await store.dispose();
});
