import assert from "node:assert/strict";
import type pg from "pg";
import { MAX_PAYMENT_AMOUNT } from "../../../packages/payment-encoding/amount.ts";
import {
  PaymentDenied,
  PostgresPaymentStore,
  type PaymentInput,
  PaymentChain,
} from "../../../modules/wallet/index.ts";

Deno.test(
  "platform intents reject out-of-range amounts before database or chain access",
  async () => {
    const pool = {
      connect() {
        throw new Error("unexpected database access");
      },
    } as unknown as pg.Pool;
    const store = new PostgresPaymentStore(pool, pool);
    await assert.rejects(
      store.preparePlatform(
        "subject",
        { amount: String(MAX_PAYMENT_AMOUNT + 1n) } as PaymentInput,
        new Date(),
      ),
      PaymentDenied,
    );
  },
);

Deno.test(
  "platform intent creation accepts the encoding maximum with injected persistence",
  async () => {
    const input: PaymentInput = {
      appId: "splash",
      idempotencyKey: "fixture_key",
      token: "JPEGPE",
      amount: String(MAX_PAYMENT_AMOUNT),
      recipient: `0:${"1".repeat(64)}`,
      sender: `0:${"2".repeat(64)}`,
      purpose: "splash:x",
    };
    const deadline = new Date(Date.now() + 3600000);
    let inserted = false;
    const db = {
      query(sql: string, values?: unknown[]) {
        if (sql.includes("AS released"))
          return Promise.resolve({ rows: [{ released: true, linked: true }] });
        if (sql.includes("INSERT INTO")) {
          assert.equal(values?.[4], input.amount);
          inserted = true;
        }
        if (sql.includes("SELECT * FROM wallet.payment_intents"))
          return Promise.resolve({
            rows: [
              {
                intent_id: "fixture",
                app_id: input.appId,
                idempotency_key: input.idempotencyKey,
                token: input.token,
                amount: input.amount,
                recipient: input.recipient,
                sender: input.sender,
                purpose: input.purpose,
                platform: true,
                sign_before: deadline,
                status: "prepared",
                created_at: new Date(),
              },
            ],
          });
        return Promise.resolve({ rows: [] });
      },
      release() {},
    };
    const pool = { connect: () => Promise.resolve(db) } as unknown as pg.Pool;
    const chain = new PaymentChain();
    chain.estimateFee = () =>
      Promise.resolve({
        nano: "1",
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      });
    const result = await new PostgresPaymentStore(
      pool,
      pool,
      chain,
    ).preparePlatform("subject", input, deadline);
    assert.equal(inserted, true);
    assert.equal(result.amount, input.amount);
  },
);
