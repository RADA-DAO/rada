import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { registerLauncherRoutes } from "./launcher-router.ts";
import {
  emptyLayout,
  validLayout,
} from "../../../packages/platform-sdk/src/launcher-layout.ts";
import type { RegistryStore } from "./store.ts";
void test("private launcher routes derive identity only from authentication and report CAS conflicts", async () => {
  let id: string | null = null,
    called = "";
  const app = new Hono();
  registerLauncherRoutes(
    app,
    {
      launcher(subject: string) {
        called = subject;
        return Promise.reject(Object.assign(new Error(), { code: "40001" }));
      },
    } as unknown as RegistryStore,
    () => Promise.resolve(id),
  );
  const post = (body: unknown) =>
    app.request("/apps/launcher/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ version: 0, layout: emptyLayout() })).status, 401);
  id = "verified-person";
  assert.equal(
    (await post({ version: 0, layout: emptyLayout(), subject: "another" }))
      .status,
    400,
  );
  const conflict = await post({ version: 0, layout: emptyLayout() });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.headers.get("cache-control"), "private, no-store");
  assert.equal(called, id);
  assert.equal(
    (await post({ version: 0, layout: { ...emptyLayout(), folders: [null] } }))
      .status,
    400,
  );
  assert.equal((await post({ junk: "x".repeat(33000) })).status, 413);
});
void test("layout validation rejects duplicates and malformed folders", () => {
  assert.equal(validLayout(emptyLayout()), true);
  for (const layout of [
    { ...emptyLayout(), order: ["app", "app"] },
    { ...emptyLayout(), folders: [null] },
    { ...emptyLayout(), folders: [{ id: "folder:a", name: "<a>", apps: [] }] },
  ])
    assert.equal(validLayout(layout), false);
});
