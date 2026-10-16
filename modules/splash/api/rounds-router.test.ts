import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { BidResult, RoundStore } from "./rounds.ts";
import { parseBid, registerRoundRoutes } from "./rounds-router.ts";
import { startRoundScheduler } from "./rounds.ts";

const FROG = "11111111-1111-4111-8111-111111111111";
const PUBLIC = {
  frogId: "33333333-3333-4333-8333-333333333333",
  username: "Leader",
  backgroundColor: "#112233",
  accentColor: null,
};

function build(
  result: BidResult = {
    status: "placed",
    bidId: "7",
    roundId: 3,
    amount: "100",
    username: "Alpha",
    placedAt: "2026-10-16T01:00:00.000Z",
    nameContested: true,
  },
) {
  const bids: {
    id: string;
    submissionId: string;
    amount: string;
    username: string;
  }[] = [];
  const store: RoundStore = {
    currentRound: () =>
      Promise.resolve({
        roundId: 3,
        startsAt: "2026-10-16T00:00:00.000Z",
        endsAt: "2026-10-17T00:00:00.000Z",
        acceptingBids: true,
        lots: [
          {
            submissionId: FROG,
            submittedAt: "2026-10-15T00:00:00.000Z",
            width: 64,
            height: 64,
            backgroundRemoved: true,
            author: null,
            topAmount: "100",
            bidderCount: 2,
            leader: PUBLIC,
          },
          {
            submissionId: "22222222-2222-4222-8222-222222222222",
            submittedAt: "2026-10-15T01:00:00.000Z",
            width: 64,
            height: 64,
            backgroundRemoved: false,
            author: null,
            topAmount: null,
            bidderCount: 0,
            leader: null,
          },
        ],
      }),
    placeBid: (id, submissionId, amount, username) => {
      bids.push({ id, submissionId, amount, username });
      return Promise.resolve(result);
    },
    myBids: (id) => {
      assert.equal(id, "101");
      return Promise.resolve([
        {
          roundId: 2,
          submissionId: FROG,
          amount: "60",
          username: "alpha",
          placedAt: "2026-10-15T02:00:00.000Z",
          roundEndsAt: "2026-10-16T00:00:00.000Z",
          status: "won",
          grantedUsername: null,
          nameOutcome: "conflict",
          claimDeadline: "2026-10-17T00:00:00.000Z",
        },
      ]);
    },
    roundResults: (roundId) =>
      Promise.resolve(
        roundId === 2
          ? {
              roundId: 2,
              startsAt: "2026-10-15T00:00:00.000Z",
              endsAt: "2026-10-16T00:00:00.000Z",
              closedAt: "2026-10-16T00:00:05.000Z",
              lots: [
                {
                  submissionId: FROG,
                  width: 64,
                  height: 64,
                  backgroundRemoved: true,
                  bidderCount: 2,
                  amount: "100",
                  username: "Alpha",
                  nameOutcome: "reserved",
                  claimDeadline: "2026-10-17T00:00:00.000Z",
                  winner: PUBLIC,
                },
                {
                  submissionId: "22222222-2222-4222-8222-222222222222",
                  width: 64,
                  height: 64,
                  backgroundRemoved: true,
                  bidderCount: 0,
                  amount: null,
                  username: null,
                  nameOutcome: null,
                  claimDeadline: null,
                  winner: null,
                },
              ],
            }
          : null,
      ),
    nameStatus: (name) =>
      Promise.resolve(
        name === "Taken" ? "taken" : name === "Alpha" ? "available" : "invalid",
      ),
    advanceRounds: () => Promise.resolve(0),
  };
  const app = new Hono();
  registerRoundRoutes(app, store, (c, privileged) => {
    const header = c.req.header("Authorization");
    if (header === "tma fresh") return Promise.resolve("101");
    return Promise.resolve(header === "tma old" && !privileged ? "101" : null);
  });
  const bid = (body: unknown, authorization = "tma fresh") =>
    app.request("/v1/splash/bids", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, bids, bid };
}

test("bid input is validated before reaching the store", () => {
  assert.equal(parseBid("{"), "invalid_body");
  assert.equal(parseBid("[]"), "invalid_body");
  assert.equal(
    parseBid(JSON.stringify({ submission_id: "x", amount: "1", name: "A" })),
    "invalid_body",
  );
  for (const amount of [
    "0",
    "-1",
    "1.5",
    "01",
    "1e3",
    "",
    " 5",
    0,
    -3,
    1.5,
    2 ** 60,
    null,
    "9".repeat(79),
  ])
    assert.equal(
      parseBid(JSON.stringify({ submission_id: FROG, amount, name: "A" })),
      "invalid_amount",
      String(amount),
    );
  for (const name of ["", "x".repeat(33), 5, null])
    assert.equal(
      parseBid(JSON.stringify({ submission_id: FROG, amount: "1", name })),
      "invalid_name",
    );
  assert.deepEqual(
    parseBid(
      JSON.stringify({
        submission_id: FROG.toUpperCase(),
        amount: 42,
        name: "Frog_1",
      }),
    ),
    { submissionId: FROG, amount: "42", username: "Frog_1" },
  );
  assert.deepEqual(
    parseBid(
      JSON.stringify({
        submission_id: FROG,
        amount: "1" + "0".repeat(30),
        name: "Big",
      }),
    ),
    { submissionId: FROG, amount: "1" + "0".repeat(30), username: "Big" },
  );
});

