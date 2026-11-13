import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareShadow,
  compareShadowRoster,
  type RosterShadow,
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
        category: "work",
        evidenceKeys: ["synthetic-source:1"],
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

void test("full roster parity refuses a missing zero member and detects category/evidence changes", () => {
  const a = fixture(),
    zero = fixture();
  zero.subjectAlias = "synthetic-zero";
  zero.rows = [];
  const roster = [a.subjectAlias, zero.subjectAlias];
  const left: RosterShadow = {
    version: 1,
    cutoff: a.cutoff,
    rulesHash: a.rulesHash,
    roster,
    members: [a, zero],
  };
  const right = structuredClone(left);
  assert.equal(compareShadowRoster(roster, left, right).equal, true);
  right.members.pop();
  assert.throws(
    () => compareShadowRoster(roster, left, right),
    /missing or duplicated participant/,
  );
  right.members.push(zero);
  const changed = right.members[0]?.rows[0];
  assert.ok(changed);
  changed.evidenceKeys = ["synthetic-source:2"];
  assert.equal(compareShadowRoster(roster, left, right).equal, false);
  const invalid = fixture();
  invalid.summary.totalPoints = "0.1";
  assert.throws(() => compareShadow(a, invalid), /category totals/);
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
