import assert from "node:assert/strict";
import {
  PostgresReputationSourceStore,
  type ReputationItem,
  type JobCommit,
} from "../modules/reputation/index.ts";
import {
  buildRaidSource,
  compareRaidSource,
  type RaidFact,
} from "./reputation/raid-source.ts";
import { instant, rule } from "./reputation/raid-source-model.ts";
import { exactPoints } from "./reputation/legacy-projection.ts";
import {
  loadRaidCapture,
  allowKnownRaidSubset,
  privateAliases,
} from "./reputation/raid-shadow-input.ts";
import { createPostgresFixtureRuntime } from "./reputation/postgres-fixture.ts";

/** Actual dated facts -> restricted ingress -> leased SQL policy -> actual reads. No network/provider. */
const captureDirectory = process.argv[2];
assert.ok(
  captureDirectory && process.env.PG_TEST_URL,
  "CAPTURE_DIR and disposable PG_TEST_URL required",
);
const deadline = AbortSignal.timeout(120000);
let runtime:
  Awaited<ReturnType<typeof createPostgresFixtureRuntime>> | undefined;
const metrics = {
  actors: 0,
  zeroActors: 0,
  candidateUnits: 0,
  expectedUnits: 0,
  ingested: 0,
  committed: 0,
  replayChecks: 0,
  privacyChecks: 0,
  summaryMismatches: 0,
  itemMismatches: 0,
  evidenceMismatches: 0,
  semanticMismatches: 0,
  unsupportedOtherLaneRows: 0,
  rawSourceBlocked: 0,
};
let failure: string | null = null;
let failureLocation: string | null = null;
let clean = false;
let sourceEpoch: string | null = null;
let normalizedInputHash: string | null = null;
let sourceCoverageComplete = false;
let sourceComparable = false;
let sourceLeafDifferenceCount = 0;
let sourceProblemCodes: string[] = [];
const rawBlockedReasons: Record<string, number> = {};
try {
  const captured = await loadRaidCapture(captureDirectory);
  sourceEpoch = captured.sourceEpoch;
  normalizedInputHash = captured.normalizedInputHash;
  const candidate = buildRaidSource(captured.input);
  metrics.rawSourceBlocked = candidate.blocked.length;
  metrics.candidateUnits = candidate.facts.length;
  sourceCoverageComplete = candidate.scope.complete;
  for (const finding of candidate.blocked)
    rawBlockedReasons[finding.reason] =
      (rawBlockedReasons[finding.reason] ?? 0) + 1;
  const sourceComparison = compareRaidSource(candidate, captured.served);
  metrics.expectedUnits = sourceComparison.servedRaidUnits;
  sourceComparable = sourceComparison.comparable;
  sourceProblemCodes = [...sourceComparison.problems];
  sourceLeafDifferenceCount = sourceComparison.differences.length;
  metrics.unsupportedOtherLaneRows = sourceComparison.excludedOtherLaneRows;
  assert.ok(
    allowKnownRaidSubset(sourceComparison),
    "served_raid_context_or_leaf_mismatch",
  );
  const { actor, opaque } = privateAliases();
  const aliases = captured.expectedRoster.map(actor);
  assert.equal(new Set(aliases).size, aliases.length, "actor_alias_collision");
  runtime = await createPostgresFixtureRuntime(
    process.env.PG_TEST_URL,
    8,
    true,
  );
  const { workerStore } = runtime;
  assert.ok(workerStore);
  const priorJobs = await runtime.ownerQuery<{ count: string }>(
    "SELECT count(*)::text AS count FROM reputation.jobs WHERE state IN ('ready','leased')",
  );
  assert.equal(
    priorJobs.rows[0]?.count,
    "0",
    "isolated_candidate_db_has_existing_jobs",
  );
  const source = new PostgresReputationSourceStore(
    runtime.auth,
    runtime.ingress,
  );
  const key = "participation.distinctRaidPost";
  const frozenPoints = rule(captured.input);
  assert.ok(
    candidate.facts.every(
      (fact) =>
        fact.points === frozenPoints &&
        fact.rulesHash === captured.input.frozenRulesHash &&
        fact.category === "participation",
    ),
  );
  const ruleConfig = {
    rulesHash: captured.input.frozenRulesHash,
    key,
    points: frozenPoints,
    category: "participation",
    cap: { unit: "occurrence", limit: 1 },
    validFrom: captured.input.weekStart,
    validTo: null,
  };
  await runtime.operator.query("SELECT reputation.configure_rule($1::jsonb)", [
    JSON.stringify(ruleConfig),
  ]);
  const factsByItem = new Map<string, RaidFact>();
  const originals = new Map<string, Parameters<typeof source.record>[1]>();
  for (const fact of candidate.facts) {
    deadline.throwIfAborted();
    const input = {
      source: "captured-observed-raid-v1",
      sourceKey: opaque("source", fact.sourceId),
      title: "Captured dated participation unit",
      description:
        "Original dated source evidence; policy selected from frozen captured rules.",
      occurredAt: fact.occurredAt,
      evidence: fact.evidence.map((url) => ({
        id: opaque("evidence", url),
        url,
        label: "Captured source evidence",
      })),
    };
    const receipt = await source.record(actor(fact.actorId), input);
    assert.equal(receipt.item.status, "pending");
    assert.equal(receipt.item.points, "0");
    assert.deepEqual(
      receipt.item.evidence.map((evidence) => evidence.url).sort(),
      [...fact.evidence].sort(),
    );
    assert.equal(instant(receipt.item.occurredAt), instant(fact.occurredAt));
    factsByItem.set(receipt.item.id, fact);
    originals.set(receipt.item.id, input);
    metrics.ingested++;
    assert.deepEqual(await source.record(actor(fact.actorId), input), receipt);
    metrics.replayChecks++;
  }
  for (let index = 0; index < candidate.facts.length; index++) {
    deadline.throwIfAborted();
    const job = await workerStore.claim(["source_fact"], 60);
    assert.ok(job, "candidate_job_missing");
    const fact = factsByItem.get(job.itemId);
    assert.ok(fact, "unexpected_other_job_claimed");
    const outcome: JobCommit = await workerStore.commitReport(
      job.itemId,
      job.leaseToken,
      {
        rulesHash: fact.rulesHash,
        ruleKey: fact.ruleKey,
        semanticKey: opaque("semantic", fact.semanticKey),
        sourceId: job.sourceId,
      },
    );
    assert.equal(outcome.state, "completed");
    assert.equal(outcome.item.status, "accepted");
    assert.equal(outcome.item.points, frozenPoints);
    assert.deepEqual(
      await workerStore.commitReport(job.itemId, job.leaseToken, {
        rulesHash: fact.rulesHash,
        ruleKey: fact.ruleKey,
        semanticKey: opaque("semantic", fact.semanticKey),
        sourceId: job.sourceId,
      }),
      outcome,
    );
    metrics.committed++;
    metrics.replayChecks++;
  }
  assert.equal(await workerStore.claim(["source_fact"], 60), null);
  const firstOriginal = originals.entries().next().value;
  if (firstOriginal) {
    const [itemId, input] = firstOriginal;
    const fact = factsByItem.get(itemId);
    assert.ok(fact);
    const replay = await source.record(actor(fact.actorId), input);
    assert.equal(replay.item.status, "pending");
    assert.equal(
      (await runtime.store.item(actor(fact.actorId), itemId))?.status,
      "accepted",
    );
    metrics.replayChecks++;
  }
  const expectedByActor = new Map(
    captured.served.members.map((member) => [
      member.userId,
      member.items.filter(
        (item) => item.category === "raid" || item.key.startsWith("raid:"),
      ),
    ]),
  );
  for (const rawActor of captured.expectedRoster) {
    deadline.throwIfAborted();
    const current = actor(rawActor);
    const expected = expectedByActor.get(rawActor);
    assert.ok(expected);
    const expectedUnits = expected.reduce(
      (sum, item) => sum + exactPoints(item.points).units,
      0n,
    );
    const summary = await runtime.store.summary(current, "all");
    metrics.actors++;
    if (!expected.length) metrics.zeroActors++;
    if (
      exactPoints(summary.totalPoints).units !== expectedUnits ||
      exactPoints(summary.lifetimePoints).units !== expectedUnits ||
      summary.pendingCount !== 0
    )
      metrics.summaryMismatches++;
    if (
      summary.categories.some(
        (entry) =>
          exactPoints(entry.points).units !==
          (entry.category === "participation" ? expectedUnits : 0n),
      )
    )
      metrics.summaryMismatches++;
    const actual: ReputationItem[] = [];
    let cursor: string | null = null;
    do {
      const page = await runtime.store.items(current, "all", cursor);
      actual.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    if (actual.length !== expected.length) metrics.itemMismatches++;
    const expectedKeys = new Set(expected.map((item) => item.key));
    const actualKeys = new Set<string>();
    for (const item of actual) {
      const fact = factsByItem.get(item.id);
      if (!fact || fact.actorId !== rawActor) {
        metrics.semanticMismatches++;
        continue;
      }
      actualKeys.add(fact.key);
      const served = expected.find((entry) => entry.key === fact.key);
      if (
        !served ||
        item.status !== "accepted" ||
        item.category !== "participation" ||
        item.ruleHash !== fact.rulesHash ||
        item.points !== exactPoints(served.points).decimal
      )
        metrics.itemMismatches++;
      if (
        JSON.stringify(item.evidence.map((evidence) => evidence.url).sort()) !==
        JSON.stringify([...(served?.evidence ?? [])].sort())
      )
        metrics.evidenceMismatches++;
      if (!expectedKeys.has(fact.key)) metrics.semanticMismatches++;
    }
    if (
      actualKeys.size !== expectedKeys.size ||
      [...expectedKeys].some((key) => !actualKeys.has(key))
    )
      metrics.semanticMismatches++;
    const first = actual[0];
    const other = captured.expectedRoster.find((id) => id !== rawActor);
    if (first && other !== undefined) {
      assert.equal(await runtime.store.item(actor(other), first.id), null);
      metrics.privacyChecks++;
    }
  }
  assert.ok(
    allowKnownRaidSubset(sourceComparison),
    "served_raid_context_or_leaf_mismatch",
  );
  assert.equal(
    metrics.summaryMismatches +
      metrics.itemMismatches +
      metrics.evidenceMismatches +
      metrics.semanticMismatches,
    0,
    "actual_candidate_projection_mismatch",
  );
} catch (error) {
  const firstLine =
    error instanceof Error ? (error.message.split("\n")[0] ?? "") : "";
  const databaseCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9]{5}$/.test(error.code)
      ? error.code
      : null;
  failure =
    firstLine === "source_epoch_waiting"
      ? "waiting_for_source_epoch"
      : databaseCode
        ? `database_${databaseCode}`
        : /^[a-z][a-z0-9_]{0,127}$/.test(firstLine)
          ? firstLine
          : "candidate_raid_assertion_failed";
  failureLocation =
    error instanceof Error
      ? (error.stack?.match(
          /reputation(?:-raid-shadow|\/raid-shadow-input)\.ts:\d+:\d+/,
        )?.[0] ?? null)
      : null;
  process.exitCode = 1;
} finally {
  try {
    await runtime?.close();
    clean = true;
  } catch {
    failure = "candidate_cleanup_failed";
    process.exitCode = 1;
  }
  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      scope: "raw_dated_raid_subset",
      independentCandidate: true,
      independentScoring: true,
      actualPostgres: runtime !== undefined,
      state: failure
        ? failure === "waiting_for_source_epoch"
          ? "waiting"
          : "failed"
        : sourceCoverageComplete
          ? "verified_raid_subset"
          : "verified_subset_with_source_gaps",
      sqlProjectionParity: failure === null,
      sourceCoverageComplete,
      sourceComparable,
      sourceProblemCodes,
      sourceLeafDifferenceCount,
      rawBlockedReasons,
      scoreAuthority: "frozen_rule_sql",
      platformCategory: "participation",
      sourceCategory: "raid",
      sourceEpoch,
      normalizedInputHash,
      metrics,
      failure,
      failureLocation,
      clean,
      limitation:
        "Only dated raid units; other lanes, full lifetime provenance, metadata parity and production cutover remain unsupported.",
    })}\n`,
  );
}
