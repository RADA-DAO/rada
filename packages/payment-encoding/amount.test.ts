import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PAYMENT_AMOUNT, validPaymentAmount } from "./amount.ts";

test("payment amounts accept the encoding maximum and refuse its successor", () => {
  assert.equal(validPaymentAmount(String(MAX_PAYMENT_AMOUNT)), true);
  for (const value of [
    String(MAX_PAYMENT_AMOUNT + 1n),
    "0",
    "-1",
    "1.5",
    "01",
    "9".repeat(100),
    "NaN",
  ])
    assert.equal(validPaymentAmount(value), false, value);
});
