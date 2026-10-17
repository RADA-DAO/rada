import assert from "node:assert/strict";
import test from "node:test";
import { PaymentChain, type PaymentRecord } from "./payment-chain.ts";

const end = Math.floor(Date.now() / 1000) - 3600;
const intent: PaymentRecord = {
  intentId: "00000000-0000-4000-8000-000000000001",
  token: "TON",
  amount: "100",
  purpose: "coverage",
  recipient: `0:${"1".repeat(64)}`,
  sender: `0:${"2".repeat(64)}`,
  createdAt: new Date((end - 3600) * 1000).toISOString(),
};
const block = (time: unknown) => ({
  workchain: -1,
  shard: "8000000000000000",
  seqno: 100,
  gen_utime: time,
});
function provider(first: unknown, second: unknown, rows: unknown[] = []) {
  const paths: string[] = [];
  const send: typeof fetch = (url) => {
    const path = new URL(String(url));
    paths.push(path.pathname);
    if (path.pathname.endsWith("masterchainInfo"))
      return Promise.resolve(Response.json({ last: block(first) }));
    if (path.pathname.endsWith("blocks")) {
      assert.equal(path.searchParams.get("workchain"), "-1");
      assert.equal(path.searchParams.get("sort"), "desc");
      return Promise.resolve(Response.json({ blocks: [block(second)] }));
    }
    return Promise.resolve(Response.json({ transactions: rows }));
  };
  return { chain: new PaymentChain(send), paths };
}

test("two independent indexed reads must cover the window plus the safety margin", async () => {
  for (const [first, second, expected] of [
    [end - 1, end - 1, "incomplete"],
    [end + 599, end + 600, "incomplete"],
    [end + 600, end + 630, "confirmed-absent"],
    [end + 600, end + 631, "incomplete"],
    [null, end + 600, "incomplete"],
    ["bad", end + 600, "incomplete"],
    [end + 99999, end + 99999, "incomplete"],
  ] as const) {
    const { chain, paths } = provider(first, second);
    assert.equal((await chain.confirmation(intent, end)).status, expected);
    assert.equal(paths.length, 3);
  }
});

test("unavailable coverage never hides a receipt found on a late page", async () => {
  let pages = 0;
  const tx = {
    hash: "a".repeat(64),
    account: intent.recipient,
    finality: "finalized",
    emulated: false,
    mc_block_seqno: 100,
    now: end - 1,
    description: { aborted: false },
    in_msg: {
      source: intent.sender,
      destination: intent.recipient,
      value: intent.amount,
      bounced: false,
      message_content: {
        decoded: { comment: `RADA:${intent.intentId}:${intent.purpose}` },
      },
    },
  };
  const chain = new PaymentChain((url) => {
    if (!String(url).includes("transactions?"))
      return Promise.reject(new Error("offline"));
    pages++;
    return Promise.resolve(
      Response.json({
        transactions:
          pages < 3
            ? Array.from({ length: 100 }, () => ({ finality: "finalized" }))
            : [tx],
      }),
    );
  });
  assert.equal((await chain.confirmation(intent, end)).status, "confirmed");
  assert.equal(pages, 3);
});

test("trusted coverage cannot bypass ambiguous rows or the pagination budget", async () => {
  for (const rows of [
    [{ finality: "pending" }],
    Array.from({ length: 100 }, () => ({ finality: "finalized" })),
  ]) {
    const { chain } = provider(end + 600, end + 600, rows);
    assert.equal((await chain.confirmation(intent, end)).status, "incomplete");
  }
});

test("agreed coverage authorizes absence only after the final short page", async () => {
  let pages = 0;
  const chain = new PaymentChain((url) => {
    const path = new URL(String(url));
    if (path.pathname.endsWith("masterchainInfo"))
      return Promise.resolve(Response.json({ last: block(end + 600) }));
    if (path.pathname.endsWith("blocks"))
      return Promise.resolve(Response.json({ blocks: [block(end + 600)] }));
    assert.equal(path.searchParams.get("offset"), String(pages * 100));
    pages++;
    return Promise.resolve(
      Response.json({
        transactions:
          pages < 3
            ? Array.from({ length: 100 }, () => ({ finality: "finalized" }))
            : [],
      }),
    );
  });
  assert.equal(
    (await chain.confirmation(intent, end)).status,
    "confirmed-absent",
  );
  assert.equal(pages, 3);
});
