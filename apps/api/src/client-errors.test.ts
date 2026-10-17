import type pg from "pg";
import { createApp } from "./app.ts";
import {
  TokenBucket,
  PostgresClientErrorStore,
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
  message: "type_error",
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

Deno.test("rejects messages outside the diagnostic allowlist", async () => {
  const { post, stored } = build();
  for (const message of [
    "Example Person",
    "example_person",
    "",
    "TypeError",
    "type_error ",
    "UNKNOWN",
    "unknown\n",
    null,
    12,
    '{"first_name":"Example Person","username":"example_person"}',
  ]) {
    assert((await post({ ...report, message })).status === 400);
  }
  assert(stored.length === 0);
});

Deno.test("accepts fixed codes and re-sanitizes metadata", async () => {
  const { post, stored } = build();
  for (const message of [
    "unknown",
    "type_error",
    "range_error",
    "reference_error",
    "syntax_error",
    "uri_error",
    "eval_error",
    "aggregate_error",
    "abort_error",
    "timeout_error",
  ]) {
    const response = await post({
      ...report,
      message,
      name: "bad name!",
      route: "app:wallet/123456",
      frames: [
        "main.js:1:2",
        "https://other.example/x.js?token=1:1:1",
        "a b:1:1",
      ],
    });
    assert(response.status === 204);
    const saved = stored.at(-1) as typeof report;
    assert(saved.message === message);
    assert(saved.name === "Error" && saved.route === "other");
    assert(saved.frames.length === 1 && saved.frames[0] === "main.js:1:2");
  }
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

Deno.test("store drops invalid messages before issuing SQL", async () => {
  const calls: unknown[][] = [];
  const pool = {
    query: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as Pick<pg.Pool, "query">;
  const store = new PostgresClientErrorStore(pool, () => 0);
  for (const message of [
    "Example Person",
    "example_person",
    "",
    "type_error ",
  ]) {
    await store.record({ ...report, message } as Parameters<
      typeof store.record
    >[0]);
  }
  assert(calls.length === 0);
  await store.record({ ...report, message: "type_error" } as Parameters<
    typeof store.record
  >[0]);
  assert(calls.length === 1);
  const params = calls[0]?.[1] as unknown[];
  assert(params[4] === "type_error");
});
