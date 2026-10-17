import test from "node:test";
import assert from "node:assert/strict";
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
