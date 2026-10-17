import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { PostgresClaimDb } from "./claims.ts";

function store() {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = {
    query: (sql: string, values?: unknown[]) => {
      calls.push({ sql, ...(values ? { values } : {}) });
      const rows = sql.includes("lock_claim")
        ? [
            {
              submission_id: "frog",
              winner_subject_id: "winner",
              burn_after: new Date(0),
              intent_id: "signed",
              payment_status: "unknown",
            },
          ]
        : sql.includes("burn_claim")
          ? [{ burned: true }]
          : [];
      return Promise.resolve({ rows });
    },
    release: () => calls.push({ sql: "release" }),
  };
  const pool = {
    connect: () => Promise.resolve(client),
    query: () => {
      throw new Error("settlement must use the locked connection");
    },
  };
  return {
    db: new PostgresClaimDb({} as pg.Pool, pool as unknown as pg.Pool),
    calls,
  };
}

test("settlement refreshes attempts and burns on the same locked transaction", async () => {
  const { db, calls } = store();
  const result = await db.withLockedClaim("frog", async (locked, rows) => {
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.intentId, "signed");
    assert.deepEqual(
      calls.map(({ sql }) => sql),
      ["BEGIN", "SELECT * FROM splash.lock_claim($1::uuid)"],
    );
    assert.equal(await locked.claimPayment("frog"), null);
    return await locked.burn("frog", ["signed"]);
  });
  assert.equal(result, true);
  assert.deepEqual(calls.at(-3), {
    sql: "SELECT splash.burn_claim($1::uuid, $2::uuid[]) AS burned",
    values: ["frog", ["signed"]],
  });
  assert.deepEqual(
    calls.slice(-2).map(({ sql }) => sql),
    ["COMMIT", "release"],
  );
});

test("an incomplete worker failure rolls back and releases the frog lock", async () => {
  const { db, calls } = store();
  await assert.rejects(
    db.withLockedClaim("frog", () => Promise.reject(new Error("offline"))),
    /offline/,
  );
  assert.deepEqual(
    calls.slice(-2).map(({ sql }) => sql),
    ["ROLLBACK", "release"],
  );
  assert.ok(!calls.some(({ sql }) => sql.includes("burn_claim")));
});

test("manual review is recorded on the locked transaction", async () => {
  const { db, calls } = store();
  await db.withLockedClaim("frog", async (locked) => {
    await locked.review("frog");
  });
  assert.deepEqual(calls.at(-3), {
    sql: "SELECT splash.review_claim($1::uuid)",
    values: ["frog"],
  });
  assert.equal(calls.at(-2)?.sql, "COMMIT");
});
