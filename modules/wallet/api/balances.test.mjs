import test from "node:test";
import assert from "node:assert/strict";
import { createWalletBalanceReader, JPEGPE_JETTON_MASTER } from "./balances.ts";

const address = "0:" + "1".repeat(64);
test("balances preserve exact integer strings, canonical master and short cache", async () => {
  let now = 1_000_000;
  const calls = [];
  const fetcher = (url) => {
    calls.push(String(url));
    return Promise.resolve(
      Response.json(
        String(url).endsWith("/jettons")
          ? {
              balances: [
                {
                  balance: "999999999999999999999",
                  jetton: { address: "0:" + "2".repeat(64), decimals: 9 },
                },
                {
                  balance: "12345678901234567890",
                  jetton: { address: JPEGPE_JETTON_MASTER, decimals: 9 },
                },
              ],
            }
          : { balance: "900719925474099312345" },
      ),
    );
  };
  const read = createWalletBalanceReader(fetcher, () => now);
  const first = await read(address);
  assert.equal(first.gram.raw, "900719925474099312345");
  assert.equal(first.jpegpe.raw, "12345678901234567890");
  assert.equal(calls.length, 2);
  await read(address);
  assert.equal(calls.length, 2);
  now += 31_000;
  await read(address);
  assert.equal(calls.length, 4);
  await assert.rejects(read(address, "-3"), /wrong_network/);
});

test("wrong jetton decimals and unsafe numeric responses never become balances", async () => {
  const fetcher = (url) =>
    Promise.resolve(
      Response.json(
        String(url).endsWith("/jettons")
          ? {
              balances: [
                {
                  balance: "7",
                  jetton: { address: JPEGPE_JETTON_MASTER, decimals: 6 },
                },
              ],
            }
          : { balance: Number.MAX_SAFE_INTEGER + 1 },
      ),
    );
  const read = createWalletBalanceReader(fetcher);
  const value = await read(address);
  assert.equal(value.gram, null);
  assert.equal(value.jpegpe, null);
});
