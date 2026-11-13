import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModuleApi } from "../../../../packages/platform-sdk/src/index.ts";
import type { Appeal, ReputationItem, Summary } from "../../contract.ts";
import { reputationClient } from "../client.ts";
import { ReputationError } from "../model.ts";
const instant = "2026-11-13T12:00:00.000Z";
const snapshot: { summary: Summary; item: ReputationItem; appeals: Appeal[] } =
  {
    summary: {
      version: 1,
      revision: "4",
      period: "week",
      start: instant,
      end: instant,
      totalPoints: "2.5",
      lifetimePoints: "2.5",
      pendingCount: 0,
      categories: [{ category: "help", points: "2.5" }],
      updatedAt: instant,
    },
    item: {
      id: "synthetic-item",
      title: "Synthetic result",
      category: "help",
      points: "2.5",
      status: "accepted",
      reason: "Synthetic evidence",
      occurredAt: instant,
      recordedAt: instant,
      ruleHash: null,
      evidence: [],
      missionId: null,
    },
    appeals: [
      {
        id: "synthetic-appeal",
        itemId: "synthetic-item",
        message: "Synthetic review",
        status: "open",
        resolution: null,
        createdAt: instant,
      },
    ],
  };
function client(body: unknown, status = 200, calls: string[] = []) {
  const api: ModuleApi = {
    url: (path) => path,
    request: (method, path) => {
      calls.push(`${method} ${path}`);
      return Promise.resolve({ status, body, retryAfter: null });
    },
  };
  return reputationClient(api, new AbortController().signal);
}
await test("detail loads the selected period, result and appeals in one atomic read", async () => {
  const calls: string[] = [];
  const result = await client(snapshot, 200, calls).detail(
    "synthetic-item",
    "week",
  );
  assert.deepEqual(calls, [
    "GET /v1/reputation/detail/synthetic-item?period=week",
  ]);
  assert.deepEqual(result, {
    summary: snapshot.summary,
    data: snapshot.item,
    appeals: snapshot.appeals,
  });
});
await test("detail rejects an unavailable result, malformed snapshot and mismatched identity", async () => {
  await assert.rejects(
    client(null, 404).detail("synthetic-item", "week"),
    (error: unknown) =>
      error instanceof ReputationError && error.status === 404,
  );
  for (const invalid of [
    { ...snapshot, appeals: null },
    { ...snapshot, summary: { ...snapshot.summary, period: "today" } },
    { ...snapshot, item: { ...snapshot.item, id: "different" } },
    { ...snapshot, appeals: [{ ...snapshot.appeals[0], itemId: "different" }] },
  ])
    await assert.rejects(
      client(invalid).detail("synthetic-item", "week"),
      ReputationError,
    );
});
