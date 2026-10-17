import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { ClaimService, StartResult } from "./claim-service.ts";
import type { OwnClaim } from "./claims.ts";
import {
  parseClaimStart,
  rawMainnetAddress,
  registerClaimRoutes,
} from "./claims-router.ts";

const FROG = "11111111-1111-4111-8111-111111111111";
const RAW = `0:${"a".repeat(64)}`;
const CLAIMED: OwnClaim = {
  submissionId: FROG,
  roundId: 4,
  amount: "500",
  username: "Alpha",
  nameOutcome: "reserved",
  claimDeadline: "2026-10-18T00:00:00.000Z",
  state: "claimed",
  backgroundColor: "#112233",
  accentColor: "#445566",
  intentId: "22222222-2222-4222-8222-222222222222",
  paymentStatus: "paid",
};

function build(result: StartResult = { status: "not_winner" }) {
  const starts: unknown[] = [];
  const recipients: string[] = [];
  const service = {
    start: (...args: unknown[]) => {
      starts.push(args);
      return Promise.resolve(result);
    },
    status: (_id: string, frog: string) =>
      Promise.resolve(frog === FROG ? CLAIMED : null),
    reviews: (id: string) =>
      Promise.resolve(
        id === "steward"
          ? [{ submissionId: FROG, state: "needs_manual_review" }]
          : null,
      ),
    mine: () => Promise.resolve([CLAIMED]),
    setRecipient: (id: string, recipient: string) => {
      recipients.push(recipient);
      return Promise.resolve(
        id === "steward"
          ? { recipient, setAt: "2026-10-16T00:00:00.000Z" }
          : null,
      );
    },
  } as unknown as ClaimService;
  const app = new Hono();
  registerClaimRoutes(app, service, (c, privileged) => {
    const who = c.req.header("x-test-user") ?? null;
    return Promise.resolve(privileged && who === "stale" ? null : who);
  });
  const call = (method: string, path: string, body?: unknown, user = "101") =>
    app.request(path, {
      method,
      headers: { "x-test-user": user, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, call, starts, recipients };
}

test("addresses are normalised to raw mainnet basechain form", () => {
  assert.equal(rawMainnetAddress(RAW.toUpperCase().replace("0X", "0x")), RAW);
  assert.equal(rawMainnetAddress(`-1:${"a".repeat(64)}`), null);
  assert.equal(rawMainnetAddress("not an address"), null);
  assert.equal(rawMainnetAddress(42), null);
});

test("claim start input requires a sender and allows an optional name", () => {
  assert.equal(parseClaimStart({}), "invalid_body");
  assert.deepEqual(parseClaimStart({ sender: RAW }), {
    sender: RAW,
    username: null,
  });
  assert.equal(parseClaimStart({ sender: RAW, name: "" }), "invalid_name");
  assert.equal(parseClaimStart({ sender: RAW, name: 5 }), "invalid_name");
  assert.deepEqual(parseClaimStart({ sender: RAW, name: "Beta" }), {
    sender: RAW,
    username: "Beta",
  });
});

test("claim start maps refusals to statuses and needs a fresh launch", async () => {
  const { call, starts } = build();
  assert.equal(
    (await call("POST", `/v1/splash/claims/${FROG}`, { sender: RAW }, "stale"))
      .status,
    401,
  );
  assert.equal(
    (await call("POST", "/v1/splash/claims/nope", { sender: RAW })).status,
    404,
  );
  assert.equal(
    (await call("POST", `/v1/splash/claims/${FROG}`, { sender: "x" })).status,
    400,
  );
  const refused = await call("POST", `/v1/splash/claims/${FROG}`, {
    sender: RAW,
    name: "Beta",
  });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "not_winner" });
  assert.deepEqual(starts, [["101", FROG, RAW, "Beta"]]);
  for (const [status, code] of [
    ["claim_expired", 409],
    ["already_claimed", 409],
    ["burned", 409],
    ["name_required", 400],
    ["name_taken", 409],
    ["recipient_unset", 503],
    ["wallet_not_linked", 403],
  ] as const) {
    const { call } = build({ status } as StartResult);
    assert.equal(
      (await call("POST", `/v1/splash/claims/${FROG}`, { sender: RAW })).status,
      code,
    );
  }
});

test("a ready claim returns the payment intent for the window", async () => {
  const payment = {
    intentId: "33333333-3333-4333-8333-333333333333",
    status: "prepared",
  };
  const { call } = build({
    status: "ready",
    payment,
  } as unknown as StartResult);
  const response = await call("POST", `/v1/splash/claims/${FROG}`, {
    sender: RAW,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready", payment });
});

test("status and own claims show the claimed frog", async () => {
  const { call } = build();
  const status = await (await call("GET", `/v1/splash/claims/${FROG}`)).json();
  assert.deepEqual(status.claim.frog, {
    frog_id: FROG,
    username: "Alpha",
    background_color: "#112233",
    accent_color: "#445566",
  });
  assert.equal(status.claim.payment.status, "paid");
  assert.equal(
    (
      await call(
        "GET",
        "/v1/splash/claims/22222222-2222-4222-8222-222222222222",
      )
    ).status,
    404,
  );
  const mine = await (await call("GET", "/v1/splash/claims/mine")).json();
  assert.equal(mine.claims.length, 1);
  assert.equal(
    (await call("GET", "/v1/splash/claims/mine", undefined, "")).status,
    401,
  );
});

test("only the steward can change the recipient", async () => {
  const { call, recipients } = build();
  assert.equal(
    (
      await call(
        "PUT",
        "/v1/splash/settings/recipient",
        { address: "x" },
        "steward",
      )
    ).status,
    400,
  );
  assert.equal(
    (await call("PUT", "/v1/splash/settings/recipient", { address: RAW }))
      .status,
    403,
  );
  const saved = await call(
    "PUT",
    "/v1/splash/settings/recipient",
    { address: RAW },
    "steward",
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    recipient: RAW,
    set_at: "2026-10-16T00:00:00.000Z",
  });
  assert.deepEqual(recipients, [RAW, RAW]);
});

test("only the steward sees the manual review queue", async () => {
  const { call } = build();
  const path = "/v1/splash/claims/reviews";
  assert.equal((await call("GET", path, undefined, "")).status, 401);
  assert.equal((await call("GET", path)).status, 403);
  const response = await call("GET", path, undefined, "steward");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    claims: [{ submission_id: FROG, state: "needs_manual_review" }],
  });
});
