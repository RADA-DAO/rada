import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { encodePng } from "./png.ts";
import { registerSplashRoutes } from "./router.ts";
import type { SplashStore, SubmitResult } from "./store.ts";

const idleRounds = {
  currentRound: () => Promise.resolve(null),
  placeBid: () => Promise.reject(new Error("unused")),
  myBids: () => Promise.resolve([]),
  roundResults: () => Promise.resolve(null),
  nameStatus: () => Promise.resolve("available" as const),
  advanceRounds: () => Promise.resolve(0),
};
const ID = "11111111-1111-4111-8111-111111111111";
function png(width = 100, height = 100) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++)
    rgba.set(
      i % width > 30 && i % width < 60 && i / width > 30 && i / width < 60
        ? [200, 20, 20, 255]
        : [240, 240, 240, 255],
      i * 4,
    );
  return new Uint8Array(encodePng({ width, height, rgba }));
}
function build(
  result: SubmitResult = {
    status: "created",
    submissionId: ID,
    submittedAt: "2026-10-16T00:00:00.000Z",
  },
  reserveSubmissionAttempt: (id: string) => Promise<number> = () =>
    Promise.resolve(0),
) {
  const calls: { id: string; sha256: string }[] = [];
  const store: SplashStore = {
    ...idleRounds,
    reserveSubmissionAttempt,
    submit: (id, image) => {
      calls.push({ id, sha256: image.sha256 });
      return Promise.resolve(result);
    },
    pond: () =>
      Promise.resolve([
        {
          submissionId: ID,
          submittedAt: "2026-10-16T00:00:00.000Z",
          width: 50,
          height: 50,
          backgroundRemoved: true,
          author: null,
        },
        {
          submissionId: "22222222-2222-4222-8222-222222222222",
          submittedAt: "2026-10-15T00:00:00.000Z",
          width: 50,
          height: 50,
          backgroundRemoved: false,
          author: {
            frogId: "33333333-3333-4333-8333-333333333333",
            username: "pondfrog",
            backgroundColor: "#112233",
            accentColor: null,
          },
        },
      ]),
    mine: (id) => {
      assert.equal(id, "101");
      return Promise.resolve([
        {
          submissionId: ID,
          state: "in_pond",
          submittedAt: "2026-10-16T00:00:00.000Z",
          width: 50,
          height: 50,
          backgroundRemoved: true,
        },
      ]);
    },
    image: (id) =>
      Promise.resolve(
        id === ID
          ? { contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) }
          : null,
      ),
  };
  const app = new Hono();
  registerSplashRoutes(app, store, (c) =>
    Promise.resolve(c.req.header("Authorization") === "tma ok" ? "101" : null),
  );
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    app.request("/v1/splash/submissions", {
      method: "POST",
      headers: {
        authorization: "tma ok",
        "content-type": "image/png",
        ...headers,
      },
      body,
    });
  return { app, calls, post };
}

