import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  committedColorRound,
  drawFrogColors,
  type ColorDrop,
} from "../../jpegpe/index.ts";
import type { PaymentView } from "../../wallet/index.ts";
import { ClaimService, type ClaimPayments } from "./claim-service.ts";
import type { ClaimDb, ClaimTerms, OpenClaimRow } from "./claims.ts";

const FROG = "11111111-1111-4111-8111-111111111111";
const WALLET = `0:${"7".repeat(64)}`;
const OTHER_WALLET = `0:${"8".repeat(64)}`;
const RECIPIENT = `0:${"9".repeat(64)}`;
const DEADLINE = new Date("2026-10-18T00:00:00.000Z");
const terms = (open: ClaimTerms["open"] = null): ClaimTerms => ({
  status: "ready",
  amount: "500",
  recipient: RECIPIENT,
  username: "Alpha",
  claimDeadline: DEADLINE,
  signBefore: new Date(DEADLINE.getTime() - 120_000),
  nextAttempt: open ? 2 : 1,
  open,
});
const payment = (
  intentId: string,
  status: PaymentView["status"],
  sender = WALLET,
): PaymentView => ({
  intentId,
  token: "JPEGPE",
  amount: "500",
  recipient: RECIPIENT,
  sender,
  purpose: `splash:${FROG}`,
  createdAt: "2026-10-17T00:00:00.000Z",
  status,
  network: "-239",
  gasBudget: "100000000",
  feeEstimate: null,
  paidOnChainAt: null,
});
const named = (name: string) => Object.assign(new Error(name), { name });
const DROP = { background: {}, accent: {} } as unknown as ColorDrop;

function build(
  options: {
    prepared?: ClaimTerms | { status: "not_winner" };
    current?: PaymentView["status"];
    prepareError?: Error;
    reconcileError?: Error;
    open?: OpenClaimRow[];
    paid?: boolean;
    refreshed?: OpenClaimRow[];
    scanStatus?: PaymentView["scanStatus"];
  } = {},
) {
  const calls: string[] = [];
  const keys: string[] = [];
  const burned = new Set<string>();
  const db: ClaimDb = {
    reviews: () => Promise.resolve([]),
    review: (id) => {
      burned.add(id);
      calls.push(`review:${id}`);
      return Promise.resolve();
    },
    subjectOf: (id) => Promise.resolve(`subject-${id}`),
    prepare: () => Promise.resolve(options.prepared ?? terms()),
    record: (_s, _f, attempt, intent) => {
      calls.push(`record:${String(attempt)}:${intent}`);
      return Promise.resolve("recorded");
    },
    mine: () => Promise.resolve([]),
    setRecipient: () => Promise.resolve(null),
    openClaims: () => Promise.resolve(options.open ?? []),
    withLockedClaim: (id, run) =>
      run(
        db,
        burned.has(id)
          ? []
          : (id === FROG
              ? (options.refreshed ?? options.open ?? [])
              : (options.open ?? [])
            ).filter((attempt) => attempt.submissionId === id),
      ),
    claimPayment: () =>
      Promise.resolve(
        options.paid
          ? {
              intentId: "paid-intent",
              paidOnChainAt: new Date(DEADLINE.getTime() - 1000),
              colorRound: 42,
            }
          : null,
      ),
    complete: () => {
      calls.push("complete");
      return Promise.resolve("claimed");
    },
    burn: (id) => {
      burned.add(id);
      calls.push(`burn:${id}`);
      return Promise.resolve(true);
    },
  };
  const payments: ClaimPayments = {
    preparePlatform: (subject, input, signBefore) => {
      keys.push(input.idempotencyKey);
      assert.equal(subject, "subject-101");
      assert.deepEqual(
        [
          input.appId,
          input.token,
          input.amount,
          input.recipient,
          input.purpose,
        ],
        ["splash", "JPEGPE", "500", RECIPIENT, `splash:${FROG}`],
      );
      assert.equal(signBefore.getTime(), DEADLINE.getTime() - 120_000);
      if (options.prepareError) return Promise.reject(options.prepareError);
      return Promise.resolve(
        payment(`intent-${input.idempotencyKey}`, "prepared"),
      );
    },
    reconcileAs: (_s, appId, intentId) => {
      calls.push(`reconcile:${intentId}`);
      assert.equal(appId, "splash");
      if (options.reconcileError) return Promise.reject(options.reconcileError);
      return Promise.resolve({
        ...payment(intentId, options.current ?? "prepared"),
        ...(options.scanStatus ? { scanStatus: options.scanStatus } : {}),
      });
    },
    cancelAs: (_s, _a, intentId) => {
      calls.push(`cancel:${intentId}`);
      return Promise.resolve(payment(intentId, "cancelled"));
    },
  };
  const colors = (input: {
    frogId: string;
    requestId: string;
    round: number;
  }) => {
    calls.push(`colors:${input.requestId}:${String(input.round)}`);
    return Promise.resolve(DROP);
  };
  const logs: string[] = [];
  const service = new ClaimService(db, payments, colors, (line) =>
    logs.push(line),
  );
  return { service, calls, keys, logs };
}

