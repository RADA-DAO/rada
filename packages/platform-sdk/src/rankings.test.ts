import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHolders, rankingsAdapter } from "./rankings.ts";

const entry = {
  rank: 1,
  frogId: "00000000-0000-4000-8000-000000000011",
  frogName: "@frog",
  amount: "9007199254740993000000000",
  asOf: "2026-10-17T10:00:00Z",
  stale: false,
};
const page = { token: "TON", entries: [entry], nextCursor: null };
await test("holders parser keeps exact amounts and only public projection fields", () => {
  assert.deepEqual(
    parseHolders(
      { ...page, entries: [{ ...entry, private: "ignored" }] },
      "TON",
    ),
    page,
  );
  for (const invalid of [
    null,
    { ...page, token: "JPEGPE" },
    { ...page, entries: [null] },
    ...[
      { amount: "1.1" },
      { asOf: "invalid" },
      { rank: -1 },
      { frogId: "invalid" },
    ].map((change) => ({ ...page, entries: [{ ...entry, ...change }] })),
  ]) {
    assert.throws(() => parseHolders(invalid, "TON"));
  }
});
await test("holders adapter encodes cursor, sends signed launches and identifies revision conflicts", async () => {
  const original = globalThis.fetch;
  const signal = new AbortController().signal;
  let status = 200;
  globalThis.fetch = (input, init) => {
    assert.ok(init);
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.searchParams.get("token"), "TON");
    assert.equal(url.searchParams.get("cursor"), "TON:revision:50");
    assert.equal(
      (init.headers as Record<string, string>).Authorization,
      "tma synthetic",
    );
    assert.equal(init.signal, signal);
    assert.equal(init.credentials, "omit");
    return Promise.resolve(Response.json(page, { status }));
  };
  try {
    const api = rankingsAdapter("https://fixture.example", () => ({
      Authorization: "tma synthetic",
    }));
    assert.deepEqual(
      await api.readHolders("TON", "TON:revision:50", signal),
      page,
    );
    status = 409;
    await assert.rejects(
      api.readHolders("TON", "TON:revision:50", signal),
      /ranking_changed/,
    );
    status = 503;
    await assert.rejects(
      api.readHolders("TON", "TON:revision:50", signal),
      /unavailable/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
