import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ReportClassification } from "../../modules/reputation/index.ts";
import { workerHelpers, type WorkerRuntime } from "./worker-fixture.ts";
export function registerWorkerClaimTests(runtime: WorkerRuntime) {
  const h = workerHelpers(runtime);
  const scenario = (name: string, run: () => Promise<void>) =>
    test(name, { concurrency: false }, async () => {
      await h.isolate();
      await run();
    });
  void scenario(
    "parallel physical clients claim distinct jobs and SKIP LOCKED leaves held job available",
    async () => {
      const f = await runtime.fixture();
      const ids: string[] = [];
      for (let index = 0; index < 9; index++)
        ids.push((await h.report(f.actor)).id);
      const first = ids[0];
      assert.ok(first);
      const held = await runtime.admin.connect();
      try {
        await held.query("BEGIN");
        await held.query(
          "SELECT item_id FROM reputation.jobs WHERE item_id=$1::uuid FOR UPDATE",
          [first],
        );
        const claims = await Promise.all(
          Array.from({ length: 8 }, () =>
            h.workerStore.claim(["interpretation"], 60),
          ),
        );
        assert.ok(claims.every((job) => job !== null));
        assert.equal(new Set(claims.map((job) => job.itemId)).size, 8);
        assert.equal(new Set(claims.map((job) => job.leaseToken)).size, 8);
        assert.ok(
          claims.every(
            (job) =>
              ids.includes(job.itemId) &&
              job.itemId !== first &&
              job.attempt === 1,
          ),
        );
      } finally {
        await held.query("ROLLBACK");
        held.release();
      }
      const last = await h.claim(first);
      assert.equal(last.attempt, 1);
    },
  );
  void scenario(
    "real worker login cannot read tables, configure policy, correct scores or impersonate auth",
    async () => {
      const identity = await h.worker.query<{ rolsuper: boolean }>(
        "SELECT rolsuper FROM pg_roles WHERE rolname=current_user",
      );
      assert.equal(identity.rows[0]?.rolsuper, false);
      for (const table of [
        "items",
        "jobs",
        "job_receipts",
        "job_proposals",
        "rules",
        "report_awards",
        "decisions",
      ]) {
        await h.denied(h.worker, `SELECT * FROM reputation.${table}`);
        await h.denied(h.worker, `DELETE FROM reputation.${table}`);
      }
      await h.denied(h.worker, "SELECT reputation.configure_rule('{}'::jsonb)");
      await h.denied(
        h.worker,
        "SELECT reputation.finalize_external(gen_random_uuid(),'x','x','https://example.test')",
      );
      await h.denied(
        h.worker,
        "SELECT reputation.correct(gen_random_uuid(),'x','999','accepted','Unauthorized')",
      );
      await h.denied(h.worker, "SELECT identity.resolve_telegram(101)");
      await h.denied(
        h.worker,
        "SELECT identity.reputation_telegram_user(gen_random_uuid())",
      );
      await h.denied(
        runtime.service,
        "SELECT reputation.claim_job(ARRAY['interpretation'],60)",
      );
      await h.denied(
        runtime.ingress,
        "SELECT reputation.claim_job(ARRAY['external'],60)",
      );
    },
  );
  void scenario(
    "expired lease is reclaimed and stale completion cannot award or save proposals",
    async () => {
      const f = await runtime.fixture();
      const config = await h.rule();
      const item = await h.report(f.actor);
      const old = await h.claim(item.id);
      await runtime.ownerQuery(
        "UPDATE reputation.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE item_id=$1::uuid",
        [item.id],
      );
      const fresh = await h.claim(item.id);
      assert.notEqual(fresh.leaseToken, old.leaseToken);
      assert.equal(fresh.attempt, 2);
      await assert.rejects(
        h.workerStore.commitReport(
          item.id,
          old.leaseToken,
          h.classification(old, config),
        ),
      );
      await assert.rejects(
        h.workerStore.rules(item.id, old.leaseToken, config.rulesHash),
      );
      await assert.rejects(
        h.workerStore.saveProposal(item.id, old.leaseToken, {
          classification: "concrete_completed",
        }),
      );
      assert.equal((await h.store.summary(f.actor, "all")).totalPoints, "0");
      assert.deepEqual(await h.counts(item.id), {
        decisions: "0",
        awards: "0",
        receipts: "0",
      });
      assert.equal(
        (
          await h.workerStore.commitReport(
            item.id,
            fresh.leaseToken,
            h.classification(fresh, config),
          )
        ).state,
        "completed",
      );
      assert.equal(
        (await h.store.summary(f.actor, "all")).totalPoints,
        "0.3125",
      );
    },
  );
  void scenario(
    "Trust report without attachment gets only frozen database points and category",
    async () => {
      const f = await runtime.fixture();
      const config = await h.rule();
      const item = await h.report(f.actor);
      const job = await h.claim(item.id);
      assert.equal(job.sourceId, item.id);
      assert.equal(job.subjectId, await runtime.subject(f.actor));
      assert.deepEqual(job.evidence, []);
      assert.equal(Object.hasOwn(job, "telegramUserId"), false);
      const snapshot = await h.workerStore.rules(
        job.itemId,
        job.leaseToken,
        config.rulesHash,
      );
      assert.deepEqual(snapshot, {
        hash: config.rulesHash,
        rules: [
          {
            key: config.key,
            points: "0.3125",
            category: "help",
            cap: { unit: "occurrence", limit: 1 },
          },
        ],
      });
      const result = await h.workerStore.commitReport(
        job.itemId,
        job.leaseToken,
        {
          ...h.classification(job, config),
          points: "999999",
          category: "work",
        } as ReportClassification,
      );
      assert.equal(result.state, "completed");
      assert.equal(result.item.points, "0.3125");
      assert.equal(result.item.category, "help");
      assert.deepEqual(result.item.evidence, []);
      const summary = await h.store.summary(f.actor, "all");
      assert.equal(summary.totalPoints, "0.3125");
      assert.equal(summary.pendingCount, 0);
      assert.equal(summary.revision, "2");
    },
  );
  void scenario(
    "external worker gets only claimed verified identity and cannot bypass worker permissions",
    async () => {
      const f = await runtime.fixture();
      const mission = await f.seedMission({
        points: "2.25",
        verifier: "external",
      });
      const pending = await h.store.verify(f.actor, mission.id, {
        requestId: randomUUID(),
        missionVersion: 1,
      });
      const job = await h.claim(pending.item.id, "external");
      assert.equal(job.telegramUserId, f.actor);
      assert.equal(job.subjectId, await runtime.subject(f.actor));
      assert.equal(job.missionId, mission.id);
      assert.equal(job.sourceId, pending.item.id);
      const input = {
        source: "synthetic-membership",
        sourceId: randomUUID(),
        evidenceUrl: "https://example.test/synthetic-proof",
      };
      await h.denied(
        runtime.service,
        "SELECT reputation.complete_external($1::uuid,$2::uuid,$3,$4,$5)",
        [
          job.itemId,
          job.leaseToken,
          input.source,
          input.sourceId,
          input.evidenceUrl,
        ],
      );
      const result = await h.workerStore.finalizeExternal(
        job.itemId,
        job.leaseToken,
        input,
      );
      assert.equal(result.state, "completed");
      assert.equal((await h.store.summary(f.actor, "all")).totalPoints, "2.25");
      assert.deepEqual(
        await h.workerStore.finalizeExternal(job.itemId, job.leaseToken, input),
        result,
      );
      await assert.rejects(
        h.workerStore.finalizeExternal(job.itemId, job.leaseToken, {
          ...input,
          evidenceUrl: "https://example.test/changed",
        }),
      );
    },
  );
}