test("a refusal from SQL is returned and no payment is prepared", async () => {
  const { service, keys } = build({ prepared: { status: "not_winner" } });
  assert.deepEqual(await service.start("101", FROG, WALLET, null), {
    status: "not_winner",
  });
  assert.deepEqual(keys, []);
});

test("the first start prepares one intent with the fixed terms and records it", async () => {
  const { service, calls, keys } = build();
  const result = await service.start("101", FROG, WALLET, null);
  assert.equal(result.status, "ready");
  assert.deepEqual(keys, [`claim-${FROG}-1`]);
  assert.deepEqual(calls, [`record:1:intent-claim-${FROG}-1`]);
});

test("a repeated start with the same wallet resumes the same intent", async () => {
  const open = {
    intentId: `intent-claim-${FROG}-1`,
    sender: WALLET,
    recipient: RECIPIENT,
  };
  const { service, keys } = build({ prepared: terms(open) });
  await service.start("101", FROG, WALLET, null);
  assert.deepEqual(keys, [`claim-${FROG}-1`]);
});

test("another wallet or recipient cancels the unsigned intent before a new attempt", async () => {
  const open = { intentId: "old", sender: OTHER_WALLET, recipient: RECIPIENT };
  const { service, calls, keys } = build({ prepared: terms(open) });
  await service.start("101", FROG, WALLET, null);
  assert.deepEqual(keys, [`claim-${FROG}-2`]);
  assert.deepEqual(calls.slice(0, 2), ["reconcile:old", "cancel:old"]);
  const moved = build({
    prepared: terms({
      intentId: "old",
      sender: WALLET,
      recipient: OTHER_WALLET,
    }),
  });
  await moved.service.start("101", FROG, WALLET, null);
  assert.deepEqual(moved.keys, [`claim-${FROG}-2`]);
});

test("a signed attempt blocks a second payable intent", async () => {
  const open = {
    intentId: "signed",
    sender: OTHER_WALLET,
    recipient: RECIPIENT,
  };
  const { service, keys } = build({
    prepared: terms(open),
    current: "unknown",
  });
  assert.equal(
    (await service.start("101", FROG, WALLET, null)).status,
    "payment_pending",
  );
  assert.deepEqual(keys, []);
});

test("a paid attempt completes the claim instead of preparing another payment", async () => {
  const open = {
    intentId: "paid-intent",
    sender: WALLET,
    recipient: RECIPIENT,
  };
  const { service, calls, keys } = build({
    prepared: terms(open),
    current: "paid",
    paid: true,
  });
  assert.equal((await service.start("101", FROG, WALLET, null)).status, "paid");
  assert.deepEqual(keys, []);
  assert.deepEqual(calls.slice(1), ["colors:paid-intent:42", "complete"]);
});

test("wallet refusals map to claim refusals", async () => {
  const denied = build({ prepareError: named("PaymentDenied") });
  assert.deepEqual(await denied.service.start("101", FROG, WALLET, null), {
    status: "wallet_not_linked",
  });
  const conflict = build({ prepareError: named("PaymentConflict") });
  assert.deepEqual(await conflict.service.start("101", FROG, WALLET, null), {
    status: "conflict",
  });
});

const row = (patch: Partial<OpenClaimRow> = {}): OpenClaimRow => ({
  submissionId: FROG,
  winnerSubjectId: "winner",
  burnAfter: new Date(DEADLINE.getTime() + 30 * 60_000),
  intentId: null,
  paymentStatus: null,
  ...patch,
});

