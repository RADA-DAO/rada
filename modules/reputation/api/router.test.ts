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
