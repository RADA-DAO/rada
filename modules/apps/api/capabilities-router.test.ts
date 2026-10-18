import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { registerCapabilityRoutes } from "./capabilities-router.ts";
import type { RegistryStore } from "./store.ts";
void test("capability HTTP gates authenticate, bound bodies and map service failures", async () => {
  let identity: string | null = null;
  let code = "40001";
  let calls = 0;
  const store = {
    capability: () => {
      calls++;
      return Promise.reject(Object.assign(new Error(), { code }));
    },
    reports: () =>
      Promise.reject(Object.assign(new Error(), { code: "42501" })),
  } as unknown as RegistryStore;
  const app = new Hono();
  registerCapabilityRoutes(app, store, (_c, privileged) => {
    assert.equal(privileged, true);
    return Promise.resolve(identity);
  });
  const post = (operation: string, payload: unknown = {}) =>
    app.request(`/apps/fixture/capabilities/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash: "a".repeat(64), payload }),
    });
  assert.equal((await post("records.put")).status, 401);
  identity = "verified";
  assert.equal((await post("records.put")).status, 409);
  assert.equal((await post("unknown")).status, 400);
  assert.equal(
    (await post("records.put", { value: "x".repeat(20001) })).status,
    413,
  );
  code = "42501";
  assert.equal((await post("scores.list")).status, 403);
  code = "22023";
  assert.equal((await post("scores.submit")).status, 400);
  code = "P0429";
  const limited = await post("report");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "3600");
  assert.equal((await app.request("/apps/review-queue/reports")).status, 403);
  assert.equal(calls, 4);
});
