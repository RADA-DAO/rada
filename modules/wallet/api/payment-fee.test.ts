import assert from "node:assert/strict";
import test from "node:test";
import {
  beginCell,
  WalletContractV4,
  WalletContractV5R1,
  Cell,
  loadMessageRelaxed,
} from "@ton/ton";
import { estimatePaymentFee } from "./payment-fee.ts";
import { PaymentChain } from "./payment-chain.ts";

test("fee estimation emulates the exact transfer for current v4/v5 state without broadcasting", async () => {
  for (const contract of [WalletContractV4, WalletContractV5R1]) {
    const wallet = contract.create({
      workchain: 0,
      publicKey: Buffer.alloc(32, 3),
    });
    const request = await new PaymentChain().signRequest({
      intentId: "00000000-0000-4000-8000-000000000001",
      token: "TON",
      sender: wallet.address.toRawString(),
      recipient: `0:${"1".repeat(64)}`,
      amount: "1000000001",
      purpose: "Fee fixture",
      createdAt: new Date().toISOString(),
    });
    let emulations = 0;
    const quote = await estimatePaymentFee(
      {
        getContractState: () =>
          Promise.resolve({
            state: "active",
            code: wallet.init.code.toBoc(),
            data: wallet.init.data.toBoc(),
            balance: 10_000_000_000n,
            extra_currencies: undefined,
            lastTransaction: null,
            blockId: { workchain: 0, shard: "0", seqno: 100 },
            timestampt: 100,
          }),
        estimateExternalMessageFee: (address, options) => {
          assert.equal(address.toRawString(), request.from);
          assert.equal(options.ignoreSignature, true);
          assert.equal(options.initCode, null);
          // Locate the actual outgoing relaxed message, independent of wallet
          // header and action-list layout. Amount and payload must survive intact.
          const candidates: Cell[] = [];
          const visit = (cell: Cell) => {
            candidates.push(cell);
            for (const ref of cell.refs) visit(ref);
          };
          visit(options.body);
          assert(
            candidates.some((cell) => {
              try {
                const message = loadMessageRelaxed(cell.beginParse());
                return (
                  message.info.type === "internal" &&
                  message.info.value.coins === 1000000001n &&
                  message.info.dest.toRawString() === `0:${"1".repeat(64)}` &&
                  message.body.equals(
                    Cell.fromBase64(request.messages[0]!.payload),
                  )
                );
              } catch {
                return false;
              }
            }),
          );
          emulations++;
          return Promise.resolve({
            "@type": "query.fees",
            source_fees: {
              "@type": "fees",
              in_fwd_fee: 100,
              storage_fee: 200,
              gas_fee: 300,
              fwd_fee: 400,
            },
          });
        },
      },
      request,
    );
    assert.equal(emulations, 1);
    assert.equal(quote.nano, "1000");
    assert(
      quote.expiresAt > Date.now() / 1000 &&
        quote.expiresAt <= Date.now() / 1000 + 60,
    );
  }
});

test("unknown wallet code never gets a fabricated fee", async () => {
  await assert.rejects(
    estimatePaymentFee(
      {
        getContractState: () =>
          Promise.resolve({
            state: "active",
            code: beginCell().storeUint(42, 32).endCell().toBoc(),
            data: beginCell().endCell().toBoc(),
            balance: 1n,
            extra_currencies: undefined,
            lastTransaction: null,
            blockId: { workchain: 0, shard: "0", seqno: 100 },
            timestampt: 100,
          }),
        estimateExternalMessageFee: () => {
          throw new Error("must not emulate unknown code");
        },
      },
      {
        network: "-239",
        from: `0:${"2".repeat(64)}`,
        validUntil: 1,
        messages: [],
      },
    ),
    /fee_unavailable/,
  );
});
