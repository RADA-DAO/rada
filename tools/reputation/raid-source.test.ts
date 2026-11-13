import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildRaidSource,
  compareRaidSource,
  type RaidSourceInput,
  type RaidServed,
} from "./raid-source.ts";
const rules = (points = ".1") =>
  JSON.stringify({
    activityAccounting: "observed-units-v1",
    participation: { distinctRaidPost: points },
  });
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
function fixture(): RaidSourceInput {
  const frozenRulesJson = rules();
  return {
    weekStart: "2026-11-08T22:00:00Z",
    cutoff: "2026-11-13T12:00:00.123456Z",
    frozenRulesJson,
    frozenRulesHash: sha(frozenRulesJson),
    roster: [1001, 1002, 1003],
    excludedActorIds: [1003],
    posts: [
      { url: "https://example.invalid/post/1", author: 1002, album: null },
      { url: "https://example.invalid/post/2", author: 1002, album: null },
    ],
    comments: [
      {
        id: "raw-1",
        authorId: 1001,
        eventAt: "2026-11-09T10:00:00.123456Z",
        url: "https://example.invalid/comment/1",
        postUrl: "https://example.invalid/post/1",
        text: "",
      },
    ],
    acceptedEventEntries: [],
    sourceDispositions: {
      "https://example.invalid/post/1": {
        status: "excluded",
        reason: "Publication-only judgment",
      },
    },
    excludedComments: ["https://example.invalid/comment/1"],
  };
}
function first<T>(values: readonly T[]): T {
  const value = values[0];
  assert.ok(value);
  return value;
}
function served(input: RaidSourceInput): RaidServed {
  const out = buildRaidSource(input);
  return {
    weekStart: input.weekStart,
    assessedThrough: input.cutoff,
    rulesHash: input.frozenRulesHash,
    members: out.roster.map((userId) => ({
      userId,
      items: out.facts
        .filter((f) => f.actorId === userId)
        .map((f) => ({
          key: f.key,
          category: "raid",
          points: f.points,
          evidence: f.evidence,
        })),
    })),
  };
}
await test("raw empty comments use the supplied exact rule; publication exclusions are audit-only", () => {
  const input = fixture();
  const out = buildRaidSource(input);
  const fact = first(out.facts);
  assert.equal(out.scope.complete, true);
  assert.deepEqual(out.roster, [1001, 1002]);
  assert.equal(fact.points, "0.1");
  assert.equal(fact.occurredAt, first(input.comments).eventAt);
  assert.equal(fact.rulesHash, input.frozenRulesHash);
  assert.equal(fact.category, "participation");
  assert.equal(fact.sourceCategory, "raid");
  assert.deepEqual(
    out.reviewedDispositions.sourceDispositions,
    input.sourceDispositions,
  );
  assert.deepEqual(
    out.reviewedDispositions.excludedComments,
    input.excludedComments,
  );
  assert.equal(compareRaidSource(out, served(input)).equal, true);
});
await test("bot/forward/delete/self/command/outside-roster/cutoff do not emit raid facts", () => {
  const input = fixture();
  const c = first(input.comments);
  input.comments = [
    { ...c, id: "self", authorId: 1002 },
    { ...c, id: "bot", url: c.url + "b", bot: true },
    { ...c, id: "forward", url: c.url + "f", forwarded: true },
    { ...c, id: "deleted", url: c.url + "d", deleted: true },
    { ...c, id: "command", url: c.url + "c", text: "/start@synthetic" },
    { ...c, id: "observer", url: c.url + "o", authorId: 1003 },
    {
      ...c,
      id: "future",
      url: c.url + "x",
      eventAt: "2026-11-13T12:00:00.123457Z",
    },
  ];
  const out = buildRaidSource(input);
  assert.equal(out.facts.length, 0);
  assert.equal(out.excluded.length, 7);
  assert.equal(out.blocked.length, 0);
});
await test("albums preserve all exact IDs, deduplicate leaves and anchor earliest actual event", () => {
  const input = fixture();
  input.posts = input.posts.map((p) => ({ ...p, album: "9007199254740993" }));
  const c = first(input.comments);
  input.comments = [
    c,
    {
      ...c,
      id: "second",
      postUrl: "https://example.invalid/post/2",
      url: c.url + "b",
      eventAt: "2026-11-09T09:00:00.654321Z",
    },
    c,
  ];
  const out = buildRaidSource(input);
  const fact = first(out.facts);
  assert.equal(out.facts.length, 1);
  assert.equal(fact.key, "raid:album:9007199254740993");
  assert.equal(fact.occurredAt, "2026-11-09T09:00:00.654321Z");
  assert.deepEqual(fact.evidence, [c.url, c.url + "b"]);
  assert.equal(fact.rawCommentCount, 2);
  input.posts = input.posts.map((p) => ({ ...p, album: 9007199254740992 }));
  assert.ok(
    buildRaidSource(input).blocked.every(
      (b) => b.reason === "unsafe_album_identity",
    ),
  );
});
await test("current mapped event entries and prior exact event keys suppress raids; pending is never an input source", () => {
  for (const scope of ["current", "prior"] as const) {
    const input = fixture();
    input.acceptedEventEntries = [
      {
        actorId: 1001,
        status: "accepted",
        scope,
        key: "event-entry:https://example.invalid/post/1",
        category: "events",
        evidence: [],
      },
    ];
    assert.equal(buildRaidSource(input).facts.length, 0);
  }
  const input = fixture();
  input.acceptedEventEntries = [
    {
      actorId: 1001,
      status: "accepted",
      scope: "current",
      key: "reviewed-event",
      category: "events",
      evidence: [first(input.comments).url],
    },
  ];
  assert.equal(buildRaidSource(input).facts.length, 0);
  (input.acceptedEventEntries[0] as unknown as { status: string }).status =
    "pending";
  assert.equal(
    first(buildRaidSource(input).blocked).reason,
    "invalid_accepted_event_context",
  );
});
await test("semantic identity survives policy changes but another Kyiv week is a new unit", () => {
  const a = fixture();
  const one = first(buildRaidSource(a).facts);
  const b = fixture();
  b.frozenRulesJson = rules("1/4");
  b.frozenRulesHash = sha(b.frozenRulesJson);
  const two = first(buildRaidSource(b).facts);
  assert.equal(one.semanticKey, two.semanticKey);
  assert.equal(two.points, "0.25");
  b.weekStart = "2026-11-15T22:00:00Z";
  b.cutoff = "2026-11-16T12:00:00Z";
  b.comments = b.comments.map((c) => ({ ...c, eventAt: b.cutoff }));
  assert.notEqual(first(buildRaidSource(b).facts).semanticKey, one.semanticKey);
});
await test("missing dates/ownership, conflicting identities, changed policy bytes fail closed", () => {
  const input = fixture();
  input.posts = input.posts.map((p) => ({ ...p, author: null }));
  assert.equal(
    first(buildRaidSource(input).blocked).reason,
    "missing_post_owner",
  );
  const dates = fixture();
  dates.comments = dates.comments.map((c) => ({
    ...c,
    eventAt: "2026-02-30T00:00:00Z",
  }));
  assert.equal(
    first(buildRaidSource(dates).blocked).reason,
    "invalid_event_time",
  );
  const conflicting = fixture();
  conflicting.comments = [
    ...conflicting.comments,
    { ...first(conflicting.comments), authorId: 1002 },
  ];
  assert.equal(
    first(buildRaidSource(conflicting).blocked).reason,
    "conflicting_comment_identity",
  );
  const policy = fixture();
  policy.frozenRulesJson += " ";
  assert.equal(
    first(buildRaidSource(policy).blocked).reason,
    "frozen_rules_hash_mismatch",
  );
  for (const value of ["1/3", "0", "-1", "NaN"]) {
    const bad = fixture();
    bad.frozenRulesJson = rules(value);
    bad.frozenRulesHash = sha(bad.frozenRulesJson);
    assert.equal(buildRaidSource(bad).facts.length, 0);
    assert.equal(buildRaidSource(bad).scope.complete, false);
  }
});
await test("proof cap is sorted unique first50; comparison catches evidence/category/zero-roster mismatch", () => {
  const input = fixture();
  const c = first(input.comments);
  input.comments = Array.from({ length: 60 }, (_, i) => ({
    ...c,
    id: String(i),
    url: c.url + String(i).padStart(2, "0"),
  }));
  const out = buildRaidSource(input);
  assert.equal(first(out.facts).evidence.length, 50);
  assert.equal(first(out.facts).rawCommentCount, 60);
  const expected = served(input);
  first(first(expected.members).items).evidence = [
    "https://example.invalid/changed",
  ];
  assert.equal(compareRaidSource(out, expected).equal, false);
  const missing = served(input);
  missing.members = missing.members.filter((m) => m.userId !== 1002);
  assert.ok(
    compareRaidSource(out, missing).problems.includes("served_roster_mismatch"),
  );
});
await test("submicrosecond event instants block instead of rounding across a Kyiv week", () => {
  const input = fixture();
  input.cutoff = "2026-11-15T21:59:59.999999999Z";
  input.comments = input.comments.map((c) => ({
    ...c,
    eventAt: "2026-11-15T21:59:59.9999999Z",
  }));
  const result = buildRaidSource(input);
  assert.equal(result.facts.length, 0);
  assert.equal(first(result.blocked).reason, "submicrosecond_event_time");
  input.comments = input.comments.map((c) => ({
    ...c,
    eventAt: "2026-11-15T21:59:59.999999000Z",
  }));
  assert.equal(buildRaidSource(input).facts.length, 1);
});
await test("Kyiv DST windows use calendar dates and inclusive actual source cutoff", () => {
  for (const [weekStart, cutoff] of [
    ["2026-03-22T22:00:00Z", "2026-03-29T20:59:59.999999Z"],
    ["2026-10-18T21:00:00Z", "2026-10-25T21:59:59.999999Z"],
  ]) {
    assert.ok(weekStart && cutoff);
    const input = fixture();
    input.weekStart = weekStart;
    input.cutoff = cutoff;
    input.comments = input.comments.map((c) => ({ ...c, eventAt: cutoff }));
    assert.equal(buildRaidSource(input).facts.length, 1);
  }
});
