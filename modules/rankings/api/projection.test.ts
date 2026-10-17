import assert from "node:assert/strict";
import test from "node:test";
import { refreshHolders, type Sample } from "./projection.ts";
const wallet = {
  subject_id: "private",
  frog_id: "frog",
  link_version: "v",
  address: "a",
};
const amount = (raw: string) => ({ raw, decimals: 9, formatted: raw });
test("sums every wallet exactly and uses the oldest read, separately per token", async () => {
  const samples: Sample[] = [];
  let pauses = 0;
  await refreshHolders(
    {
      wallets: () => Promise.resolve([wallet, { ...wallet, address: "b" }]),
      read: (address) =>
        Promise.resolve({
          gram: amount(address === "a" ? "9007199254740993" : "7"),
          jpegpe: amount("0"),
          balancesUpdatedAt:
            address === "a"
              ? "2026-10-17T00:00:00.000Z"
              : "2026-10-17T01:00:00.000Z",
        }),
    },
    {
      prune: () => Promise.resolve(),
      record: (_, sample) => {
        samples.push(sample);
        return Promise.resolve();
      },
    },
    () => {
      pauses++;
      return Promise.resolve();
    },
  );
  assert.equal(pauses, 2);
  assert.deepEqual(samples, [
    {
      token: "TON",
      amount: "9007199254741000",
      asOf: "2026-10-17T00:00:00.000Z",
    },
    { token: "JPEGPE", amount: "0", asOf: "2026-10-17T00:00:00.000Z" },
  ]);
});
test("unknown or failed wallet reads do not replace complete cached totals", async () => {
  for (const throws of [true, false]) {
    const samples: Sample[] = [];
    await refreshHolders(
      {
        wallets: () => Promise.resolve([wallet, { ...wallet, address: "b" }]),
        read: (address) => {
          if (address === "b" && throws)
            return Promise.reject(new Error("offline"));
          return Promise.resolve({
            gram: amount("5"),
            jpegpe: address === "b" ? null : amount("1"),
            balancesUpdatedAt: "2026-10-17T00:00:00.000Z",
          });
        },
      },
      {
        prune: () => Promise.resolve(),
        record: (_, sample) => {
          samples.push(sample);
          return Promise.resolve();
        },
      },
      () => Promise.resolve(),
    );
    assert.deepEqual(
      samples.map((sample) => sample.token),
      throws ? [] : ["TON"],
    );
  }
});
test("empty eligibility still prunes cached profiles and never reads a wallet", async () => {
  let pruned = 0;
  await refreshHolders(
    {
      wallets: () => Promise.resolve([]),
      read: () => Promise.reject(new Error("unexpected")),
    },
    {
      prune: () => {
        pruned++;
        return Promise.resolve();
      },
      record: () => Promise.reject(new Error("unexpected record")),
    },
    () => Promise.resolve(),
  );
  assert.equal(pruned, 2);
});
