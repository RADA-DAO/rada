import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { registerReputationRoutes, validReport } from "./router.ts";
import type { Changes, ReputationStore } from "../contract.ts";

function fixture(store: Partial<ReputationStore> = {}) {
  const calls: boolean[] = [];
  const app = new Hono();
  registerReputationRoutes(app, store as ReputationStore, (c, privileged) => {
    calls.push(privileged);
    return Promise.resolve(
      c.req.header("authorization") === "verified" ? "12345" : null,
    );
  });
  return { app, calls };
}
const headers = {
  authorization: "verified",
  "content-type": "application/json",
};
test("all private read and command paths deny unverified launches", async () => {
  const { app } = fixture();
  for (const path of [
    "summary",
    "missions",
    "items",
    "items/00000000-0000-4000-8000-000000000001",
    "commands/r",
    "changes",
    "stream",
    "items/00000000-0000-4000-8000-000000000001/appeals",
  ]) {
    assert.equal((await app.request(`/v1/reputation/${path}`)).status, 401);
  }
  for (const path of [
    "reports",
    "missions/00000000-0000-4000-8000-000000000001/verify",
    "items/00000000-0000-4000-8000-000000000001/appeals",
  ]) {
    assert.equal(
      (
        await app.request(`/v1/reputation/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
  }
});
test("unknown fields, public identity and points overrides are rejected before store", async () => {
  let writes = 0;
  const { app, calls } = fixture({
    report: () => {
      writes++;
      return Promise.reject(new Error("must not reach store"));
    },
  });
  const input = {
    requestId: "report-1",
    title: "Synthetic work",
    description: "Completed concrete work",
    occurredAt: "2026-01-01T00:00:00Z",
  };
  for (const extra of [
    { actor: "999" },
    { points: "100" },
    { completed: true },
    { evidenceUrl: "http://example.invalid" },
    { evidenceUrl: "https://user:secret@example.invalid" },
  ]) {
    assert.equal(
      (
        await app.request("/v1/reputation/reports", {
          method: "POST",
          headers,
          body: JSON.stringify({ ...input, ...extra }),
        })
      ).status,
      400,
    );
  }
  assert.equal(writes, 0);
  assert.ok(calls.every(Boolean));
  assert.equal(validReport(input), true);
  const res = await app.request("/v1/reputation/reports", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json-fake" },
    body: JSON.stringify(input),
  });
  assert.equal(res.status, 415);
});
test("read selectors are bounded and SQL conflicts map to HTTP conflict", async () => {
  const { app, calls } = fixture({
    verify: () => {
      throw Object.assign(new Error("private DB detail"), { code: "23505" });
    },
  });
  for (const path of [
    "summary?period=unknown",
    "changes?after=-1",
    "changes?after=9223372036854775808",
    "items?cursor=bad",
    "missions?cursor=bad",
  ]) {
    assert.equal(
      (await app.request(`/v1/reputation/${path}`, { headers })).status,
      400,
    );
  }
  const res = await app.request(
    "/v1/reputation/missions/00000000-0000-4000-8000-000000000001/verify",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ requestId: "r", missionVersion: 1 }),
    },
  );
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "conflict" });
  assert.deepEqual(calls, [false, false, false, false, false, true]);
});
test("SSE multiplexes same actor, recovers durable changes and releases on abort", async () => {
  let reads = 0;
  const delta: Changes = {
    version: 1,
    changes: [
      {
        revision: "1",
        type: "item",
        itemId: "00000000-0000-4000-8000-000000000001",
        recordedAt: "2026-01-01T00:00:00Z",
      },
    ],
    nextCursor: "1",
    hasMore: false,
    resetRequired: false,
  };
  const { app } = fixture({
    changes: async (actor) => {
      assert.equal(actor, "12345");
      reads++;
      await new Promise((r) => setTimeout(r, 10));
      return delta;
    },
  });
  const aborts = [new AbortController(), new AbortController()];
  const responses = await Promise.all(
    aborts.map((abort) =>
      app.request("/v1/reputation/stream?after=0", {
        headers,
        signal: abort.signal,
      }),
    ),
  );
  const readers = responses.map((res) => res.body!.getReader());
  try {
    const chunks = await Promise.all(readers.map((reader) => reader.read()));
    assert.ok(
      chunks.every((c) =>
        new TextDecoder().decode(c.value).includes("event: changes"),
      ),
    );
    assert.equal(reads, 1);
  } finally {
    aborts.forEach((abort) => abort.abort());
    await Promise.all(readers.map((reader) => reader.cancel()));
  }
});

test("overview uses the atomic store operation and appeals recover exact receipts", async () => {
  const summary = {
    version: 1,
    revision: "7",
    period: "today",
    start: "2026-01-01T00:00:00Z",
    end: "2026-01-01T12:00:00Z",
    totalPoints: "1",
    lifetimePoints: "2",
    pendingCount: 0,
    categories: [],
    updatedAt: "2026-01-01T12:00:00Z",
  } as const;
  const appeal = {
    id: "00000000-0000-4000-8000-000000000002",
    itemId: "00000000-0000-4000-8000-000000000001",
    message: "Review",
    status: "open",
    resolution: null,
    createdAt: "2026-01-01T12:00:00Z",
  } as const;
  let reads = 0;
  const { app } = fixture({
    overview: (actor, view, p, cursor) => {
      assert.equal(actor, "12345");
      assert.equal(view, "history");
      assert.equal(p, "today");
      assert.equal(cursor, null);
      reads++;
      return Promise.resolve({
        summary: { ...summary, categories: [] },
        page: { items: [], nextCursor: null },
      });
    },
    summary: () => {
      throw new Error("must not stitch independent reads");
    },
    items: () => {
      throw new Error("must not stitch independent reads");
    },
    appealCommand: (actor, requestId) => {
      assert.equal(actor, "12345");
      return Promise.resolve(requestId === "lost-appeal" ? appeal : null);
    },
  });
  const overview = await app.request(
    "/v1/reputation/overview?view=history&period=today",
    { headers },
  );
  assert.equal(overview.status, 200);
  assert.equal(reads, 1);
  assert.equal(
    (await app.request("/v1/reputation/overview?view=public", { headers }))
      .status,
    400,
  );
  const receipt = await app.request(
    "/v1/reputation/appeals/commands/lost-appeal",
    { headers },
  );
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), { appeal });
  assert.equal(
    (await app.request("/v1/reputation/appeals/commands/unknown", { headers }))
      .status,
    404,
  );
});

test("1000 streams fit bounded service capacity without per-second DB polling", async () => {
  const app = new Hono();
  let reads = 0;
  let subscribers = 0;
  const wake = new Map<string, () => void>();
  const store = {
    changes: (_actor: string, after: string) => {
      reads++;
      return Promise.resolve({
        version: 1 as const,
        changes: [],
        nextCursor: after,
        hasMore: false,
        resetRequired: false,
      });
    },
    onChange: (actor: string, listener: () => void) => {
      subscribers++;
      wake.set(actor, listener);
      return () => {
        subscribers--;
        wake.delete(actor);
      };
    },
  } as ReputationStore;
  registerReputationRoutes(app, store, (c) =>
    Promise.resolve(c.req.header("x-synthetic-actor") ?? null),
  );
  const aborts = Array.from({ length: 1000 }, () => new AbortController());
  try {
    const responses = await Promise.all(
      aborts.map((abort, i) =>
        app.request("/v1/reputation/stream", {
          headers: { "x-synthetic-actor": String(i + 1) },
          signal: abort.signal,
        }),
      ),
    );
    assert.ok(responses.every((res) => res.status === 200));
    assert.equal(subscribers, 1000);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(reads, 1000);
    wake.get("1")!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 1001);
  } finally {
    aborts.forEach((abort) => abort.abort());
  }
  assert.equal(subscribers, 0);
});
