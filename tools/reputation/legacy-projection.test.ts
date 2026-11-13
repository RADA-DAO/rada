import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { compareShadowRoster } from "../reputation-shadow.ts";
import {
  compareLegacyWeek,
  exactPoints,
  legacyProjectionToShadow,
  type LegacyInput,
  type StrictInput,
} from "./legacy-projection.ts";
import { inspectLegacyWeekConfig } from "./legacy-week-cli.ts";
const at = "2026-11-13T12:00:00.123456Z";
const earlier = "2026-11-12T12:00:00Z";
const rules =
  '{"participation": {"synthetic": "1/8"}, "version": "synthetic-v1"}';
const rulesHash = createHash("sha256").update(rules).digest("hex");
const url = (id: number) =>
  `https://example.invalid/private-source-${String(id)}`;
function present<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
const actor = (value: LegacyInput) => present(value.projection.members[0]);
const award = (value: LegacyInput) => present(actor(value).items[0]);
function fixture(): LegacyInput {
  return {
    projection: {
      schemaVersion: 1,
      status: "preliminary",
      weekStart: "2026-11-08T22:00:00Z",
      assessedThrough: at,
      ruleVersion: "synthetic-v1",
      rulesHash,
      assessmentHash: "a".repeat(64),
      fullReviewHash: "b".repeat(64),
      fullReviewThrough: earlier,
      sourceDispositions: {
        [url(3)]: {
          status: "excluded",
          reason: "private-exclusion-reason",
          reviewedAt: earlier,
        },
      },
      members: [
        {
          userId: 1001,
          label: "private-member-label",
          points: "1/8",
          items: [
            {
              key: "private-item-key",
              title: "private-result-title",
              category: "voting",
              points: "1/8",
              evidence: [url(1)],
            },
          ],
          pending: [{ title: "private-pending-title", evidence: [url(2)] }],
        },
        {
          userId: 1002,
          label: "private-zero-label",
          points: "0",
          items: [],
          pending: [],
        },
      ],
    },
    roster: [1001, 1002],
    cutoff: at,
    frozenRulesJson: rules,
    frozenRulesHash: rulesHash,
    categoryMap: {
      voting: "participation",
      help: "help",
      content: "content",
      work: "work",
    },
    opaque: (scope, value) =>
      createHmac("sha256", Buffer.alloc(32, 7))
        .update(JSON.stringify([scope, value]))
        .digest("hex"),
  };
}
function strict(): StrictInput {
  return {
    ...fixture(),
    resolveRow: (context) => ({
      identityKey: context.sourceKey,
      sourceCategory: context.sourceCategory ?? "help",
      occurredAt: earlier,
    }),
    dispositionOwners: () => [1001],
    lifetimePoints: (id) => (id === 1001 ? "5/4" : "0"),
  };
}
await test("Fraction conversion is exact, canonical and rejects unrepresentable scale", () => {
  for (const [input, expected] of [
    ["1/8", "0.125"],
    ["2/20000", "0.0001"],
    ["12.5000", "12.5"],
    ["0/7", "0"],
  ])
    assert.equal(exactPoints(present(input)).decimal, expected);
  for (const invalid of ["1/3", "1/20000", "0/0", "1e3", "-1", "NaN"])
    assert.throws(() => exactPoints(invalid));
});
await test("week parity computes every leaf/category and preserves roster zeros without history claims", () => {
  const result = compareLegacyWeek(fixture());
  assert.ok(result.ok);
  assert.equal(result.scope, "week_projection_only");
  assert.equal(result.origin.independentCandidate, false);
  assert.equal(result.origin.independentScoring, false);
  assert.equal(result.members.length, 2);
  assert.equal(present(result.members[0]).totalPoints, "0.125");
  assert.equal(present(result.members[1]).totalPoints, "0");
  assert.deepEqual(
    present(result.members[0]).categories.map((row) => row.points),
    ["0", "0", "0.125", "0"],
  );
  assert.equal(present(present(result.members[0]).rows[1]).status, "pending");
  assert.equal(present(present(result.members[0]).rows[1]).points, "0");
  assert.equal(result.sourceManifest.length, 1);
  const encoded = JSON.stringify(result);
  for (const secret of [
    "private-member",
    "private-result",
    "private-item",
    "private-source",
    "private-exclusion",
    "private-pending",
    "userId",
  ])
    assert.equal(encoded.includes(secret), false);
});
await test("missing/duplicated people, omitted leaf totals, duplicate keys and evidence are rejected", () => {
  const cases = [
    (v: LegacyInput) => {
      v.projection.members.pop();
    },
    (v: LegacyInput) => {
      v.projection.members.push(actor(v));
    },
    (v: LegacyInput) => {
      actor(v).items = [];
    },
    (v: LegacyInput) => {
      const m = actor(v);
      m.items.push(present(m.items[0]));
    },
    (v: LegacyInput) => {
      award(v).evidence.push(url(1));
    },
    (v: LegacyInput) => {
      v.roster = [1001, 1001];
    },
    (v: LegacyInput) => {
      actor(v).pending.push(present(actor(v).pending[0]));
    },
  ];
  for (const mutate of cases) {
    const value = fixture();
    mutate(value);
    assert.equal(compareLegacyWeek(value).ok, false);
  }
});
await test("frozen hashes, version, exact cutoff and explicit category mapping are mandatory", () => {
  const cases = [
    (v: LegacyInput) => {
      v.frozenRulesJson += " ";
    },
    (v: LegacyInput) => {
      v.projection.rulesHash = "c".repeat(64);
    },
    (v: LegacyInput) => {
      v.projection.ruleVersion = "other";
    },
    (v: LegacyInput) => {
      v.cutoff = "2026-11-13T12:00:00.123457Z";
    },
    (v: LegacyInput) => {
      v.categoryMap = {};
    },
    (v: LegacyInput) => {
      v.expectedAssessmentHash = "c".repeat(64);
    },
    (v: LegacyInput) => {
      v.expectedFullReviewHash = "c".repeat(64);
    },
  ];
  for (const mutate of cases) {
    const value = fixture();
    mutate(value);
    assert.equal(compareLegacyWeek(value).ok, false);
  }
});
await test("raw category identity survives explicit category aggregation and opaque collisions fail", () => {
  const left = fixture();
  const right = fixture();
  right.categoryMap = { ...right.categoryMap, raid: "participation" };
  award(right).category = "raid";
  const a = compareLegacyWeek(left);
  const b = compareLegacyWeek(right);
  assert.ok(a.ok && b.ok);
  assert.equal(
    present(a.members[0]).totalPoints,
    present(b.members[0]).totalPoints,
  );
  assert.notEqual(
    present(present(a.members[0]).rows[0]).key,
    present(present(b.members[0]).rows[0]).key,
  );
  left.opaque = () => "f".repeat(64);
  assert.equal(compareLegacyWeek(left).ok, false);
});
await test("strict adapter blocks unknown event time, lifetime and global disposition ownership", () => {
  const input = strict();
  input.resolveRow = () => null;
  input.lifetimePoints = () => null;
  input.dispositionOwners = () => null;
  const result = legacyProjectionToShadow(input);
  assert.equal(result.ok, false);
  assert.ok("blockers" in result);
  assert.ok(result.blockers.includes("unresolved_row_metadata"));
  assert.ok(result.blockers.includes("missing_lifetime_points"));
  assert.ok(result.blockers.includes("unresolved_disposition_ownership"));
  assert.equal("shadow" in result, false);
  assert.ok("sourceManifest" in result && result.sourceManifest.length === 1);
});
await test("strict source-resolved snapshot retains accepted, pending, exclusions and exact zero members", () => {
  const result = legacyProjectionToShadow(strict());
  assert.ok(result.ok);
  assert.equal(result.origin.independentCandidate, false);
  assert.equal(present(result.shadow.members[0]).rows.length, 3);
  assert.equal(present(result.shadow.members[1]).rows.length, 0);
  assert.deepEqual(
    present(result.shadow.members[0]).rows.map((row) => row.status),
    ["accepted", "pending", "excluded"],
  );
  assert.equal(
    present(result.shadow.members[0]).summary.lifetimePoints,
    "1.25",
  );
  assert.deepEqual(
    compareShadowRoster(result.shadow.roster, result.shadow, result.shadow),
    { equal: true, differences: [] },
  );
});
await test("strict adapter rejects dates beyond nanosecond cutoff, wrong actor ownership and unknown row category", () => {
  for (const mutate of [
    (v: StrictInput) => {
      v.resolveRow = (row) => ({
        identityKey: row.sourceKey,
        sourceCategory: row.sourceCategory ?? "help",
        occurredAt: "2026-11-13T12:00:00.123456001Z",
      });
    },
    (v: StrictInput) => {
      v.dispositionOwners = () => [9999];
    },
    (v: StrictInput) => {
      v.resolveRow = (row) => ({
        identityKey: row.sourceKey,
        sourceCategory: "unknown",
        occurredAt: earlier,
      });
    },
  ]) {
    const value = strict();
    mutate(value);
    assert.equal(legacyProjectionToShadow(value).ok, false);
  }
});
await test("CLI exposes only sanitized week counts/hashes and honest strict migration blockers", async () => {
  const input = fixture();
  const result = await inspectLegacyWeekConfig({
    projection: input.projection,
    roster: input.roster,
    rulesCanonical: input.frozenRulesJson,
    categoryMap: input.categoryMap,
    aliasSalt: Buffer.alloc(32, 7).toString("hex"),
  });
  assert.ok(result.ok);
  assert.equal(result.independentCandidate, false);
  assert.equal(result.checks.members, 2);
  assert.equal(result.checks.zeroMembers, 1);
  assert.equal(result.checks.acceptedRows, 1);
  assert.equal(result.migrationReadiness.completeHistory, false);
  const output = JSON.stringify(result);
  assert.equal(output.includes("private-"), false);
  assert.equal(output.includes("aliasSalt"), false);
  assert.equal(output.includes("totalPoints"), false);
  const invalid = await inspectLegacyWeekConfig({
    projection: "/private-sensitive-unreadable-name",
    roster: [],
    rulesCanonical: rules,
    categoryMap: {},
    aliasSalt: Buffer.alloc(32, 7).toString("hex"),
  });
  assert.equal(invalid.ok, false);
  assert.equal(JSON.stringify(invalid).includes("private-sensitive"), false);
});

await test("evidence HMAC collisions across separate leaves and source-only exclusions fail closed", () => {
  const input = fixture();
  const original = input.opaque.bind(input);
  input.opaque = (scope, value) =>
    scope === "evidence" ? "e".repeat(64) : original(scope, value);
  const result = compareLegacyWeek(input);
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, ["evidence_identity_collision"]);
});
await test("complete-history readiness rejects coverage warnings even when explicit metadata is supplied", () => {
  const input = strict();
  input.projection.coverageWarnings = ["private-source-warning"];
  const result = legacyProjectionToShadow(input);
  assert.equal(result.ok, false);
  assert.ok(
    "blockers" in result &&
      result.blockers.includes("source_coverage_warnings"),
  );
  assert.equal(
    JSON.stringify(result).includes("private-source-warning"),
    false,
  );
});
