import assert from "node:assert/strict";
import test from "node:test";
import { PaymentChain, type PaymentRecord } from "./payment-chain.ts";
import { JPEGPE_JETTON_MASTER } from "./balances.ts";

const address = (digit: string) => `0:${digit.repeat(64)}`;
const intent: PaymentRecord = {
  intentId: "00000000-0000-4000-8000-000000000001",
  token: "TON",
  amount: "1000000000",
  recipient: address("1"),
  sender: address("2"),
  purpose: "Test order",
  createdAt: "2026-10-15T00:00:00.000Z",
};
const comment = `RADA:${intent.intentId}:${intent.purpose}`;
function send(body: unknown): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
}
test("TON receipt needs finalized successful inbound with exact sender, amount and reference", async () => {
  const tx = {
    hash: "a".repeat(64),
    account: intent.recipient,
    finality: "finalized",
    emulated: false,
    mc_block_seqno: 100,
    now: 1792022401,
    description: { aborted: false },
    in_msg: {
      source: intent.sender,
      destination: intent.recipient,
      value: intent.amount,
      bounced: false,
      message_content: { decoded: { comment } },
    },
  };
  assert.equal(
    await new PaymentChain(send({ transactions: [tx] })).receipt(intent),
    "a".repeat(64),
  );
  // The confirmation carries the recipient transaction time for deadlines.
  assert.deepEqual(
    await new PaymentChain(send({ transactions: [tx] })).confirmation(intent),
    { hash: "a".repeat(64), onChainAt: 1792022401 },
  );
  for (const patch of [
    { finality: "pending" },
    { now: NaN },
    { now: undefined },
    { now: 0 },
    { hash: "invalid" },
    { account: address("5") },
    { in_msg: { ...tx.in_msg, source: address("5") } },
    { in_msg: { ...tx.in_msg, destination: address("5") } },
    { emulated: true },
    { description: { aborted: true } },
    { in_msg: { ...tx.in_msg, bounced: true } },
    { in_msg: { ...tx.in_msg, value: "1" } },
    {
      in_msg: {
        ...tx.in_msg,
        message_content: { decoded: { comment: "other" } },
      },
    },
  ]) {
    assert.equal(
      await new PaymentChain(
        send({ transactions: [{ ...tx, ...patch }] }),
      ).receipt(intent),
      null,
    );
  }
});
test("jetton receipt needs canonical wallets and successful recipient notification", async () => {
  const payment = { ...intent, token: "JPEGPE" as const };
  const sourceWallet = address("3"),
    recipientWallet = address("4");
  const transfer = {
    source: intent.sender,
    destination: intent.recipient,
    jetton_master: JPEGPE_JETTON_MASTER,
    amount: intent.amount,
    transaction_aborted: false,
    transaction_now: 1792022401,
    decoded_forward_payload: { comment },
    source_wallet: sourceWallet,
    trace_id: "trace-one",
  };
  const notification = {
    hash: "b".repeat(64),
    mc_block_seqno: 100,
    finality: "finalized",
    emulated: false,
    now: 1792022401,
    account: intent.recipient,
    description: { aborted: false },
    in_msg: {
      source: recipientWallet,
      destination: intent.recipient,
      opcode: "0x7362d09c",
      bounced: false,
      message_content: {
        decoded: {
          amount: { value: intent.amount },
          sender: intent.sender,
          forward_payload: { value: { text: comment } },
        },
      },
    },
  };
  const body = (row = transfer, tx = notification) => [
    { jetton_transfers: [row] },
    {
      traces: [
        {
          is_incomplete: false,
          mc_seqno_end: "100",
          trace_info: { trace_state: "complete" },
          transactions: { one: tx },
        },
      ],
    },
  ];
  const chain = (bodies: unknown[]) =>
    new PaymentChain(
      () =>
        Promise.resolve(
          new Response(JSON.stringify(bodies.shift()), { status: 200 }),
        ),
      (owner) =>
        Promise.resolve(
          owner === intent.sender ? sourceWallet : recipientWallet,
        ),
    );
  assert.equal(await chain(body()).receipt(payment), "b".repeat(64));
  assert.equal(
    (await chain(body()).confirmation(payment))?.onChainAt,
    Number(notification.now),
  );
  for (const patch of [
    { jetton_master: address("5") },
    { source: address("5") },
    { destination: address("5") },
    { amount: "1" },
    { transaction_aborted: true },
    { transaction_now: 0 },
    { decoded_forward_payload: { comment: "wrong intent" } },
  ])
    assert.equal(
      await chain(body({ ...transfer, ...patch })).receipt(payment),
      null,
    );
  for (const patch of [
    { finality: "confirmed" },
    { emulated: true },
    { mc_block_seqno: 0 },
    { now: 0 },
    { account: address("5") },
    { in_msg: { ...notification.in_msg, bounced: true } },
    { in_msg: { ...notification.in_msg, source: sourceWallet } },
    { in_msg: { ...notification.in_msg, destination: address("5") } },
  ])
    assert.equal(
      await chain(body(transfer, { ...notification, ...patch })).receipt(
        payment,
      ),
      null,
    );
  const incomplete = body();
  incomplete[1]!.traces![0]!.is_incomplete = true;
  assert.equal(await chain(incomplete).receipt(payment), null);
  assert.equal(
    await chain(body({ ...transfer, source_wallet: address("5") })).receipt(
      payment,
    ),
    null,
  );
  assert.equal(
    await chain(
      body(transfer, { ...notification, description: { aborted: true } }),
    ).receipt(payment),
    null,
  );
});

test("a signing deadline caps the signed message lifetime", async () => {
  const chain = new PaymentChain(send({}));
  const now = Math.floor(Date.now() / 1000);
  assert.ok((await chain.signRequest(intent)).validUntil >= now + 179);
  assert.equal(
    (await chain.signRequest(intent, now + 30)).validUntil,
    now + 30,
  );
  assert.ok(
    (await chain.signRequest(intent, now + 9999)).validUntil <= now + 181,
  );
});
