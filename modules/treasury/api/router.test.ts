// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { registerTreasuryRoutes } from "./router.ts";
import type { TreasuryStore } from "./store.ts";
const address = `0:${"1".repeat(64)}`;
function fixture(allowed = false) {
  const calls: unknown[][] = [];
  const store: TreasuryStore = {
    overview: async () => ({ wallets: [] }),
    transactions: async (...args) => {
      calls.push(args);
      return Array.from({ length: 51 }, (_, i) => ({
        id: String(100 - i),
        person: null,
        decisions: [],
      }));
    },
    history: async () => [],
    configure: async (...args) => {
      calls.push(args);
      if (!allowed)
        throw Object.assign(new Error("forbidden"), { code: "42501" });
    },
  };
  const app = new Hono();
  registerTreasuryRoutes(app, store, async (c, privileged) => {
    assert.equal(privileged, true);
    return c.req.header("authorization") ? "verified-actor" : null;
  });
  return { app, calls };
}
await test("only read routes and authenticated configuration exist; money actions are absent", async () => {
  const { app } = fixture();
  for (const route of [
    "payout",
    "sign",
    "payment",
    "transfer",
    "broadcast",
    "transactions",
    "overview",
  ])
    assert.equal(
      (await app.request(`/v1/treasury/${route}`, { method: "POST" })).status,
      404,
    );
  assert.equal((await app.request("/v1/treasury/overview")).status, 200);
  assert.equal(
    (await app.request("/v1/treasury/config", { method: "POST" })).status,
    401,
  );
});
await test("configuration fails closed for non-stewards, rejects extra fields and requires bounded JSON", async () => {
  for (const allowed of [false, true]) {
    const { app, calls } = fixture(allowed);
    const post = (body: unknown) =>
      app.request("/v1/treasury/config", {
        method: "POST",
        headers: {
          authorization: "signed",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await post({ address, enabled: true, reason: "DAO multisig" })).status,
      allowed ? 200 : 403,
    );
    assert.deepEqual(calls[0], [
      "verified-actor",
      address,
      true,
      "DAO multisig",
    ]);
    assert.equal(
      (await post({ address, enabled: true, reason: "DAO", actor: "other" }))
        .status,
      400,
    );
    assert.equal(
      (await post({ address, enabled: true, reason: "x".repeat(5000) })).status,
      413,
    );
  }
});
await test("pagination passes filters and omits lookahead row", async () => {
  const { app, calls } = fixture();
  const response = await app.request(
    "/v1/treasury/transactions?direction=in&token=TON&before=101",
  );
  const body = await response.json();
  assert.equal(body.transactions.length, 50);
  assert.equal(body.nextCursor, "51");
  assert.deepEqual(calls[0], ["101", "in", "TON"]);
  for (const query of [
    "before=-1",
    "token=FAKE",
    "direction=internal",
    "address=private",
    "before=9223372036854775808",
  ])
    assert.equal(
      (await app.request(`/v1/treasury/transactions?${query}`)).status,
      400,
    );
});
