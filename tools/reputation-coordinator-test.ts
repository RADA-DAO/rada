import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  BoundedEvaluator,
  ReputationCoordinator,
  membershipVerifier,
  type ClassificationProvider,
} from "../modules/reputation/index.ts";
import { createPostgresFixtureRuntime } from "./reputation/postgres-fixture.ts";
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
function coordinator(
  hash: string,
  provider: ClassificationProvider,
  occurrence = randomUUID(),
) {
  return new ReputationCoordinator({
    store: h.workerStore,
    rulesHash: () => hash,
    facts: () => ({
      occurrenceKey: occurrence,
      completedClaim: true,
      contradictions: [],
    }),
    evaluatorFactory: (rules) =>
      new BoundedEvaluator(
        rules,
        {
          maxConcurrent: 2,
          maxTokensPerCall: 256,
          costUnitsPerCall: 1,
          totalCostUnits: 10,
          deadlineMs: 1000,
        },
        provider,
      ),
    externalVerifiers: new Map(),
    deadlineMs: 2000,
    retrySeconds: 60,
  });
}

void scenario(
  "coordinator accepts an attachment-free Trust report and deduplicates a second report through actual SQL",
  async () => {
    const f = await runtime.fixture();
    const rule = await h.rule();
    const first = await h.report(f.actor);
    const second = await h.report(f.actor);
    let calls = 0;
    const runner = coordinator(rule.rulesHash, (request) => {
      calls++;
      assert.deepEqual(request.ruleKeys, [rule.key]);
      assert.ok(!JSON.stringify(request).includes(f.actor));
      return Promise.resolve({
        classification: "concrete_completed",
        ruleKey: rule.key,
        reason: "Synthetic completed result",
      });
    });
    const results = await runner.runBoundedBatch({
      maxJobs: 3,
      maxDurationMs: 5000,
    });
    assert.deepEqual(
      results.map((result) => result.state),
      ["completed", "completed", "idle"],
    );
    assert.equal(calls, 2);
    const accepted = await h.store.item(f.actor, first.id);
    const excluded = await h.store.item(f.actor, second.id);
    assert.equal(accepted?.status, "accepted");
    assert.equal(accepted.points, "0.3125");
    assert.equal(accepted.category, "help");
    assert.deepEqual(accepted.evidence, []);
    assert.equal(excluded?.reason, "duplicate_occurrence");
    const summary = await h.store.summary(f.actor, "all");
    assert.equal(summary.totalPoints, "0.3125");
    assert.equal(summary.pendingCount, 0);
    assert.deepEqual(await h.counts(first.id), {
      decisions: "1",
      awards: "1",
      receipts: "1",
    });
  },
);

void scenario(
  "unknown provider classification preserves accepted work and stores a pending proposal without inventing a dispute",
  async () => {
    const f = await runtime.fixture();
    const rule = await h.rule();
    const accepted = await h.report(f.actor);
    const runner = coordinator(rule.rulesHash, () =>
      Promise.resolve({
        classification: "concrete_completed",
        ruleKey: rule.key,
        reason: "Synthetic completed result",
      }),
    );
    assert.equal((await runner.runNext()).state, "completed");
    const pending = await h.report(f.actor);
    const ambiguous = coordinator(rule.rulesHash, () =>
      Promise.resolve({
        classification: "concrete_completed",
        ruleKey: "unadopted.rule",
        reason: "Synthetic unknown rule",
      }),
    );
    assert.equal((await ambiguous.runNext()).state, "needs_interpretation");
    assert.equal(
      (await h.store.item(f.actor, accepted.id))?.status,
      "accepted",
    );
    assert.equal((await h.store.item(f.actor, pending.id))?.status, "pending");
    const summary = await h.store.summary(f.actor, "all");
    assert.equal(summary.totalPoints, "0.3125");
    assert.equal(summary.pendingCount, 1);
    assert.deepEqual(await h.counts(pending.id), {
      decisions: "0",
      awards: "0",
      receipts: "0",
    });
    const proposal = await runtime.ownerQuery<{ count: string }>(
      "SELECT count(*)::text AS count FROM reputation.job_proposals WHERE item_id=$1::uuid",
      [pending.id],
    );
    assert.equal(proposal.rows[0]?.count, "1");
  },
);

void scenario(
  "coordinator cannot commit a late non-cooperative model result after its deadline",
  async () => {
    const f = await runtime.fixture();
    const rule = await h.rule();
    const item = await h.report(f.actor);
    let release: (value: unknown) => void = () => {};
    const pending = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const runner = new ReputationCoordinator({
      store: h.workerStore,
      rulesHash: () => rule.rulesHash,
      facts: (job) => ({
        occurrenceKey: job.itemId,
        completedClaim: true,
        contradictions: [],
      }),
      evaluatorFactory: (rules) =>
        new BoundedEvaluator(
          rules,
          {
            maxConcurrent: 1,
            maxTokensPerCall: 256,
            costUnitsPerCall: 1,
            totalCostUnits: 1,
            deadlineMs: 100,
          },
          () => pending,
        ),
      externalVerifiers: new Map(),
      deadlineMs: 30,
    });
    const result = await runner.runNext();
    assert.equal(result.state, "retry");
    release({
      classification: "concrete_completed",
      ruleKey: rule.key,
      reason: "Late synthetic output",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await h.store.item(f.actor, item.id))?.status, "pending");
    assert.equal((await h.store.summary(f.actor, "all")).totalPoints, "0");
    assert.deepEqual(await h.counts(item.id), {
      decisions: "0",
      awards: "0",
      receipts: "0",
    });
  },
);

void scenario(
  "membership coordinator uses persisted identity and trusted adapter, with no model or live Telegram call",
  async () => {
    const f = await runtime.fixture();
    const mission = await f.seedMission({
      points: "0.25",
      verifier: "external",
    });
    const receipt = await h.store.verify(f.actor, mission.id, {
      requestId: randomUUID(),
      missionVersion: mission.version,
    });
    const channel = "-1001234567890";
    const observed: (string | number | undefined)[] = [];
    const verifier = membershipVerifier(
      {
        missionId: mission.id,
        channelId: channel,
        proofUrl: "https://t.me/synthetic_fixture",
      },
      (method, parameters) => {
        observed.push(parameters.user_id);
        if (method === "getMe")
          return Promise.resolve({ id: 123, is_bot: true });
        if (method === "getChat")
          return Promise.resolve({ id: Number(channel), type: "channel" });
        assert.equal(parameters.chat_id, channel);
        const userId = parameters.user_id;
        return Promise.resolve({
          user: { id: userId },
          status: userId === 123 ? "administrator" : "member",
        });
      },
    );
    const runner = new ReputationCoordinator({
      store: h.workerStore,
      rulesHash: () => {
        throw new Error("Membership must not interpret");
      },
      facts: () => {
        throw new Error("Membership must use claimed attribution");
      },
      evaluatorFactory: () => {
        throw new Error("Membership must not call a model");
      },
      externalVerifiers: new Map([[mission.id, verifier]]),
      deadlineMs: 2000,
    });
    assert.equal((await runner.runNext()).state, "completed");
    assert.equal(observed.at(-1), Number(f.actor));
    const item = await h.store.item(f.actor, receipt.item.id);
    assert.equal(item?.status, "accepted");
    assert.equal(item.points, "0.25");
    assert.equal(item.evidence[0]?.url, "https://t.me/synthetic_fixture");
    assert.equal((await h.store.summary(f.actor, "all")).totalPoints, "0.25");
    assert.equal((await runner.runNext()).state, "idle");
  },
);
