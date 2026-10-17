import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { readSource } from "./source.ts";
import { canonical, hash, table } from "./model.ts";
await test("canonical checksums ignore object insertion order and preserve exact values", () => {
  assert.equal(
    hash({ b: 1, a: { z: null, y: "9007199254740993" } }),
    hash({ a: { y: "9007199254740993", z: null }, b: 1 }),
  );
  assert.notEqual(hash(["a", "b"]), hash(["b", "a"]));
  assert.notEqual(hash({ color: "#123abc" }), hash({ color: "#123AbC" }));
  assert.equal(canonical(null), "null");
  assert.throws(() => table("wallet"), /Invalid import entity/);
});

await test("source fails when the people projection is empty but inventory is non-zero", async () => {
  const client = {
    query(sql: string) {
      if (sql.includes("tablename AS name"))
        return Promise.resolve({
          rows: [
            "ecosystem_users",
            "jpegpe_frog_submissions",
            "jpegpe_profile_appearances",
          ].map((name) => ({ name })),
        });
      if (sql.includes("count(*)"))
        return Promise.resolve({ rows: [{ n: "8" }] });
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Client;
  await assert.rejects(
    readSource(client),
    /zero rows despite non-zero inventory/,
  );
});
