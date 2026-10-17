import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { registerRankingRoutes } from "./router.ts";
const revision = "a".repeat(32);
const entry = {
  rank: 1,
  frogName: "PermanentFrog",
  frogId: "frog",
  amount: "999999999999999999",
  asOf: "2026-10-17T00:00:00Z",
  stale: false,
  subject_id: "secret",
  address: "secret",
};
test("public shape and token-bound pagination expose no private fields", async () => {
  const app = new Hono();
  const calls: unknown[][] = [];
  registerRankingRoutes(app, {
    page: (...args) => {
      calls.push(args);
      return Promise.resolve({
        revision,
        entries: args[2]
          ? [{ ...entry, rank: 2 }]
          : [entry, { ...entry, rank: 2 }],
      });
    },
  });
  const first = await app.request("/v1/rankings/holders?token=TON&limit=1");
  const body = await first.json();
  assert.deepEqual(body, {
    token: "TON",
    entries: [
      {
        rank: 1,
        frogName: entry.frogName,
        frogId: "frog",
        amount: entry.amount,
        asOf: entry.asOf,
        stale: false,
      },
    ],
    nextCursor: `TON:${revision}:1`,
  });
  const second = await app.request(
    `/v1/rankings/holders?token=TON&limit=1&cursor=${body.nextCursor}`,
  );
  assert.equal((await second.json()).nextCursor, null);
  assert.deepEqual(calls[1], ["TON", 1, 1, revision]);
  assert.equal(
    (
      await app.request(
        `/v1/rankings/holders?token=JPEGPE&cursor=${body.nextCursor}`,
      )
    ).status,
    400,
  );
});
test("invalid queries never reach storage; changed projection returns 409", async () => {
  const app = new Hono();
  let calls = 0;
  registerRankingRoutes(app, {
    page: () => {
      calls++;
      return Promise.resolve(null);
    },
  });
  for (const query of [
    "",
    "token=OTHER",
    "token=TON&limit=0",
    "token=TON&limit=101",
    "token=TON&cursor=bad",
    "token=TON&subject_id=secret",
  ])
    assert.equal(
      (await app.request(`/v1/rankings/holders?${query}`)).status,
      400,
    );
  assert.equal(calls, 0);
  assert.equal(
    (await app.request("/v1/rankings/holders?token=TON")).status,
    409,
  );
});
