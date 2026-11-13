import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresFixtureRuntime } from "./reputation/postgres-fixture.ts";
import { registerWorkerClaimTests } from "./reputation/worker-claims.ts";
import { workerHelpers } from "./reputation/worker-fixture.ts";
assert.ok(process.env.PG_TEST_URL, "PG_TEST_URL is required");
const runtime = await createPostgresFixtureRuntime(
  process.env.PG_TEST_URL,
  12,
  true,
);
after(runtime.close);
const h = workerHelpers(runtime);
const scenario = (name: string, run: () => Promise<void>) =>
  test(name, { concurrency: false }, async () => {
    await h.isolate();
    await run();
  });
registerWorkerClaimTests(runtime);
void scenario(
  "parallel same semantic occurrence on two items gives exactly one award",
  async () => {
    const f = await runtime.fixture();
    const config = await h.rule();
    const left = await h.report(f.actor);
    const right = await h.report(f.actor);
    const first = await h.claim(left.id);
    const second = await h.claim(right.id);
    const semantic = randomUUID();
    const results = await Promise.all([
      h.workerStore.commitReport(
        left.id,
        first.leaseToken,
        h.classification(first, config, semantic),
      ),
      h.workerStore.commitReport(
        right.id,
        second.leaseToken,
        h.classification(second, config, semantic),
      ),
    ]);
    assert.equal(
      results.filter(
        (result) =>
          result.state === "completed" && result.item.status === "accepted",
      ).length,
      1,
    );
    assert.equal(
      results.filter(
        (result) =>
          result.state === "completed" &&
          result.item.status === "excluded" &&
          result.item.reason === "duplicate_occurrence",
      ).length,
      1,
    );
    const summary = await h.store.summary(f.actor, "all");
    assert.equal(summary.totalPoints, "0.3125");
    assert.equal(summary.pendingCount, 0);
    assert.equal(summary.revision, "4");
    assert.equal((await h.store.changes(f.actor, "0")).changes.length, 4);
  },
);
void scenario(
  "Kyiv day cap spans DST and rule hash changes cannot bypass an existing rule cap",
  async () => {
    const f = await runtime.fixture();
    const key = `synthetic.${randomUUID()}`;
    const original = await h.rule({ key, points: "0.5", capUnit: "kyiv_day" });
    const next = await h.rule({ key, points: "7", capUnit: "kyiv_day" });
    const at = [
      "2026-10-24T21:30:00Z",
      "2026-10-25T21:30:00Z",
      "2026-10-25T22:00:00Z",
    ];
    const results = [];
    for (const [index, instant] of at.entries()) {
      const item = await h.report(f.actor, instant);
      const job = await h.claim(item.id);
      results.push(
        await h.workerStore.commitReport(
          item.id,
          job.leaseToken,
          h.classification(job, index === 0 ? original : next),
        ),
      );
    }
    assert.equal(results[0]?.state, "completed");
    assert.equal(results[1]?.state, "completed");
    assert.equal(results[2]?.state, "completed");
    assert.ok(
      results[1].item.status === "excluded" &&
        results[1].item.reason === "configured_cap_reached",
    );
    assert.equal((await h.store.summary(f.actor, "all")).totalPoints, "7.5");
  },
);
void scenario(
  "unknown rule stays pending with retry and no partial award or receipt",
  async () => {
    const f = await runtime.fixture();
    const item = await h.report(f.actor);
    const job = await h.claim(item.id);
    const missing = { rulesHash: randomUUID(), key: "not-configured" };
    assert.equal(
      await h.workerStore.rules(job.itemId, job.leaseToken, missing.rulesHash),
      null,
    );
    const proposal = await h.workerStore.saveProposal(
      job.itemId,
      job.leaseToken,
      {
        classification: "needs_interpretation",
        ruleKey: null,
        reason: "Unknown configured rule",
      },
    );
    assert.match(proposal, /^[0-9a-f-]{36}$/);
    const result = await h.workerStore.commitReport(
      job.itemId,
      job.leaseToken,
      h.classification(job, missing),
    );
    assert.equal(result.state, "ready");
    assert.equal((await h.store.item(f.actor, item.id))?.status, "pending");
    assert.equal((await h.store.summary(f.actor, "all")).totalPoints, "0");
    assert.equal((await h.store.summary(f.actor, "all")).revision, "1");
    assert.deepEqual(await h.counts(item.id), {
      decisions: "0",
      awards: "0",
      receipts: "0",
    });
  },
);
void scenario(
  "wrong durable source fails atomically and leaves the valid lease usable",
  async () => {
    const f = await runtime.fixture();
    const config = await h.rule();
    const item = await h.report(f.actor);
    const job = await h.claim(item.id);
    await assert.rejects(
      h.workerStore.commitReport(job.itemId, job.leaseToken, {
        ...h.classification(job, config),
        sourceId: randomUUID(),
      }),
    );
    assert.deepEqual(await h.counts(item.id), {
      decisions: "0",
      awards: "0",
      receipts: "0",
    });
    assert.equal((await h.store.item(f.actor, item.id))?.status, "pending");
    assert.equal((await h.store.summary(f.actor, "all")).revision, "1");
    assert.equal(
      (
        await h.workerStore.commitReport(
          job.itemId,
          job.leaseToken,
          h.classification(job, config),
        )
      ).state,
      "completed",
    );
  },
);
void scenario(
  "lost worker acknowledgement replays immutable receipt and never overwrites later correction",
  async () => {
    const f = await runtime.fixture();
    const config = await h.rule();
    const item = await h.report(f.actor);
    const job = await h.claim(item.id);
    const proposal = h.classification(job, config);
    const first = await h.workerStore.commitReport(
      job.itemId,
      job.leaseToken,
      proposal,
    );
    const before = await h.store.summary(f.actor, "all");
    assert.deepEqual(
      await h.workerStore.commitReport(job.itemId, job.leaseToken, proposal),
      first,
    );
    await assert.rejects(
      h.workerStore.commitReport(job.itemId, job.leaseToken, {
        ...proposal,
        semanticKey: randomUUID(),
      }),
    );
    assert.equal(
      (await h.store.summary(f.actor, "all")).revision,
      before.revision,
    );
    await runtime.operator.query(
      "SELECT reputation.correct($1::uuid,$2,'0','excluded','Synthetic explicit correction')",
      [item.id, randomUUID()],
    );
    await assert.rejects(
      runtime.ownerQuery(
        "UPDATE reputation.job_receipts SET receipt='{}'::jsonb WHERE item_id=$1::uuid",
        [item.id],
      ),
    );
    const corrected = await h.store.summary(f.actor, "all");
    assert.equal(corrected.totalPoints, "0");
    assert.deepEqual(
      await h.workerStore.commitReport(job.itemId, job.leaseToken, proposal),
      first,
    );
    await assert.rejects(
      h.workerStore.retry(job.itemId, job.leaseToken, 1, "Stale retry"),
    );
    assert.equal((await h.store.item(f.actor, item.id))?.status, "excluded");
    assert.equal(
      (await h.store.summary(f.actor, "all")).revision,
      corrected.revision,
    );
  },
);
void scenario(
  "exhausted job requires audited operator requeue and accepted item cannot be reopened",
  async () => {
    const f = await runtime.fixture();
    const config = await h.rule();
    const item = await h.report(f.actor);
    await runtime.ownerQuery(
      "UPDATE reputation.jobs SET max_attempts=1 WHERE item_id=$1::uuid",
      [item.id],
    );
    const job = await h.claim(item.id);
    assert.equal(
      (
        await h.workerStore.retry(
          item.id,
          job.leaseToken,
          1,
          "Synthetic provider limit",
        )
      ).state,
      "blocked",
    );
    await h.denied(
      h.worker,
      "SELECT reputation.requeue_job($1::uuid,2,'Unauthorized')",
      [item.id],
    );
    await assert.rejects(
      runtime.operator.query("SELECT reputation.requeue_job($1::uuid,2,'')", [
        item.id,
      ]),
    );
    await runtime.operator.query(
      "SELECT reputation.requeue_job($1::uuid,2,'Synthetic explicit operational retry')",
      [item.id],
    );
    const audit = await runtime.ownerQuery<{ count: string }>(
      "SELECT count(*)::text AS count FROM reputation.job_proposals WHERE item_id=$1::uuid AND proposal->>'state'='operator_requeue'",
      [item.id],
    );
    assert.equal(audit.rows[0]?.count, "1");
    const reopened = await h.claim(item.id);
    assert.equal(reopened.attempt, 1);
    await h.workerStore.commitReport(
      item.id,
      reopened.leaseToken,
      h.classification(reopened, config),
    );
    await assert.rejects(
      runtime.operator.query(
        "SELECT reputation.requeue_job($1::uuid,2,'Cannot reset accepted')",
        [item.id],
      ),
    );
    assert.equal((await h.store.summary(f.actor, "all")).totalPoints, "0.3125");
  },
);
void scenario(
  "operator exclusion frees active day cap but never clears semantic deduplication",
  async () => {
    const f = await runtime.fixture();
    const config = await h.rule({ points: "1", capUnit: "kyiv_day" });
    const semantic = randomUUID();
    const original = await h.report(f.actor);
    const firstJob = await h.claim(original.id);
    await h.workerStore.commitReport(
      original.id,
      firstJob.leaseToken,
      h.classification(firstJob, config, semantic),
    );
    assert.equal((await h.store.summary(f.actor, "all")).totalPoints, "1");
    await runtime.operator.query(
      "SELECT reputation.correct($1::uuid,$2,'0','excluded','Synthetic canceled award')",
      [original.id, randomUUID()],
    );
    assert.equal((await h.store.summary(f.actor, "all")).totalPoints, "0");
    const replacement = await h.report(f.actor);
    const replacementJob = await h.claim(replacement.id);
    const result = await h.workerStore.commitReport(
      replacement.id,
      replacementJob.leaseToken,
      h.classification(replacementJob, config),
    );
    assert.equal(result.state, "completed");
    assert.equal(result.item.status, "accepted");
    assert.equal(result.item.points, "1");
    const duplicate = await h.report(f.actor);
    const duplicateJob = await h.claim(duplicate.id);
    const replayedOccurrence = await h.workerStore.commitReport(
      duplicate.id,
      duplicateJob.leaseToken,
      h.classification(duplicateJob, config, semantic),
    );
    assert.equal(replayedOccurrence.state, "completed");
    assert.equal(replayedOccurrence.item.status, "excluded");
    assert.equal(replayedOccurrence.item.reason, "duplicate_occurrence");
    assert.equal((await h.store.summary(f.actor, "all")).totalPoints, "1");
  },
);

void scenario(
  "interpretation lease cannot finalize as external and rejected lane writes leave no partial state",
  async () => {
    const f = await runtime.fixture();
    const item = await h.report(f.actor);
    const job = await h.claim(item.id);
    await assert.rejects(
      h.workerStore.finalizeExternal(job.itemId, job.leaseToken, {
        source: "synthetic-wrong-lane",
        sourceId: randomUUID(),
        evidenceUrl: "https://example.test/synthetic-proof",
      }),
    );
    assert.deepEqual(await h.counts(item.id), {
      decisions: "0",
      awards: "0",
      receipts: "0",
    });
    assert.equal((await h.store.item(f.actor, item.id))?.status, "pending");
    assert.equal((await h.store.summary(f.actor, "all")).revision, "1");
  },
);
