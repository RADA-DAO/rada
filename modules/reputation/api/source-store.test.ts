import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import {
  PostgresReputationSourceStore,
  type SourceFactInput,
} from "./source-store.ts";
const input: SourceFactInput = {
  source: "synthetic-raid",
  sourceKey: "synthetic-unit",
  title: "Observed participation",
  description: "Dated raw comments",
  occurredAt: "2026-01-01T00:00:00.123456Z",
  evidence: [
    {
      id: "a",
      url: "https://example.invalid/comment/1",
      label: "Observed comment",
    },
    {
      id: "b",
      url: "https://example.invalid/comment/2",
      label: "Observed comment",
    },
  ],
};
test("source ingress resolves server identity and preserves full proof set without points", async () => {
  const calls: unknown[][] = [];
  const auth = {
    query: (sql: string, values: unknown[]) => {
      assert.equal(
        sql,
        "SELECT identity.resolve_telegram($1::bigint) AS subject_id",
      );
      assert.deepEqual(values, ["1001"]);
      return Promise.resolve({ rows: [{ subject_id: "subject-uuid" }] });
    },
  } as unknown as pg.Pool;
  const ingress = {
    query: (sql: string, values: unknown[]) => {
      assert.match(sql, /^SELECT reputation.ingest_fact\(/);
      calls.push(values);
      return Promise.resolve({
        rows: [{ result: { item: { id: "item-uuid" } } }],
      });
    },
  } as unknown as pg.Pool;
  const store = new PostgresReputationSourceStore(auth, ingress);
  await store.record("1001", { ...input, points: "99999" } as SourceFactInput);
  assert.deepEqual(calls, [
    [
      "subject-uuid",
      input.source,
      input.sourceKey,
      input.title,
      input.description,
      input.occurredAt,
      JSON.stringify(input.evidence),
    ],
  ]);
});
test("source ingress rejects submicrosecond precision before authentication or database write", async () => {
  const never = {
    query: () => {
      throw new Error("must not touch database");
    },
  } as unknown as pg.Pool;
  const store = new PostgresReputationSourceStore(never, never);
  await assert.rejects(
    store.record("1001", {
      ...input,
      occurredAt: "2026-11-15T21:59:59.9999999Z",
    }),
    { code: "22023" },
  );
});
