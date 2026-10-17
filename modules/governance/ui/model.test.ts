import { test } from "node:test";
import assert from "node:assert/strict";
import { canVote, inTab, status, type Proposal } from "./model.ts";
const p = {
  state: "opened",
  closes_at: new Date(Date.now() + 3600000).toISOString(),
  rules: { allow_vote_changes: true },
  decision: null,
} as Proposal;
await test("voting stops at the deadline and frozen changes rule includes withdrawals", () => {
  const mine = { proposal_id: "p", choice: null, receipt: "receipt" };
  assert.equal(canVote(p, true), true);
  assert.equal(canVote(p, false), false);
  assert.equal(canVote(p, true, mine), true);
  assert.ok(p.rules);
  assert.equal(
    canVote(
      { ...p, rules: { ...p.rules, allow_vote_changes: false } },
      true,
      mine,
    ),
    false,
  );
  assert.equal(
    canVote({ ...p, closes_at: new Date(0).toISOString() }, true),
    false,
  );
  assert.equal(status(p, Date.now()), "voting");
  assert.equal(status(p, Date.now() + 7200000), "tally");
});
await test("tabs distinguish closed tallies, overdue decisions and explicit outcomes", () => {
  assert.equal(inTab(p, "open"), true);
  const closed = {
    ...p,
    state: "closed",
    decision_status: "decision_pending",
  } as Proposal;
  assert.equal(inTab(closed, "closed"), true);
  assert.equal(status(closed), "decision_pending");
  const decided = {
    ...closed,
    decision: { outcome: "defer", reason: "More evidence needed" },
  } as Proposal;
  assert.equal(inTab(decided, "closed"), false);
  assert.equal(inTab(decided, "decided"), true);
  assert.equal(status(decided), "defer");
});
