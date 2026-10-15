import test from "node:test";
import assert from "node:assert/strict";
import { Address } from "@ton/ton";
import { walletAdapter } from "./wallet.ts";

const first = Address.parseRaw(`0:${"1".repeat(64)}`).toString({
  bounceable: false,
});
const second = Address.parseRaw(`0:${"2".repeat(64)}`).toString({
  bounceable: false,
});
const now = "2026-10-15T12:00:00.000Z";
const money = (raw: string, formatted: string) => ({
  raw,
  decimals: 9,
  formatted,
});

await test("app wallet reads strip unexpected fields and recheck through the API each time", async (t) => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", (url: string | URL | Request) => {
    paths.push(url instanceof Request ? url.url : url.toString());
    return Promise.resolve(
      Response.json(
        paths.length === 1
          ? {
              wallets: [{ address: first, network: "-239", telegramId: 101 }],
              rawProof: "private",
            }
          : {
              wallets: [
                {
                  tonNano: "12345678901234567890",
                  jpegpeNano: null,
                  address: first,
                },
              ],
              rawProof: "private",
            },
      ),
    );
  });
  const adapter = walletAdapter("/api/me", () => ({
    Authorization: "tma synthetic",
  }));
  assert.deepEqual(await adapter.readAppWalletAddress("fixture.app"), {
    wallets: [{ address: first, network: "-239" }],
  });
  assert.deepEqual(await adapter.readAppWalletBalances("fixture.app"), {
    wallets: [{ tonNano: "12345678901234567890", jpegpeNano: null }],
  });
  assert.deepEqual(paths, [
    "/api/apps/fixture.app/wallet/address",
    "/api/apps/fixture.app/wallet/balances",
  ]);
});

await test("wallet DTO parser rejects missing fields, invalid amounts, duplicate addresses and excess entries", async (t) => {
  let response: unknown = { wallets: [] };
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(Response.json(response)),
  );
  const adapter = walletAdapter("/api/me", () => ({
    Authorization: "tma synthetic",
  }));
  for (response of [
    null,
    { wallets: [{}] },
    { wallets: [{ address: first, network: "-3" }] },
    {
      wallets: [
        {
          address: Address.parseRaw(`0:${"1".repeat(64)}`).toString({
            testOnly: true,
          }),
          network: "-239",
        },
      ],
    },
    { wallets: Array(17).fill({ address: first, network: "-239" }) },
    {
      wallets: [
        { address: first, network: "-239" },
        { address: first, network: "-239" },
      ],
    },
  ])
    await assert.rejects(
      adapter.readAppWalletAddress("fixture.app"),
      /unavailable/,
    );
  for (response of [
    { wallets: [{ tonNano: 2, jpegpeNano: null }] },
    { wallets: [{ tonNano: "1.5", jpegpeNano: null }] },
    { wallets: [{ tonNano: "0", jpegpeNano: undefined }] },
    {
      wallets: [
        { tonNano: "0", jpegpeNano: null },
        ...Array.from({ length: 16 }, () => ({
          tonNano: null,
          jpegpeNano: null,
        })),
      ],
    },
  ])
    await assert.rejects(
      adapter.readAppWalletBalances("fixture.app"),
      /unavailable/,
    );
});

await test("own wallet data is validated and returned as a clean projection", async (t) => {
  let response: unknown = {
    wallets: [
      { address: first, network: "-239", verifiedAt: now, rawProof: "private" },
    ],
  };
  t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(Response.json(response)),
  );
  const adapter = walletAdapter("/api/me", () => ({
    Authorization: "tma synthetic",
  }));
  assert.deepEqual(await adapter.readOwnWallets(), [
    { address: first, network: "-239", verifiedAt: now },
  ]);
  response = {
    wallets: [
      {
        address: second,
        balances: {
          gram: money("1000000001", "1.000000001"),
          jpegpe: null,
          balancesUpdatedAt: now,
          private: "omit",
        },
        secret: "omit",
      },
    ],
  };
  assert.deepEqual(await adapter.readOwnWalletBalances(), [
    {
      address: second,
      balances: {
        gram: money("1000000001", "1.000000001"),
        jpegpe: null,
        balancesUpdatedAt: now,
      },
    },
  ]);
  response = {
    wallets: [
      {
        address: second,
        balances: {
          gram: money("1000000001", "1.2"),
          jpegpe: null,
          balancesUpdatedAt: now,
        },
      },
    ],
  };
  await assert.rejects(adapter.readOwnWalletBalances(), /unavailable/);
});

await test("missing auth and current 403 consent deny fail closed", async (t) => {
  const calls = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(new Response("{}", { status: 403 })),
  );
  const guest = walletAdapter("/api/me", () => null);
  await assert.rejects(guest.readAppWalletAddress("fixture.app"), /expired/);
  assert.equal(calls.mock.callCount(), 0);
  const signed = walletAdapter("/api/me", () => ({
    Authorization: "tma synthetic",
  }));
  await assert.rejects(
    signed.readAppWalletAddress("fixture.app"),
    /capability_denied/,
  );
  await assert.rejects(
    signed.readAppWalletAddress("fixture.app"),
    /capability_denied/,
  );
  assert.equal(calls.mock.callCount(), 2);
});
