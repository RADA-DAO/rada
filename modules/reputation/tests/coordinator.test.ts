import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ReputationCoordinator,
  runNext,
  runBoundedBatch,
  type CoordinatorOptions,
  type CoordinatorObservation,
} from "../worker/coordinator.ts";
import { BoundedEvaluator } from "../worker/evaluator.ts";
import type {
  ReputationJob,
  ReportClassification,
} from "../api/worker-store.ts";
import type { ReputationItem } from "../contract.ts";
const item: ReputationItem = {
  id: "item",
  title: "Synthetic work",
  category: "help",
  points: "1.2345",
  status: "accepted",
  reason: "frozen_rule_accepted",
  occurredAt: "2026-01-01T00:00:00Z",
  recordedAt: "2026-01-01T00:00:00Z",
  ruleHash: "frozen-v1",
  evidence: [],
  missionId: null,
};
function job(
  id = "item",
  lane: ReputationJob["lane"] = "interpretation",
): ReputationJob {
  return {
    itemId: id,
    subjectId: "subject-private",
    sourceId: id,
    missionId: lane === "external" ? "mission-uuid" : null,
    telegramUserId: lane === "external" ? "12345" : null,
    lane,
    leaseToken: `lease-${id}`,
    leaseUntil: new Date(Date.now() + 60000).toISOString(),
    attempt: 1,
    title: "Synthetic work",
    description: "Completed concrete work without an attachment",
    occurredAt: item.occurredAt,
    evidence: [],
  };
}
function fixture(jobs = [job()], overrides: Partial<CoordinatorOptions> = {}) {
  const commits: ReportClassification[] = [];
  const proposals: Record<string, unknown>[] = [];
  const retries: string[] = [];
  const external: unknown[] = [];
  const observations: CoordinatorObservation[] = [];
  let providers = 0;
  let factories = 0;
  let claims = 0;
  const options: CoordinatorOptions = {
    store: {
      claim: (lanes, seconds) => {
        claims++;
        assert.deepEqual(lanes, ["interpretation", "external"]);
        assert.equal(seconds, 60);
        return Promise.resolve(jobs.shift() ?? null);
      },
      rules: () =>
        Promise.resolve({
          hash: "frozen-v1",
          rules: [
            {
              key: "help",
              points: "1.2345",
              category: "help",
              cap: { unit: "kyiv_day", limit: 1 },
            },
          ],
        }),
      saveProposal: (_item, _lease, p) => {
        proposals.push(p);
        return Promise.resolve("proposal-id");
      },
      retry: (_item, _lease, _seconds, reason) => {
        retries.push(reason);
        return Promise.resolve({
          state: "ready",
          attempt: 1,
          retryAt: new Date().toISOString(),
          reason,
        });
      },
      commitReport: (_item, _lease, p) => {
        commits.push(p);
        return Promise.resolve({ state: "completed", item });
      },
      finalizeExternal: (_item, _lease, p) => {
        external.push(p);
        return Promise.resolve({ state: "completed", item });
      },
    },
    rulesHash: () => "frozen-v1",
    facts: (j) => ({
      occurrenceKey: `known-occurrence-${j.itemId}`,
      completedClaim: true,
      contradictions: [],
    }),
    evaluatorFactory: (rules) => {
      factories++;
      return new BoundedEvaluator(
        rules,
        {
          maxConcurrent: 1,
          maxTokensPerCall: 256,
          costUnitsPerCall: 1,
          totalCostUnits: 2,
          deadlineMs: 100,
        },
        (request) => {
          providers++;
          assert.deepEqual(Object.keys(request).sort(), [
            "content",
            "maxCostUnits",
            "maxTokens",
            "ruleKeys",
            "signal",
          ]);
          assert.ok(!JSON.stringify(request).includes("subject-private"));
          return Promise.resolve({
            classification: "concrete_completed",
            ruleKey: "help",
            reason: "Concrete completed work",
          });
        },
      );
    },
    externalVerifiers: new Map(),
    deadlineMs: 1000,
    observe: (event) => observations.push(event),
    ...overrides,
  };
  return {
    coordinator: new ReputationCoordinator(options),
    options,
    commits,
    proposals,
    retries,
    external,
    observations,
    counts: () => ({ providers, factories, claims }),
  };
}
void test("coordinator maps attributed report through cached frozen evaluator, commits no score fields", async () => {
  const f = fixture([job("one"), job("two")]);
  const outcomes = await runBoundedBatch(f.coordinator, {
    maxJobs: 3,
    maxDurationMs: 5000,
  });
  assert.deepEqual(
    outcomes.map((o) => o.state),
    ["completed", "completed", "idle"],
  );
  assert.equal(f.counts().factories, 1);
  assert.equal(f.counts().providers, 2);
  assert.equal(f.proposals.length, 2);
  assert.ok(f.proposals[0]);
  assert.ok(f.commits[0]);
  assert.equal(f.proposals[0].points, "1.2345");
  assert.deepEqual(Object.keys(f.commits[0]).sort(), [
    "ruleKey",
    "rulesHash",
    "semanticKey",
    "sourceId",
  ]);
  assert.equal(f.commits[0].sourceId, "one");
  assert.equal(
    f.commits[0].semanticKey,
    createHash("sha256")
      .update(
        JSON.stringify([
          "subject-private",
          "self_report",
          "known-occurrence-one",
        ]),
      )
      .digest("hex"),
  );
  assert.ok(!JSON.stringify(f.observations).includes("subject-private"));
});
void test("unclear work persists interpretation proposal and retries without community dispute", async () => {
  const f = fixture(undefined, {
    evaluatorFactory: () => ({
      evaluate: () =>
        Promise.resolve({
          state: "needs_interpretation",
          reason: "completion_unclear",
        }),
    }),
  });
  assert.equal((await runNext(f.coordinator)).state, "needs_interpretation");
  assert.equal(f.commits.length, 0);
  assert.deepEqual(f.proposals, [
    { state: "needs_interpretation", reason: "completion_unclear" },
  ]);
  assert.deepEqual(f.retries, ["interpretation_unclear"]);
});
void test("unconfigured policy and exhausted provider budget never grant", async () => {
  const empty = fixture(undefined, { rulesHash: () => null });
  assert.equal((await empty.coordinator.runNext()).state, "retry");
  assert.equal(empty.counts().providers, 0);
  assert.equal(empty.commits.length, 0);
  const budget = fixture([job("one"), job("two"), job("three")]);
  await budget.coordinator.runBoundedBatch({ maxJobs: 3, maxDurationMs: 5000 });
  assert.equal(budget.commits.length, 2);
  assert.equal(budget.counts().factories, 1);
  assert.equal(budget.counts().providers, 2);
  assert.equal(budget.retries.length, 1);
});
void test("bounded non-evicting cache cannot reset budgets through arbitrary rule hashes", async () => {
  const f = fixture([job("one"), job("two")], {
    maxCachedEvaluators: 1,
    rulesHash: (j) => (j.itemId === "one" ? "frozen-v1" : "frozen-v2"),
  });
  f.options.store.rules = (_item, _lease, hash) =>
    Promise.resolve({
      hash,
      rules: [
        {
          key: "help",
          points: "1.2345",
          category: "help",
          cap: { unit: "occurrence", limit: 1 },
        },
      ],
    });
  await f.coordinator.runBoundedBatch({ maxJobs: 2, maxDurationMs: 5000 });
  assert.equal(f.commits.length, 1);
  assert.equal(f.counts().factories, 1);
  assert.deepEqual(f.retries, ["policy_capacity"]);
});
void test("external membership finalizes only matching verified subject and configured mission", async () => {
  const valid = {
    state: "verified" as const,
    subjectId: "subject-private",
    missionId: "mission-uuid",
    channelId: "-100123",
    proofUrl: "https://t.me/synthetic",
    semanticKey: createHash("sha256")
      .update(
        JSON.stringify([
          "subject-private",
          "telegram_membership",
          "mission-uuid",
        ]),
      )
      .digest("hex"),
  };
  const f = fixture([job("one", "external")], {
    externalVerifiers: new Map([
      [
        "mission-uuid",
        (input) => {
          assert.equal(input.telegramUserId, "12345");
          return Promise.resolve(valid);
        },
      ],
    ]),
  });
  assert.equal((await f.coordinator.runNext()).state, "completed");
  assert.equal(f.counts().providers, 0);
  assert.equal(f.external.length, 1);
  const bad = fixture([job("two", "external")], {
    externalVerifiers: new Map([
      [
        "mission-uuid",
        () => Promise.resolve({ ...valid, subjectId: "other-subject" }),
      ],
    ]),
  });
  assert.equal((await bad.coordinator.runNext()).state, "retry");
  assert.equal(bad.external.length, 0);
  assert.deepEqual(bad.retries, ["external_attribution_mismatch"]);
});
void test("deadline and caller abort settle retries while late provider output cannot commit", async () => {
  let settle!: (value: unknown) => void;
  const f = fixture(undefined, {
    deadlineMs: 10,
    evaluatorFactory: (rules) =>
      new BoundedEvaluator(
        rules,
        {
          maxConcurrent: 1,
          maxTokensPerCall: 1,
          costUnitsPerCall: 1,
          totalCostUnits: 1,
          deadlineMs: 1000,
        },
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      ),
  });
  const outcome = await f.coordinator.runNext();
  assert.equal(outcome.state, "retry");
  assert.deepEqual(f.retries, ["deadline"]);
  settle({
    classification: "concrete_completed",
    ruleKey: "help",
    reason: "Late answer",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.commits.length, 0);
  const aborted = fixture();
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await aborted.coordinator.runNext(controller.signal)).state,
    "retry",
  );
  assert.equal(aborted.counts().claims, 0);
});
void test("provider exceptions are sanitized and bounded batch stops at queue empty", async () => {
  const secret = "private-provider-token";
  const f = fixture(undefined, {
    evaluatorFactory: () => ({
      evaluate: () => Promise.reject(new Error(secret)),
    }),
  });
  const outcomes = await f.coordinator.runBoundedBatch({
    maxJobs: 2,
    maxDurationMs: 1000,
  });
  assert.deepEqual(
    outcomes.map((o) => o.state),
    ["retry", "idle"],
  );
  assert.ok(!JSON.stringify(f.observations).includes(secret));
  assert.deepEqual(f.retries, ["technical_failure"]);
  await assert.rejects(
    f.coordinator.runBoundedBatch({ maxJobs: 101, maxDurationMs: 1 }),
    /invalid_batch_limits/,
  );
});
void test("non-cooperative external calls retain their bounded slot after timeout", async () => {
  let calls = 0;
  const f = fixture(
    [job("one", "external"), job("two", "external"), job("three", "external")],
    {
      deadlineMs: 10,
      maxConcurrent: 1,
      externalVerifiers: new Map([
        [
          "mission-uuid",
          () => {
            calls++;
            return new Promise(() => {});
          },
        ],
      ]),
    },
  );
  const outcomes = await f.coordinator.runBoundedBatch({
    maxJobs: 3,
    maxDurationMs: 1000,
  });
  assert.deepEqual(
    outcomes.map((o) => o.state),
    ["retry", "retry", "retry"],
  );
  assert.equal(calls, 1);
  assert.equal(f.external.length, 0);
  assert.deepEqual(f.retries, [
    "deadline",
    "external_capacity",
    "external_capacity",
  ]);
});

void test("unexpected source facts cannot reach any semantic evaluator", async () => {
  const f = fixture([job("source", "source_fact")]);
  const result = await f.coordinator.runNext();
  assert.equal(result.state, "retry");
  assert.deepEqual(f.retries, ["deterministic_handler_required"]);
  assert.equal(f.counts().providers, 0);
  assert.equal(f.counts().factories, 0);
  assert.equal(f.commits.length, 0);
});
