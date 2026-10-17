// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeTreasuryRows,
  createTreasuryChainReader,
} from "./treasury-chain.ts";
const address = `0:${"1".repeat(64)}`,
  other = `0:${"2".repeat(64)}`,
  hash = "a".repeat(64);
await test("normalization keeps exact amounts and hash but drops provider labels and private comments", () => {
  const row = {
    account: address,
    hash,
    now: 1700000000,
    description: { aborted: false },
    in_msg: {
      source: other,
      destination: address,
      value: "12345678901234567890",
      comment: "private",
      name: "Telegram",
    },
    out_msgs: [],
  };
  const result = normalizeTreasuryRows([row], address, false);
  assert.equal(result[0]?.amount, "12345678901234567890");
  assert.equal(result[0]?.direction, "in");
  assert.equal(result[0]?.hash, hash);
  assert.doesNotMatch(JSON.stringify(result), /Telegram|private/);
  assert.equal(
    normalizeTreasuryRows(
      [
        { ...row, emulated: true },
        { ...row, description: { aborted: true } },
        { ...row, account: other },
      ],
      address,
      false,
    ).length,
    0,
  );
});
await test("reader issues GET only; capped history and missing watermark remain incomplete", async () => {
  const paths: string[] = [];
  const send: typeof fetch = async (input, init) => {
    const url = String(input);
    paths.push(url);
    assert.ok(init?.method === undefined || init.method === "GET");
    if (["tonapi.io", "testnet.tonapi.io"].includes(new URL(url).hostname))
      return Response.json(
        url.endsWith("/jettons") ? { balances: [] } : { balance: "1" },
      );
    if (url.includes("multisig/wallets"))
      return Response.json({ multisigs: [{ address, signers: [other] }] });
    if (url.includes("masterchainInfo") || url.includes("/blocks?"))
      return Response.json({});
    if (url.includes("jetton/transfers"))
      return Response.json({ jetton_transfers: [] });
    return Response.json({
      transactions: Array.from({ length: 100 }, () => ({})),
    });
  };
  const sample = await createTreasuryChainReader(send, async () => {})(address);
  assert.equal(sample.incomplete, true);
  assert.equal(sample.indexedThrough, null);
  assert.deepEqual(sample.signers, [other]);
  assert.equal(paths.filter((p) => p.includes("/transactions?")).length, 3);
  assert.deepEqual(sample.balances, { TON: "1", JPEGPE: "0" });
});

await test("a complete window ends at trusted index coverage, not the unindexed head", async () => {
  const now = Math.floor(Date.now() / 1000),
    watermark = now - 20;
  const block = {
    workchain: -1,
    shard: "8000000000000000",
    seqno: 1,
    gen_utime: watermark,
  };
  const send: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "tonapi.io")
      return Response.json(
        url.pathname.endsWith("/jettons") ? { balances: [] } : { balance: "1" },
      );
    if (url.pathname.endsWith("/masterchainInfo"))
      return Response.json({ last: block });
    if (url.pathname.endsWith("/blocks"))
      return Response.json({ blocks: [block] });
    if (url.pathname.endsWith("/wallets"))
      return Response.json({ multisigs: [] });
    assert.equal(url.searchParams.get("end_utime"), String(watermark));
    return Response.json(
      url.pathname.endsWith("/transfers")
        ? { jetton_transfers: [] }
        : { transactions: [] },
    );
  };
  const sample = await createTreasuryChainReader(send, async () => {})(address);
  assert.equal(sample.incomplete, false);
  assert.equal(sample.indexedThrough, new Date(watermark * 1000).toISOString());
});