test("submission requires authentication before reading the body", async () => {
  const { post, calls } = build();
  const response = await post(png(), { authorization: "tma bad" });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("valid PNG is stored through the store and answers 201 with private-free body", async () => {
  const { post, calls } = build();
  const response = await post(png());
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.state, "in_pond");
  assert.equal(body.background_removed, true);
  assert.equal(body.image_path, `/v1/splash/submissions/${ID}/image`);
  assert.deepEqual(Object.keys(body).sort(), [
    "background_removed",
    "height",
    "image_path",
    "state",
    "submission_id",
    "submitted_at",
    "width",
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.id, "101");
});

test("wrong content type, oversize and bad images are refused without storing", async () => {
  const { post, calls } = build();
  assert.equal(
    (await post(png(), { "content-type": "image/jpeg" })).status,
    415,
  );
  assert.equal(
    (await post(png(), { "content-length": String(3 * 1024 * 1024) })).status,
    413,
  );
  assert.equal((await post(new Uint8Array(2 * 1024 * 1024 + 5))).status, 413);
  assert.equal((await post(new Uint8Array(200))).status, 415);
  const small = await post(png(40, 40));
  assert.equal(small.status, 400);
  assert.equal((await small.json()).error, "bad_dimensions");
  assert.equal(calls.length, 0);
});

test("rate limit answers 429 with Retry-After; duplicate answers 409", async () => {
  const limited = build({ status: "rate_limited", retryAfterSeconds: 120 });
  const response = await limited.post(png());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "120");
  const duplicate = build({ status: "duplicate" });
  assert.equal((await duplicate.post(png())).status, 409);
});

test("pond is public and exposes an author only as a public profile frog", async () => {
  const { app } = build();
  const response = await app.request("/v1/splash/pond");
  assert.equal(response.status, 200);
  const { frogs } = await response.json();
  assert.equal(frogs.length, 2);
  assert.equal(frogs[0].author, null);
  assert.deepEqual(frogs[1].author, {
    frog_id: "33333333-3333-4333-8333-333333333333",
    username: "pondfrog",
    background_color: "#112233",
    accent_color: null,
  });
  assert.ok(!JSON.stringify(frogs).includes("subject"));
});

test("own submissions need authentication and list state", async () => {
  const { app } = build();
  assert.equal((await app.request("/v1/splash/submissions/mine")).status, 401);
  const response = await app.request("/v1/splash/submissions/mine", {
    headers: { authorization: "tma ok" },
  });
  const { submissions } = await response.json();
  assert.equal(submissions[0].state, "in_pond");
});

test("image route serves PNG bytes for known ids and 404 otherwise", async () => {
  const { app } = build();
  const ok = await app.request(`/v1/splash/submissions/${ID}/image`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())], [1, 2, 3]);
  assert.equal(
    (await app.request("/v1/splash/submissions/not-a-uuid/image")).status,
    404,
  );
  assert.equal(
    (
      await app.request(
        "/v1/splash/submissions/22222222-2222-4222-8222-222222222222/image",
      )
    ).status,
    404,
  );
});

test("failed and duplicate submissions consume admission before body reads", async () => {
  let attempts = 0;
  const { post, app, calls } = build({ status: "duplicate" }, (id) => {
    assert.equal(id, "101");
    return Promise.resolve(++attempts <= 10 ? 0 : 3600);
  });
  for (let i = 0; i < 5; i++)
    assert.equal((await post(new Uint8Array(10))).status, 415);
  for (let i = 0; i < 5; i++) assert.equal((await post(png())).status, 409);
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(1));
      },
    },
    { highWaterMark: 0 },
  );
  const response = await app.request(
    new Request("https://fixture.invalid/v1/splash/submissions", {
      method: "POST",
      headers: { authorization: "tma ok", "content-type": "image/png" },
      body,
      duplex: "half",
    } as RequestInit),
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "3600");
  assert.equal(reads, 0);
  assert.equal(calls.length, 5);
});

test("global processing admission precedes body reads and releases after failures", async () => {
  const releases: ((value: number) => void)[] = [];
  const { post, app } = build(
    undefined,
    () => new Promise<number>((resolve) => releases.push(resolve)),
  );
  const pending = Array.from({ length: 4 }, () => post(new Uint8Array(10)));
  while (releases.length < 4)
    await new Promise((resolve) => setTimeout(resolve, 0));
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(1));
      },
    },
    { highWaterMark: 0 },
  );
  const response = await app.request(
    new Request("https://fixture.invalid/v1/splash/submissions", {
      method: "POST",
      headers: { authorization: "tma ok", "content-type": "image/png" },
      body,
      duplex: "half",
    } as RequestInit),
  );
  assert.equal(response.status, 429);
  assert.equal(reads, 0);
  assert.equal(releases.length, 4);
  releases.forEach((release) => release(0));
  assert.deepEqual(
    (await Promise.all(pending)).map((r) => r.status),
    [415, 415, 415, 415],
  );
  const next = post(png());
  while (releases.length < 5)
    await new Promise((resolve) => setTimeout(resolve, 0));
  releases[4]?.(0);
  assert.equal((await next).status, 201);
});
