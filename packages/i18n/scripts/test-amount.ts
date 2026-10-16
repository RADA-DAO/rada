import assert from "node:assert/strict";
import { test } from "node:test";
import { displayAmount, parseUnits } from "../src/index.ts";

await test("typed amounts become exact smallest units", () => {
  assert.equal(parseUnits("12", 9), "12000000000");
  assert.equal(parseUnits("1.5", 9), "1500000000");
  assert.equal(parseUnits("1,5", 9), "1500000000");
  assert.equal(parseUnits(" 1 000.000000001 ", 9), "1000000000001");
  for (const bad of [
    "",
    "0",
    "0.0",
    "-1",
    "1e3",
    "1.0000000001",
    "abc",
    "1.2.3",
  ])
    assert.equal(parseUnits(bad, 9), null, bad);
});

await test("amounts format with the locale separator", () => {
  const amount = (raw: string) => ({ raw, decimals: 9 });
  assert.equal(displayAmount(amount("1500000000"), "en", 0, 9), "1.5");
  assert.equal(displayAmount(amount("1500000000"), "uk", 0, 9), "1,5");
  assert.equal(displayAmount(amount("12000000000"), "en", 0, 9), "12");
  assert.equal(displayAmount(null, "en", 2), null);
});
