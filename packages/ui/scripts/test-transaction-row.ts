import assert from "node:assert/strict";
import { test } from "node:test";
import { fake } from "./fake-dom.ts";
import { TransactionRow } from "../src/index.ts";
await test("transaction rows preserve anonymous copy, exact amount and plain text", () => {
  const row = fake(
    TransactionRow({
      name: "Anonymous",
      direction: "Incoming",
      amount: "123.000000001 TON",
      time: "<time>",
    }),
  );
  const main = row.child(0);
  assert.equal(main.child(0).textContent, "Anonymous");
  assert.equal(main.child(1).textContent, "Incoming");
  assert.equal(main.child(2).textContent, "123.000000001 TON");
  assert.equal(main.child(3).textContent, "<time>");
});