test("placing a bid needs a fresh signed launch and passes only the verified id", async () => {
  const { bid, bids } = build();
  assert.equal(
    (
      await bid(
        { submission_id: FROG, amount: "100", name: "Alpha" },
        "tma old",
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await bid(
        { submission_id: FROG, amount: "100", name: "Alpha", bidder: "999" },
        "",
      )
    ).status,
    401,
  );
  assert.equal(bids.length, 0);
  assert.equal(
    (await bid({ submission_id: FROG, amount: "abc", name: "Alpha" })).status,
    400,
  );
  assert.equal((await bid("x".repeat(2000))).status, 413);
  assert.equal(bids.length, 0);
  const response = await bid({
    submission_id: FROG,
    amount: "100",
    name: "Alpha",
    bidder: "999",
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    bid_id: "7",
    round_id: 3,
    submission_id: FROG,
    amount: "100",
    name: "Alpha",
    placed_at: "2026-10-16T01:00:00.000Z",
    name_contested: true,
  });
  assert.deepEqual(bids, [
    { id: "101", submissionId: FROG, amount: "100", username: "Alpha" },
  ]);
});

test("store refusals map to stable HTTP errors", async () => {
  const cases: [BidResult["status"], number][] = [
    ["self_bid", 403],
    ["not_on_auction", 404],
    ["name_taken", 409],
    ["bid_too_low", 409],
    ["bid_unchanged", 409],
    ["round_closed", 409],
    ["invalid_name", 400],
    ["invalid_amount", 400],
  ];
  for (const [status, code] of cases) {
    const { bid } = build({ status } as BidResult);
    const response = await bid({
      submission_id: FROG,
      amount: "5",
      name: "Alpha",
    });
    assert.equal(response.status, code, status);
    assert.deepEqual(await response.json(), { error: status });
  }
});

test("current round shows amounts and only public leader profiles", async () => {
  const { app } = build();
  const body = await (await app.request("/v1/splash/round")).json();
  assert.equal(body.round.round_id, 3);
  assert.equal(body.round.frogs[0].top_amount, "100");
  assert.deepEqual(body.round.frogs[0].leader, {
    frog_id: PUBLIC.frogId,
    username: "Leader",
    background_color: "#112233",
    accent_color: null,
  });
  assert.equal(body.round.frogs[1].leader, null);
  assert.equal(body.round.frogs[1].top_amount, null);
  assert.ok(!JSON.stringify(body).includes("subject"));
});

test("own bids require login; results are public for closed rounds only", async () => {
  const { app } = build();
  assert.equal((await app.request("/v1/splash/bids/mine")).status, 401);
  const mine = await (
    await app.request("/v1/splash/bids/mine", {
      headers: { authorization: "tma old" },
    })
  ).json();
  assert.equal(mine.bids[0].status, "won");
  assert.equal(mine.bids[0].name_outcome, "conflict");
  assert.equal(mine.bids[0].granted_name, null);
  for (const id of ["0", "abc", "1.5", "99999999999999999"])
    assert.equal(
      (await app.request(`/v1/splash/rounds/${id}/results`)).status,
      404,
    );
  assert.equal((await app.request("/v1/splash/rounds/3/results")).status, 404);
  const results = await (
    await app.request("/v1/splash/rounds/2/results")
  ).json();
  assert.equal(results.frogs[0].outcome, "won");
  assert.equal(results.frogs[0].winner.username, "Leader");
  assert.equal(results.frogs[1].outcome, "no_bids");
  assert.equal(results.frogs[1].winner, null);
  assert.ok(!JSON.stringify(results).includes("subject"));
});

test("name availability needs a signed launch and relays JPEGPE's rule", async () => {
  const { app } = build();
  const status = async (name: string, authorization = "tma old") => {
    const response = await app.request(
      `/v1/splash/names/${encodeURIComponent(name)}`,
      { headers: { authorization } },
    );
    return [
      response.status,
      response.status === 200 ? (await response.json()).status : null,
    ];
  };
  assert.deepEqual(await status("Alpha"), [200, "available"]);
  assert.deepEqual(await status("Taken"), [200, "taken"]);
  assert.deepEqual(await status("x".repeat(33)), [200, "invalid"]);
  assert.deepEqual(await status("Alpha", "tma none"), [401, null]);
});

test("the round scheduler never overlaps and logs only the error class", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const lines: string[] = [];
  const stop = startRoundScheduler(
    {
      advanceRounds: () => {
        calls++;
        if (calls === 1)
          return new Promise<number>((resolve) => (release = () => resolve(0)));
        return Promise.reject(new TypeError("secret detail"));
      },
    },
    5,
    (line) => lines.push(line),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  stop();
  assert.ok(calls >= 2);
  assert.ok(lines.length >= 1);
  assert.deepEqual(JSON.parse(lines[0] ?? "{}"), {
    event: "splash_round_job_failed",
    errorClass: "TypeError",
  });
  assert.ok(!lines.join("").includes("secret"));
});
