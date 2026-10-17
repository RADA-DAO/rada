import { test } from "node:test";
import assert from "node:assert/strict";
import { retention, parseReceipt, archiveDate } from "./backup-policy.mjs";

await test("retention keeps newest daily and weekly representatives across ISO years", () => {
  const names = Array.from({ length: 100 }, (_, i) => {
    const day = new Date(Date.UTC(2027, 0, 20 - i)).toISOString().slice(0, 10);
    return `${day}T033000Z.tar.age`;
  });
  const newest = names[0] ?? "";
  const oldest = names[99] ?? "";
  const removed = retention([...names].reverse());
  assert.equal(removed.length, 81); // 14 days + five older weekly representatives.
  for (const name of names.slice(0, 14)) assert.ok(!removed.includes(name));
  assert.ok(!removed.includes("2027-01-03T033000Z.tar.age"));
  assert.ok(removed.includes(oldest));
  assert.deepEqual(retention([]), []);
  assert.deepEqual(retention([newest]), []);
  assert.ok(
    retention([newest, newest.replace("033000", "023000")]).includes(
      newest.replace("033000", "023000"),
    ),
  );
});

await test("invalid archive namespace blocks retention before deletion", () => {
  for (const name of [
    "../oops.tar.age",
    "2026-02-30T033000Z.tar.age",
    "2026-01-01T250000Z.tar.age",
  ])
    assert.throws(() => retention([name]));
  assert.equal(archiveDate("2024-02-29T000000Z.tar.age").getUTCDate(), 29);
});

await test("receipt parser accepts only the non-secret success contract", () => {
  const value = {
    version: 1,
    status: "verified",
    archive: "2026-10-17T033000Z.tar.age",
    sha256: "a".repeat(64),
  };
  assert.deepEqual(parseReceipt(JSON.stringify(value)), value);
  for (const invalid of [
    "",
    "{}",
    JSON.stringify({ ...value, password: "forbidden" }),
    JSON.stringify({ ...value, status: "failed" }),
    JSON.stringify({ ...value, sha256: "bad" }),
  ])
    assert.throws(() => parseReceipt(invalid));
});
