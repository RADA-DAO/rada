import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareShadow,
  type ShadowSnapshot,
} from "../../../tools/reputation-shadow.ts";
function fixture(): ShadowSnapshot {
  return {
    version: 1,
    provenance: "synthetic",
    subjectAlias: "synthetic-a",
    cutoff: "2026-10-25T02:30:00Z",
    rulesHash: "fixture-rules-v1",
    complete: true,
    summary: {
      period: "all",
      start: null,
      end: "2026-10-25T02:30:00Z",
      totalPoints: "0",
      lifetimePoints: "0",
      pendingCount: 0,
      categories: ["work", "content", "help", "participation"].map(
        (category) => ({
          category: category as "work" | "content" | "help" | "participation",
          points: "0",
        }),
      ),
    },
    rows: [
      {
        key: "excluded-a",
        points: "0",
        status: "excluded",
        occurredAt: "2026-10-25T01:30:00Z",
        ruleHash: null,
        exclusionReason: "outside fixture rules",
      },
    ],
  };
}
void test("shadow parity requires identical cutoff/rules and includes explicit zero categories and exclusions", () => {
  const left = fixture();
  const right = fixture();
  right.summary.categories.reverse();
  assert.deepEqual(compareShadow(left, right), {
    equal: true,
    differences: [],
  });
  right.rows = [];
  assert.deepEqual(compareShadow(left, right), {
    equal: false,
    differences: ["rows"],
  });
  right.cutoff = "2026-10-25T03:30:00Z";
  assert.throws(() => compareShadow(left, right), /incomparable cutoff/);
  right.cutoff = left.cutoff;
  right.rulesHash = "another-formula";
  assert.throws(() => compareShadow(left, right), /incomparable rulesHash/);
});
void test("partial, zero-omitting and silently excluded snapshots are rejected", () => {
  const full = fixture();
  const bad = fixture();
  bad.summary.categories.pop();
  assert.throws(() => compareShadow(full, bad), /explicit zeros/);
  const excluded = fixture();
  const excludedRow = excluded.rows[0];
  assert.ok(excludedRow);
  excludedRow.exclusionReason = null;
  assert.throws(
    () => compareShadow(full, excluded),
    /exclusions must be explicit/,
  );
  const rounded = fixture();
  rounded.summary.totalPoints = "0.00001";
  assert.throws(() => compareShadow(full, rounded), /canonical exact decimals/);
});
