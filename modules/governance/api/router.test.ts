// deno-lint-ignore-file require-await
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { registerGovernanceRoutes } from "./router.ts";
import { parseInput, validRules } from "./validation.ts";
import type { GovernanceStore } from "./store.ts";
const p = "00000000-0000-4000-8000-000000000001";
const rules = {
  who_opens: "steward-opens",
  duration_hours: 48,
  decision_days: 7,
  allow_vote_changes: true,
  require_membership_at_open: false,
  keep_departed_votes: true,
  allow_majority_override: true,
};
function fixture(signed = true) {
  const calls: unknown[] = [];
  const store: GovernanceStore = {
    list: async () => [
      { proposal_id: p, tally: { for: 1, against: 0, abstain: 0 } },
    ],
    read: async () => ({
      proposal_id: p,
      decision: null,
      execution_status: "no_evidence",
    }),
    votes: async () => [{ receipt: p, voter: null, choice: "for" }],
    mine: async (actor) => {
      calls.push(actor);
      return [];
    },
    settings: async () => ({ version: 1, rules }),
    history: async () => [],
    write: async (...args) => {
      calls.push(args);
      return null;
    },
    closeDue: async () => {},
  };
  const app = new Hono();
  registerGovernanceRoutes(app, store, async () => (signed ? "101" : null));
  const post = (path: string, body: unknown) =>
    app.request(`/v1/governance${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, store, calls, post };
}
test("strict validated text, settings and mandatory public reasons", () => {
  assert.ok(validRules(rules));
  for (const r of [
    { ...rules, duration_hours: 0 },
    { ...rules, decision_days: null },
    { ...rules, extra: true },
  ])
    assert.equal(validRules(r), false);
  assert.equal(parseInput("decide", { outcome: "accept", reason: "  " }), null);
  assert.equal(parseInput("settings", { rules, reason: "" }), null);
  assert.equal(
    parseInput("create", { title: "a", body: "b", subject_id: p }),
    null,
  );
  assert.equal(parseInput("create", { title: "a\u0000", body: "b" }), null);
  assert.deepEqual(parseInput("create", { title: " a ", body: "a\nb" }), {
    title: "a",
    body: "a b",
  });
  assert.equal(
    parseInput("evidence", { body: "proof", link: "javascript:alert(1)" }),
    null,
  );
  assert.equal(parseInput("evidence", { body: "proof", tx_hash: "no" }), null);
  for (const choice of ["for", "against", "abstain", null])
    assert.ok(parseInput("vote", { choice }));
  assert.equal(parseInput("vote", {}), null);
});
test("public API shapes and anonymous voter with receipt", async () => {
  const { app } = fixture(false);
  const list = await (await app.request("/v1/governance/proposals")).json();
  assert.equal(list.proposals[0].tally.for, 1);
  const read = await (
    await app.request(`/v1/governance/proposals/${p}`)
  ).json();
  assert.equal(read.proposal.decision, null);
  const votes = await (
    await app.request(`/v1/governance/proposals/${p}/votes`)
  ).json();
  assert.deepEqual(votes, {
    votes: [{ receipt: p, voter: null, choice: "for" }],
  });
  assert.equal(JSON.stringify(votes).includes("telegram"), false);
  assert.equal((await app.request("/v1/governance/votes/mine")).status, 401);
});
test("write authentication, strict schemas and verified caller only", async () => {
  assert.equal(
    (await fixture(false).post("/proposals", { title: "t", body: "b" })).status,
    401,
  );
  const { post, calls } = fixture();
  assert.equal(
    (await post(`/proposals/${p}/vote`, { choice: "for", actor: "102" }))
      .status,
    400,
  );
  assert.equal(calls.length, 0);
  assert.equal(
    (await post(`/proposals/${p}/vote`, { choice: null })).status,
    200,
  );
  assert.deepEqual(calls[0], ["101", "vote", { proposal_id: p, choice: null }]);
  assert.equal(
    (await post(`/proposals/${p}/decide`, { outcome: "reject", reason: "" }))
      .status,
    400,
  );
});
test("SQL authorization and state errors are sanitized", async () => {
  const { store, post } = fixture();
  for (const [code, status] of [
    ["42501", 403],
    ["23514", 409],
    ["23505", 409],
    ["membership_unavailable", 503],
  ] as const) {
    store.write = async () => {
      throw Object.assign(new Error("private data"), { code });
    };
    const response = await post("/settings", {
      rules,
      reason: "Public rationale",
    });
    assert.equal(response.status, status);
    assert.equal((await response.text()).includes("private data"), false);
  }
});
