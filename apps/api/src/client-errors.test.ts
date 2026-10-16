import { createApp } from "./app.ts";
import {
  TokenBucket,
  type ClientErrorStore,
} from "../../../modules/ops/index.ts";
import { assert, FIXTURE_TOKEN } from "./fixtures.ts";

const methods = {
  me: () => Promise.reject(new Error("unused")),
  ownFrogs: () => Promise.resolve([]),
  selectFrog: () => Promise.resolve(false),
  consents: () => Promise.resolve([]),
  setConsent: () => Promise.resolve(true),
};
const report = {
  kind: "error",
  name: "TypeError",
  message: "x is undefined",
  frames: ["main.js:1:2"],
  build: "abc1234",
  route: "home",
};

function build(limiter?: TokenBucket, access: boolean = false) {
  const stored: unknown[] = [];
  const store: ClientErrorStore = {
    record: (item) => {
      stored.push(item);
      return Promise.resolve();
    },
  };
  const app = createApp(
    FIXTURE_TOKEN,
    methods,
    ["https://app.example"],
    undefined,
    access,
    undefined,
    undefined,
    undefined,
    undefined,
    { clientErrors: store, clientErrorLimiter: limiter },
  );
  const post = (
    body: unknown,
    type = "application/json",
    extra: Record<string, string> = {},
  ) =>
    app.request("/v1/client-errors", {
      method: "POST",
      headers: { "content-type": type, ...extra },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, stored, post };
}

Deno.test(
  "accepts a valid report without authentication, even in staging",
  async () => {
    for (const staging of [false, true]) {
      const { post, stored } = build(undefined, staging);
      const response = await post(report, "text/plain;charset=UTF-8");
      assert(response.status === 204 && stored.length === 1);
    }
  },
);

Deno.test("rejects wrong shape, extra keys and bad content type", async () => {
  const { post, stored } = build();
  assert((await post({ ...report, userId: "1" })).status === 400);
  assert((await post({ ...report, kind: "other" })).status === 400);
  assert(
    (await post({ ...report, build: "no spaces allowed" })).status === 400,
  );
  assert((await post({ ...report, frames: "x" })).status === 400);
  assert((await post("not json")).status === 400);
  assert((await post([report])).status === 400);
  assert(
    (await post(report, "application/x-www-form-urlencoded")).status === 415,
  );
  assert(stored.length === 0);
});

Deno.test("enforces the 4 KB size limit by header and by stream", async () => {
  const { post, stored } = build();
  const big = { ...report, message: "a".repeat(5000) };
  assert((await post(big)).status === 413);
  const lying = await post(report, "application/json", {
    "content-length": "99999",
  });
  assert(lying.status === 413 && stored.length === 0);
});

Deno.test("re-sanitizes message, frames, name and route", async () => {
  const { post, stored } = build();
  const response = await post({
    kind: "unhandledrejection",
    name: "bad name!",
    message:
      "user 12345 mail a.b@example.com at https://x.example/p?q=1 wallet UQDrjaLahLkMB-hMCmkzOyBuHbJ0hjHSy4Gw9AkX9Hn6sQVL 0xdeadbeefcafe " +
      "z".repeat(300),
    frames: ["main.js:1:2", "https://evil.example/x.js?token=1:1:1", "a b:1:1"],
    build: "abc1234",
    route: "app:wallet/123456",
  });
  assert(response.status === 204);
  const saved = stored[0] as typeof report;
  assert(saved.name === "Error" && saved.route === "other");
  assert(saved.frames.length === 1 && saved.frames[0] === "main.js:1:2");
  assert(saved.message.length <= 120);
  for (const leak of ["12345", "example", "UQDr", "deadbeef", "token"])
    assert(!saved.message.includes(leak), leak);
  assert(saved.message.startsWith("user # mail <email> at <url> wallet"));
});

Deno.test("global token bucket answers 429 and refills", async () => {
  let now = 0;
  const { post, stored } = build(new TokenBucket(2, 60, () => now));
  assert((await post(report)).status === 204);
  assert((await post(report)).status === 204);
  const limited = await post(report);
  assert(limited.status === 429 && limited.headers.has("retry-after"));
  assert(stored.length === 2);
  now += 1000;
  assert((await post(report)).status === 204);
});

Deno.test(
  "CORS matches other routes and the route is absent without a store",
  async () => {
    const { app } = build();
    const preflight = await app.request("/v1/client-errors", {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "POST",
      },
    });
    assert(
      preflight.headers.get("access-control-allow-origin") ===
        "https://app.example",
    );
    const bare = createApp(FIXTURE_TOKEN, methods);
    const response = await bare.request("/v1/client-errors", {
      method: "POST",
      body: "{}",
    });
    assert(response.status === 404);
  },
);
