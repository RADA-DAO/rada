import test from "node:test";
import assert from "node:assert/strict";
import {
  notificationConfig,
  NotificationWorker,
  sendTelegram,
} from "./worker.ts";
import { kinds, message } from "./templates.ts";
import { validPreference } from "./router.ts";
import type pg from "pg";
await test("kill switch defaults off; synthetic cannot send; staging fails closed", async () => {
  assert.equal(notificationConfig({}).enabled, false);
  assert.equal(
    notificationConfig({
      NOTIFICATIONS_ENABLED: "true",
      STAGING_AUTH_MODE: "synthetic",
    }).enabled,
    false,
  );
  assert.throws(() => notificationConfig({ STAGING_RUNTIME: "true" }));
  assert.deepEqual(
    notificationConfig({
      STAGING_RUNTIME: "true",
      STAGING_ALLOWED_TELEGRAM_IDS: "101,102",
    }).allowed,
    ["101", "102"],
  );
  await new NotificationWorker(
    {
      connect: () => {
        throw new Error("must not connect");
      },
    } as unknown as pg.Pool,
    notificationConfig({}),
  ).run();
});
await test("Telegram success, retry-after, permanent errors and uncertain delivery", async () => {
  for (const [status, body, result, delay] of [
    [200, { ok: true }, "sent", 0],
    [429, { ok: false, parameters: { retry_after: 90 } }, "retry", 90],
    [500, { ok: false }, "retry", 0],
    [403, { ok: false }, "dead", 0],
  ] as const) {
    const send = ((_url: unknown, init: RequestInit) => {
      assert.ok(init.signal);
      assert.equal(JSON.parse(String(init.body)).chat_id, "101");
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as typeof fetch;
    assert.deepEqual(await sendTelegram("fixture", "101", "safe", send), {
      result,
      delay,
    });
  }
  assert.equal(
    (
      await sendTelegram("fixture", "101", "safe", () =>
        Promise.reject(new Error("timeout")),
      )
    ).result,
    "uncertain",
  );
});
await test("templates have no interpolation or private payload surface", () => {
  for (const locale of ["en", "uk"] as const)
    for (const kind of kinds) {
      const text = message(locale, kind);
      assert.ok(text.length > 15);
      assert.doesNotMatch(
        text,
        /\{\{|@|https?:|[0-9a-f]{8}-|telegram_user_id|subject_id|outbid|top bid|highest bid|\u043f\u0435\u0440\u0435\u0431\u0438\u043b\u0438|\u043d\u0430\u0439\u0432\u0438\u0449\u0430 \u0441\u0442\u0430\u0432\u043a\u0430/i,
      );
    }
});
await test("preference schema rejects subject selectors and implicit consent", () => {
  const p = {
    category: "splash",
    enabled: true,
    locale: "en",
    quiet_start: null,
    quiet_end: null,
  };
  assert.ok(validPreference(p));
  assert.ok(!validPreference({ ...p, subject_id: "other" }));
  assert.ok(!validPreference({ ...p, enabled: undefined }));
  assert.ok(!validPreference({ ...p, category: "market" }));
  assert.ok(!validPreference({ ...p, quiet_start: 8, quiet_end: 8 }));
});

await test("HTTP routes authenticate before access and reject private selectors", async () => {
  const { Hono } = await import("hono");
  const { registerNotificationRoutes } = await import("./router.ts");
  let writes = 0;
  const fake = {
    read: () => Promise.resolve([]),
    save: () => {
      writes++;
      return Promise.resolve();
    },
    test: () => Promise.resolve(false),
  };
  const app = new Hono();
  registerNotificationRoutes(
    app,
    fake as unknown as import("./store.ts").NotificationStore,
    (c, privileged) =>
      Promise.resolve(
        c.req.header("authorization") === (privileged ? "fresh" : "signed")
          ? "101"
          : null,
      ),
  );
  assert.equal(
    (await app.request("/v1/notifications/preferences")).status,
    401,
  );
  assert.equal(
    (
      await app.request("/v1/notifications/preferences", {
        headers: { authorization: "signed" },
      })
    ).status,
    200,
  );
  const post = (body: unknown, authorization = "fresh") =>
    app.request("/v1/notifications/preferences", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const p = {
    category: "splash",
    enabled: true,
    locale: "en",
    quiet_start: null,
    quiet_end: null,
  };
  assert.equal((await post(p, "signed")).status, 401);
  assert.equal((await post({ ...p, subject_id: "other" })).status, 400);
  assert.equal((await post(p)).status, 200);
  assert.equal(writes, 1);
  assert.equal((await post({ payload: "x".repeat(2000) })).status, 400);
  const response = await app.request("/v1/notifications/test", {
    method: "POST",
    headers: { authorization: "fresh", "content-type": "application/json" },
    body: '{"category":"splash"}',
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
});
