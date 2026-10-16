import { test } from "node:test";
import assert from "node:assert/strict";
import { moduleApiAdapter, modulePath } from "./module-api.ts";

await test("module paths stay inside the module's own API", () => {
  assert.equal(modulePath("splash", "/v1/splash/round"), "/v1/splash/round");
  for (const path of [
    "/v1/splash",
    "/v1/wallet/round",
    "/me/payments",
    "/v1/splash/../me",
    "/v1/splash/round?x=1",
    "/v1/splash/a#b",
    "//evil.example/v1/splash/round",
    "v1/splash/round",
  ])
    assert.throws(() => modulePath("splash", path), /invalid_request/, path);
  assert.throws(
    () => modulePath("wallet" as "splash", "/v1/wallet/round"),
    /invalid_request/,
  );
});

await test("requests carry the credential only inside the adapter", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({
      url: url instanceof Request ? url.url : url.toString(),
      init: init ?? {},
    });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 429,
        headers: { "Retry-After": "120" },
      }),
    );
  };
  try {
    let credential: { Authorization: string } | null = {
      Authorization: "tma fixture",
    };
    const api = moduleApiAdapter(
      "https://api.example",
      () => credential,
    ).moduleApi("splash");
    const response = await api.request("POST", "/v1/splash/bids", {
      body: { json: { amount: "1" } },
    });
    assert.deepEqual(response, {
      status: 429,
      body: { ok: true },
      retryAfter: 120,
    });
    const [first] = calls;
    assert.ok(first);
    assert.equal(first.url, "https://api.example/v1/splash/bids");
    assert.deepEqual(first.init.headers, {
      Authorization: "tma fixture",
      "Content-Type": "application/json",
    });
    assert.equal(first.init.credentials, "omit");
    await api.request("GET", "/v1/splash/round", { auth: false });
    assert.deepEqual(calls[1]?.init.headers, {});
    credential = null;
    await assert.rejects(api.request("GET", "/v1/splash/bids/mine"), /expired/);
    assert.equal(
      api.url("/v1/splash/submissions/x/image"),
      "https://api.example/v1/splash/submissions/x/image",
    );
  } finally {
    globalThis.fetch = original;
  }
});