test("the timer burns only after the grace period and never on a chain error", async () => {
  const before = build({ open: [row()] });
  await before.service.settle(() => DEADLINE.getTime() + 29 * 60_000);
  assert.deepEqual(before.calls, []);
  const after = build({ open: [row()] });
  await after.service.settle(() => DEADLINE.getTime() + 31 * 60_000);
  assert.deepEqual(after.calls, [`burn:${FROG}`]);
  const unreadable = build({
    open: [row({ intentId: "signed", paymentStatus: "unknown" })],
    reconcileError: new Error("chain_unavailable"),
  });
  await unreadable.service.settle(() => DEADLINE.getTime() + 31 * 60_000);
  assert.deepEqual(unreadable.calls, ["reconcile:signed"]);
  assert.equal(unreadable.logs.length, 0);
});

test("the timer completes a payment confirmed before the deadline, even after it", async () => {
  const { service, calls } = build({
    open: [row({ intentId: "paid-intent", paymentStatus: "unknown" })],
    paid: true,
  });
  await service.settle(() => DEADLINE.getTime() + 60 * 60_000);
  assert.deepEqual(calls, [
    "reconcile:paid-intent",
    "colors:paid-intent:42",
    "complete",
  ]);
});

test("the committed colour round matches splash.color_round and the proofs fit SQL", async () => {
  const genesis = 1_692_803_367;
  for (const seconds of [
    genesis,
    genesis + 1,
    genesis + 2,
    genesis + 3,
    1_790_000_000,
  ])
    assert.equal(
      committedColorRound(seconds * 1000),
      Math.floor((seconds - genesis) / 3) + 2,
    );
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../../jpegpe/color-protocol/fixtures/background-proof-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { round: number; randomness: string; signature: string };
  const drop = await drawFrogColors(
    {
      frogId: FROG,
      requestId: "22222222-2222-4222-8222-222222222222",
      round: fixture.round,
    },
    (round) =>
      Promise.resolve({
        round,
        randomness: fixture.randomness,
        signature: fixture.signature,
      }),
  );
  for (const [purpose, proof] of Object.entries(drop)) {
    assert.equal(proof.purpose, purpose);
    assert.equal(proof.round, String(fixture.round));
    assert.match(proof.colorHex, /^#[0-9A-F]{6}$/);
    assert.match(proof.signature, /^[0-9a-f]{96}$/);
    assert.equal(proof.protocolVersion, 1);
  }
  assert.notEqual(drop.background.colorHex, drop.accent.colorHex);
});

test("a 1,001-row boundary refreshes the later signed attempt after a cancellation", async () => {
  const prior = Array.from({ length: 999 }, (_, index) =>
    row({ submissionId: `frog-${index}` }),
  );
  const cancelled = row({ intentId: "cancelled", paymentStatus: "cancelled" });
  const signed = row({ intentId: "signed", paymentStatus: "unknown" });
  const { service, calls } = build({
    open: [...prior, cancelled],
    refreshed: [cancelled, signed],
    scanStatus: "incomplete",
  });
  await service.settle(() => DEADLINE.getTime() + 31 * 60_000);
  assert.ok(calls.includes("reconcile:signed"));
  assert.ok(!calls.includes(`burn:${FROG}`));
});

test("only a complete negative scan after grace authorizes a burn", async () => {
  for (const scanStatus of [
    undefined,
    "incomplete",
    "confirmed-absent",
  ] as const) {
    const { service, calls } = build({
      open: [row({ intentId: "signed", paymentStatus: "unknown" })],
      scanStatus,
    });
    await service.settle(() => DEADLINE.getTime() + 31 * 60_000);
    await service.settle(() => DEADLINE.getTime() + 32 * 60_000);
    assert.equal(
      calls.filter((call) => call === `burn:${FROG}`).length,
      scanStatus === "confirmed-absent" ? 1 : 0,
    );
    assert.equal(
      calls.includes(`burn:${FROG}`),
      scanStatus === "confirmed-absent",
    );
  }
});

test("max deferral holds a frog for review even if absence later becomes available", async () => {
  for (const scanStatus of ["incomplete", "confirmed-absent"] as const) {
    const { service, calls } = build({
      open: [row({ intentId: "signed", paymentStatus: "unknown" })],
      scanStatus,
    });
    const now = () => DEADLINE.getTime() + (24 * 60 + 30) * 60_000;
    await service.settle(now);
    await service.settle(now);
    assert.equal(calls.filter((call) => call === `review:${FROG}`).length, 1);
    assert.ok(!calls.includes(`burn:${FROG}`));
  }
  const failing = build({
    open: [row({ intentId: "signed", paymentStatus: "unknown" })],
    reconcileError: new Error("offline"),
  });
  await failing.service.settle(() => DEADLINE.getTime() + 25 * 60 * 60_000);
  assert.ok(failing.calls.includes(`review:${FROG}`));
});
