import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { PostgresGovernanceStore } from "./store.ts";
const subject = "00000000-0000-4000-8000-000000000001";
function fixture(status: "member" | "not_member" | "unavailable" = "member") {
  const queries: { sql: string; values: unknown[] }[] = [];
  const providerCalls: string[] = [];
  let fail = false;
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (fail && sql.includes("cast_vote")) throw new Error("fixture failure");
      return { rows: [{ result: { receipt: subject, choice: values[1] } }] };
    },
    release: () => {
      queries.push({ sql: "release", values: [] });
    },
  };
  const service = {
    connect: async () => client,
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("due_proposals"))
        return {
          rows: [
            { result: [{ proposal_id: subject, keep_departed_votes: true }] },
          ],
        };
      if (sql.includes("governance_membership_accounts"))
        return { rows: [{ subject_id: subject, telegram_id: "101" }] };
      return { rows: [{ result: true }] };
    },
  } as unknown as pg.Pool;
  const auth = {
    query: async () => ({ rows: [{ subject_id: subject }] }),
  } as unknown as pg.Pool;
  const membership = {
    status: async (id: string) => {
      providerCalls.push(id);
      return status;
    },
  };
  return {
    store: new PostgresGovernanceStore(auth, service, membership, async () => ({
      resolveTelegramSubject: async () => subject,
      governanceMembershipSnapshot: async () => ({
        members: [subject],
        checkedAt: new Date().toISOString(),
      }),
    })),
    queries,
    providerCalls,
    service,
    membership,
    failVote: () => {
      fail = true;
    },
  };
}
test("eligibility is checked for every cast/change/withdraw before persistence", async () => {
  for (const status of ["not_member", "unavailable"] as const) {
    const { store, queries } = fixture(status);
    await assert.rejects(
      store.write("101", "vote", { proposal_id: subject, choice: "for" }),
    );
    assert.equal(queries.length, 0);
  }
  const { store, queries, providerCalls } = fixture();
  for (const choice of ["for", "against", null])
    await store.write("101", "vote", { proposal_id: subject, choice });
  assert.deepEqual(providerCalls, ["101", "101", "101"]);
  assert.equal(queries.filter((q) => q.sql.includes("cast_vote")).length, 3);
  assert.deepEqual(
    queries.filter((q) => q.sql.includes("set_config")).map((q) => q.values),
    [[subject], [subject], [subject]],
  );
});
test("subject transactions roll back and release on failure", async () => {
  const f = fixture();
  f.failVote();
  await assert.rejects(
    f.store.write("101", "vote", { proposal_id: subject, choice: "for" }),
  );
  assert.deepEqual(
    f.queries.slice(-2).map((q) => q.sql),
    ["ROLLBACK", "release"],
  );
});
test("default close needs no external membership checks", async () => {
  const f = fixture("unavailable");
  await f.store.closeDue();
  assert.deepEqual(f.providerCalls, []);
  assert.equal(f.queries[1]?.values[1], null);
});
