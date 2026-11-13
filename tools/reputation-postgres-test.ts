import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ReputationItem } from "../modules/reputation/contract.ts";
import { reputationContractTests } from "../modules/reputation/tests/store-contract.ts";
import { reputationCalendarTests } from "../modules/reputation/tests/calendar-contract.ts";
import { createPostgresFixtureRuntime } from "../modules/reputation/tests/postgres-fixture.ts";
assert.ok(process.env.PG_TEST_URL, "PG_TEST_URL is required");
const runtime = await createPostgresFixtureRuntime(process.env.PG_TEST_URL);
after(runtime.close);
const {
  admin,
  auth,
  service,
  operator,
  ingress,
  store,
  fixture,
  subject,
  ownerQuery,
} = runtime;
reputationContractTests(fixture);
reputationCalendarTests(fixture);

const denied = async (pool: pg.Pool, sql: string) => {
  await assert.rejects(
    pool.query(sql),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "42501",
  );
};
void test("actual login roles cannot write tables or invoke another authority's functions", async () => {
  const identity = await service.query<{
    current_user: string;
    rolsuper: boolean;
  }>("SELECT current_user,rolsuper FROM pg_roles WHERE rolname=current_user");
  assert.equal(identity.rows[0]?.rolsuper, false);
  for (const table of [
    "items",
    "missions",
    "commands",
    "decisions",
    "appeals",
    "changes",
    "subjects",
  ]) {
    await denied(service, `SELECT * FROM reputation.${table}`);
    await denied(service, `DELETE FROM reputation.${table}`);
  }
  await denied(
    service,
    "SELECT reputation.configure_mission(gen_random_uuid(),1,'x','x','help','1','rule','acknowledgement',NULL,true)",
  );
  await denied(
    service,
    "SELECT reputation.finalize_external(gen_random_uuid(),'x','x','https://example.test')",
  );
  await denied(
    service,
    "SELECT reputation.correct(gen_random_uuid(),'x','1','accepted','x')",
  );
  await denied(
    ingress,
    "SELECT reputation.correct(gen_random_uuid(),'x','1','accepted','x')",
  );
  await denied(
    operator,
    "SELECT reputation.finalize_external(gen_random_uuid(),'x','x','https://example.test')",
  );
  await denied(auth, "SELECT reputation.summary('all')");
});
void test("holding one subject's transaction open does not block a different actor", async () => {
  const f = await fixture();
  const client = await admin.connect();
  try {
    const id = await subject(f.actor);
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE reputation_owner");
    await client.query("SELECT reputation.lock_subject($1::uuid)", [id]);
    const receipt = await store.report(f.otherActor, {
      requestId: randomUUID(),
      title: "Independent result",
      description: "Distinct actor can progress during held transaction",
      occurredAt: new Date().toISOString(),
    });
    assert.equal(receipt.state, "checking");
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await f.close();
  }
});
void test("exact-point configuration rejects more than four decimal places", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.seedMission({ points: "0.00001", verifier: "acknowledgement" }),
    );
  } finally {
    await f.close();
  }
});
async function finalize(
  item: string,
  sourceId: string,
  url = "https://example.test/synthetic-evidence",
): Promise<ReputationItem> {
  const result = await ingress.query<{ item: ReputationItem }>(
    "SELECT reputation.finalize_external($1::uuid,'synthetic-adapter',$2,$3) AS item",
    [item, sourceId, url],
  );
  const row = result.rows[0];
  assert.ok(row);
  return row.item;
}
async function correct(
  item: string,
  sourceId: string,
  points: string,
  status = "accepted",
  reason = "Synthetic authorized correction",
): Promise<ReputationItem> {
  const result = await operator.query<{ item: ReputationItem }>(
    "SELECT reputation.correct($1::uuid,$2,$3,$4,$5) AS item",
    [item, sourceId, points, status, reason],
  );
  const row = result.rows[0];
  assert.ok(row);
  return row.item;
}
void test("trusted source reuse across actors awards once and rejected writes leave no partial state", async () => {
  const f = await fixture();
  const mission = await f.seedMission({
    points: "4.0001",
    verifier: "external",
  });
  const left = await store.verify(f.actor, mission.id, {
    requestId: randomUUID(),
    missionVersion: 1,
  });
  const right = await store.verify(f.otherActor, mission.id, {
    requestId: randomUUID(),
    missionVersion: 1,
  });
  const sourceId = randomUUID();
  const attempts = await Promise.allSettled([
    finalize(left.item.id, sourceId),
    finalize(right.item.id, sourceId),
  ]);
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    attempts.filter((result) => result.status === "rejected").length,
    1,
  );
  const items = await Promise.all([
    store.item(f.actor, left.item.id),
    store.item(f.otherActor, right.item.id),
  ]);
  assert.equal(items.filter((item) => item?.status === "accepted").length, 1);
  assert.equal(items.filter((item) => item?.status === "pending").length, 1);
  const summaries = await Promise.all([
    store.summary(f.actor, "all"),
    store.summary(f.otherActor, "all"),
  ]);
  assert.deepEqual(summaries.map((summary) => summary.totalPoints).sort(), [
    "0",
    "4.0001",
  ]);
  assert.deepEqual(summaries.map((summary) => summary.revision).sort(), [
    "1",
    "2",
  ]);
  const decisions = await ownerQuery<{ count: string }>(
    "SELECT count(*)::text AS count FROM reputation.decisions WHERE source='external:synthetic-adapter' AND source_id=$1",
    [sourceId],
  );
  assert.equal(decisions.rows[0]?.count, "1");
});
void test("trusted retries preserve corrections and invalid verification never erases accepted points", async () => {
  const f = await fixture();
  const mission = await f.seedMission({
    points: "3.125",
    verifier: "external",
  });
  const pending = await store.verify(f.actor, mission.id, {
    requestId: randomUUID(),
    missionVersion: 1,
  });
  const sourceId = randomUUID();
  const accepted = await finalize(pending.item.id, sourceId);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.points, "3.125");
  const before = await store.summary(f.actor, "all");
  assert.deepEqual(await finalize(pending.item.id, sourceId), accepted);
  await assert.rejects(
    finalize(pending.item.id, sourceId, "https://example.test/changed"),
  );
  await assert.rejects(finalize(pending.item.id, randomUUID()));
  await assert.rejects(
    store.verify(f.actor, mission.id, {
      requestId: randomUUID(),
      missionVersion: 999,
    }),
  );
  assert.equal((await store.summary(f.actor, "all")).revision, before.revision);
  assert.equal((await store.summary(f.actor, "all")).totalPoints, "3.125");
  const corrected = await correct(
    pending.item.id,
    randomUUID(),
    "0",
    "excluded",
    "Synthetic exclusion",
  );
  assert.equal(corrected.status, "excluded");
  const correctedRevision = (await store.summary(f.actor, "all")).revision;
  // Re-delivery of evidence is harmless after an explicit later decision.
  assert.equal((await finalize(pending.item.id, sourceId)).status, "excluded");
  assert.equal(
    (await store.summary(f.actor, "all")).revision,
    correctedRevision,
  );
  assert.equal((await store.summary(f.actor, "all")).totalPoints, "0");
});
void test("authorized correction, exact totals, decision and durable change commit or roll back together", async () => {
  const f = await fixture();
  const mission = await f.seedMission({
    points: "5",
    verifier: "acknowledgement",
  });
  const award = await store.verify(f.actor, mission.id, {
    requestId: randomUUID(),
    missionVersion: 1,
  });
  const before = await store.summary(f.actor, "all");
  const sourceId = randomUUID();
  const client = await operator.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT reputation.correct($1::uuid,$2,'1.0001','accepted','Synthetic atomic correction')",
      [award.item.id, sourceId],
    );
    // A different session must see the entire old state until commit.
    assert.equal((await store.summary(f.actor, "all")).totalPoints, "5");
    assert.deepEqual(
      (await store.changes(f.actor, before.revision)).changes,
      [],
    );
    await client.query("ROLLBACK");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  assert.equal((await store.item(f.actor, award.item.id))?.points, "5");
  assert.equal((await store.summary(f.actor, "all")).revision, before.revision);
  const absent = await ownerQuery<{ count: string }>(
    "SELECT count(*)::text AS count FROM reputation.decisions WHERE source='correction' AND source_id=$1",
    [sourceId],
  );
  assert.equal(absent.rows[0]?.count, "0");
  await correct(
    award.item.id,
    sourceId,
    "1.0001",
    "accepted",
    "Synthetic atomic correction",
  );
  const committed = await store.summary(f.actor, "all");
  assert.equal(committed.totalPoints, "1.0001");
  assert.equal(committed.lifetimePoints, "1.0001");
  assert.equal(BigInt(committed.revision), BigInt(before.revision) + 1n);
  const changes = await store.changes(f.actor, before.revision);
  assert.equal(changes.changes.length, 1);
  assert.equal(changes.changes[0]?.itemId, award.item.id);
  await correct(
    award.item.id,
    sourceId,
    "1.0001",
    "accepted",
    "Synthetic atomic correction",
  );
  await assert.rejects(
    correct(
      award.item.id,
      sourceId,
      "2",
      "accepted",
      "Synthetic atomic correction",
    ),
  );
  const other = await store.verify(f.otherActor, mission.id, {
    requestId: randomUUID(),
    missionVersion: 1,
  });
  await assert.rejects(
    correct(
      other.item.id,
      sourceId,
      "1.0001",
      "accepted",
      "Synthetic atomic correction",
    ),
  );
  assert.equal(
    (await store.summary(f.actor, "all")).revision,
    committed.revision,
  );
  assert.equal((await store.summary(f.otherActor, "all")).totalPoints, "5");
});
void test("future accepted and pending events are consistently excluded from present summaries and pages", async () => {
  const f = await fixture();
  const now = Date.now();
  const currentFuture = await f.seedAccepted(
    f.actor,
    new Date(now + 120000).toISOString(),
    "7",
  );
  const tomorrow = await f.seedAccepted(
    f.actor,
    new Date(now + 86400000).toISOString(),
    "11",
  );
  const pending = await store.report(f.actor, {
    requestId: randomUUID(),
    title: "Scheduled synthetic work",
    description: "Future-dated synthetic result",
    occurredAt: new Date(now + 120000).toISOString(),
  });
  assert.equal(pending.summary.pendingCount, 0);
  for (const period of ["all", "today", "week", "previous_week"] as const) {
    const summary = await store.summary(f.actor, period);
    assert.equal(summary.totalPoints, "0");
    assert.equal(summary.lifetimePoints, "0");
    assert.equal(summary.pendingCount, 0);
    const ids = (await store.items(f.actor, period, null)).items.map(
      (item) => item.id,
    );
    assert.ok(
      !ids.includes(currentFuture) &&
        !ids.includes(tomorrow) &&
        !ids.includes(pending.item.id),
    );
  }
  const requestId = randomUUID();
  const before = (await store.summary(f.actor, "all")).revision;
  await assert.rejects(
    store.report(f.actor, {
      requestId,
      title: "Too far ahead",
      description: "Invalid synthetic timestamp",
      occurredAt: new Date(now + 600000).toISOString(),
    }),
  );
  assert.equal(await store.command(f.actor, requestId), null);
  assert.equal((await store.summary(f.actor, "all")).revision, before);
});
