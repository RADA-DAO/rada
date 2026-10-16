import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ModuleApi,
  ModuleResponse,
} from "../../../packages/platform-sdk/src/index.ts";
import { splashClient, SplashError } from "./api.ts";
import { clock, jpegpe, waitMinutes } from "./format.ts";
import { fitWithin } from "./image.ts";

const FROG = "11111111-1111-4111-8111-111111111111";
function fakeApi(responses: Record<string, ModuleResponse>) {
  const calls: { method: string; path: string; auth: boolean | undefined }[] =
    [];
  const api: ModuleApi = {
    url: (path) => `https://api.example${path}`,
    request: (method, path, options = {}) => {
      calls.push({ method, path, auth: options.auth });
      const response = responses[`${method} ${path}`];
      return response
        ? Promise.resolve(response)
        : Promise.reject(new Error("unexpected"));
    },
  };
  return { client: splashClient(api), calls };
}
const ok = (body: unknown): ModuleResponse => ({
  status: 200,
  body,
  retryAfter: null,
});
const signal = new AbortController().signal;

await test("the round is read publicly and shows only public names", async () => {
  const { client, calls } = fakeApi({
    "GET /v1/splash/round": ok({
      round: {
        round_id: 4,
        starts_at: "2026-10-16T00:00:00.000Z",
        ends_at: "2026-10-17T00:00:00.000Z",
        accepting_bids: true,
        frogs: [
          {
            submission_id: FROG,
            image_path: `/v1/splash/submissions/${FROG}/image`,
            author: null,
            top_amount: "1500000000",
            bidder_count: 2,
            leader: { username: "Leader" },
          },
        ],
      },
    }),
  });
  const round = await client.round(signal);
  assert.equal(calls[0]?.auth, false);
  assert.ok(round);
  assert.equal(round.roundId, 4);
  assert.equal(round.endsAt, Date.parse("2026-10-17T00:00:00.000Z"));
  assert.deepEqual(round.lots[0], {
    submissionId: FROG,
    imageUrl: `https://api.example/v1/splash/submissions/${FROG}/image`,
    author: null,
    topAmount: "1500000000",
    bidderCount: 2,
  });
});

await test("malformed responses fail closed and refusals keep their code", async () => {
  const { client } = fakeApi({
    "GET /v1/splash/round": ok({ round: { round_id: "x" } }),
    "POST /v1/splash/bids": {
      status: 409,
      body: { error: "name_taken" },
      retryAfter: null,
    },
    "GET /v1/splash/bids/mine": { status: 401, body: null, retryAfter: null },
    "GET /v1/splash/claims/mine": {
      status: 404,
      body: { error: "not_found" },
      retryAfter: null,
    },
  });
  await assert.rejects(client.round(signal), /unavailable/);
  await assert.rejects(
    client.placeBid(FROG, "1", "Alpha", signal),
    (error: unknown) =>
      error instanceof SplashError && error.message === "name_taken",
  );
  await assert.rejects(client.myBids(signal), /expired/);
  assert.deepEqual(await client.myClaims(signal), [], "claims not enabled");
});

await test("a rate limit carries its wait; claims parse their state", async () => {
  const { client } = fakeApi({
    "POST /v1/splash/submissions": {
      status: 429,
      body: { error: "rate_limited" },
      retryAfter: 600,
    },
    [`GET /v1/splash/claims/${FROG}`]: ok({
      claim: {
        submission_id: FROG,
        amount: "5",
        name: null,
        claim_deadline: "2026-10-18T00:00:00.000Z",
        state: "open",
        payment: { intent_id: FROG, status: "unknown" },
      },
    }),
  });
  await assert.rejects(
    client.submit(new Blob(), signal),
    (error: unknown) =>
      error instanceof SplashError &&
      error.message === "rate_limited" &&
      error.retryAfter === 600,
  );
  const claim = await client.claim(FROG, signal);
  assert.equal(claim.state, "open");
  assert.equal(claim.paymentStatus, "unknown");
  assert.equal(claim.name, null);
  assert.equal(waitMinutes(600), "10");
  assert.equal(waitMinutes(null), "1");
});

await test("formatting: amounts, countdown and image size", () => {
  assert.equal(jpegpe("en", "1500000000"), "1.5 JPEGPE");
  assert.equal(jpegpe("uk", "1500000000"), "1,5 JPEGPE");
  assert.equal(clock(0), "00:00:00");
  assert.equal(clock(3_723_000), "01:02:03");
  assert.equal(clock(47 * 3_600_000 + 1), "47:00:01");
  assert.deepEqual(fitWithin(4000, 2000), { width: 1024, height: 512 });
  assert.deepEqual(fitWithin(300, 200), { width: 300, height: 200 });
});
