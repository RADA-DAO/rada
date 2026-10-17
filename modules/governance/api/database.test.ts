import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

// Explicit opt-in only: migrations must already be applied to a disposable local DB.
// Ordinary unit runs never connect. Do not point this at a shared database.
const connectionString = process.env.GOVERNANCE_DISPOSABLE_TEST_DATABASE_URL;
test(
  "parallel database closers publish exactly one immutable tally",
  {
    skip: !connectionString,
  },
  async () => {
    const url = new URL(connectionString!);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/rada_governance_test");
    const pool = new pg.Pool({ connectionString, max: 4 });
    const p = randomUUID();
    const actor = randomUUID();
    const seed = await pool.connect();
    let released = false;
    try {
      await seed.query("BEGIN");
      await seed.query("SET LOCAL ROLE governance_owner");
      await seed.query(
        "INSERT INTO governance.proposals(proposal_id,author,title,body) VALUES($1,$2,'Parallel fixture','Synthetic')",
        [p, actor],
      );
      await seed.query(
        `INSERT INTO governance.openings
      SELECT $1,$2,clock_timestamp()-interval '3 days',clock_timestamp()-interval '1 day',
      version,'{}',clock_timestamp() FROM governance.settings ORDER BY version DESC LIMIT 1`,
        [p, actor],
      );
      await seed.query(
        `INSERT INTO governance.votes(proposal_id,subject_id,choice,membership_checked_at)
      VALUES($1,$2,'for',clock_timestamp())`,
        [p, actor],
      );
      await seed.query("COMMIT");
      seed.release();
      released = true;
      const close = async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE governance_service");
          const result = await client.query(
            "SELECT governance.close_proposal($1,'{}',clock_timestamp()) AS closed",
            [p],
          );
          await client.query("COMMIT");
          return result.rows[0].closed as boolean;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      };
      assert.deepEqual(
        (await Promise.all([close(), close(), close()])).sort(),
        [false, false, true],
      );
      const projection = await pool.query(
        "SELECT governance.read_proposal($1) AS p",
        [p],
      );
      assert.deepEqual(projection.rows[0].p.tally, {
        for: 1,
        against: 0,
        abstain: 0,
      });
      await assert.rejects(
        pool.query(
          "UPDATE governance.closures SET closed_at=now() WHERE proposal_id=$1",
          [p],
        ),
        { code: "23514" },
      );
    } finally {
      if (!released) {
        try {
          await seed.query("ROLLBACK");
        } finally {
          seed.release();
        }
      }
      // Dedicated disposable DB only; retain immutable fixtures for inspection.
      await pool.end();
    }
  },
);
