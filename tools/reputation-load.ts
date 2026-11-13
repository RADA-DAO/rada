import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createPostgresFixtureRuntime } from "../modules/reputation/tests/postgres-fixture.ts";

/** Synthetic bounded load only. Caller owns queued execution and cluster cleanup. */
const integer = (name: string, fallback: number, min: number, max: number) => {
  const raw = process.env[name] ?? String(fallback);
  assert.match(raw, /^\d+$/);
  const value = Number(raw);
  assert.ok(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `${name} must be ${String(min)}..${String(max)}`,
  );
  return value;
};
const actorCount = integer("REPUTATION_LOAD_ACTORS", 1000, 1, 1000);
const commandsPerActor = integer("REPUTATION_LOAD_COMMANDS", 4, 2, 20);
const concurrency = integer("REPUTATION_LOAD_CONCURRENCY", 8, 1, 32);
const budgetSeconds = integer("REPUTATION_LOAD_SECONDS", 120, 1, 900);
assert.ok(process.env.PG_TEST_URL, "PG_TEST_URL is required");
const runtime = await createPostgresFixtureRuntime(
  process.env.PG_TEST_URL,
  concurrency,
);
const { store } = runtime;
const runId = randomBytes(8).toString("hex");
const base = 9000000000000n + BigInt(`0x${randomBytes(5).toString("hex")}`);
const actors = Array.from({ length: actorCount }, (_, index) =>
  String(base + BigInt(index)),
);
const commandMs: number[] = [];
const verificationMs: number[] = [];
const errors: Record<string, number> = {};
let successfulCommands = 0;
let verifiedActors = 0;
let timedOut = false;
let failure: string | null = null;
const delay = monitorEventLoopDelay({ resolution: 20 });
let started = 0;
let commandEnded = 0;
async function bounded(
  count: number,
  run: (index: number) => Promise<void>,
  deadline = Infinity,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, async () => {
      for (;;) {
        if (performance.now() >= deadline) {
          timedOut = true;
          return;
        }
        const index = next++;
        if (index >= count) return;
        await run(index);
      }
    }),
  );
}
const percentile = (values: number[], fraction: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const value =
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
    ];
  return value === undefined ? null : Math.round(value * 1000) / 1000;
};
const stats = (values: number[]) => ({
  count: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
});
try {
  // Setup is deliberately excluded from measured command throughput.
  await bounded(actors.length, async (index) => {
    const actor = actors[index];
    assert.ok(actor);
    await runtime.subject(actor);
  });
  const fixture = await runtime.fixture();
  const mission = await fixture.seedMission({
    points: "0.125",
    verifier: "acknowledgement",
  });
  delay.enable();
  started = performance.now();
  const deadline = started + budgetSeconds * 1000;
  const expectedCommands = actorCount * commandsPerActor;
  await bounded(
    expectedCommands,
    async (index) => {
      const actorIndex = Math.floor(index / commandsPerActor);
      const ordinal = index % commandsPerActor;
      const actor = actors[actorIndex];
      assert.ok(actor);
      const requestId = `${runId}:${String(actorIndex)}:${String(ordinal)}`;
      const began = performance.now();
      try {
        if (ordinal < 2) {
          await store.verify(actor, mission.id, {
            requestId,
            missionVersion: 1,
          });
        } else {
          await store.report(actor, {
            requestId,
            title: `Synthetic load result ${String(ordinal)}`,
            description: "Synthetic bounded load fixture; no real contribution",
            occurredAt: new Date().toISOString(),
          });
        }
        successfulCommands++;
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "unknown";
        errors[code] = (errors[code] ?? 0) + 1;
      } finally {
        commandMs.push(performance.now() - began);
      }
    },
    deadline,
  );
  commandEnded = performance.now();
  assert.equal(timedOut, false, "command budget exhausted");
  assert.equal(successfulCommands, expectedCommands, "some commands failed");
  await bounded(
    actorCount,
    async (index) => {
      const began = performance.now();
      const actor = actors[index];
      assert.ok(actor);
      const [summary, page, changes, first, second] = await Promise.all([
        store.summary(actor, "all"),
        store.items(actor, "all", null),
        store.changes(actor, "0"),
        store.command(actor, `${runId}:${String(index)}:0`),
        store.command(actor, `${runId}:${String(index)}:1`),
      ]);
      const expectedItems = commandsPerActor - 1;
      assert.equal(summary.totalPoints, "0.125");
      assert.equal(summary.lifetimePoints, "0.125");
      assert.equal(summary.pendingCount, commandsPerActor - 2);
      assert.equal(summary.revision, String(expectedItems));
      assert.equal(page.items.length, expectedItems);
      assert.equal(page.nextCursor, null);
      assert.equal(
        page.items.filter((item) => item.status === "accepted").length,
        1,
      );
      assert.equal(changes.changes.length, expectedItems);
      assert.equal(changes.hasMore, false);
      assert.equal(changes.nextCursor, summary.revision);
      assert.equal(
        new Set(changes.changes.map((change) => change.revision)).size,
        expectedItems,
      );
      assert.ok(first && second);
      assert.equal(first.item.id, second.item.id);
      assert.equal(first.summary.totalPoints, "0.125");
      assert.equal(second.summary.totalPoints, "0.125");
      assert.equal(
        (
          await store.verify(actor, mission.id, {
            requestId: first.requestId,
            missionVersion: 1,
          })
        ).item.id,
        first.item.id,
      );
      verifiedActors++;
      verificationMs.push(performance.now() - began);
    },
    deadline,
  );
  assert.equal(verifiedActors, actorCount, "verification budget exhausted");
  const firstActor = actors[0];
  const secondActor = actors[1];
  if (firstActor && secondActor) {
    assert.equal(await store.command(secondActor, `${runId}:0:0`), null);
    const owned = await store.command(firstActor, `${runId}:0:0`);
    assert.ok(owned);
    assert.equal(await store.item(secondActor, owned.item.id), null);
  }
} catch (error) {
  failure = error instanceof Error ? error.message : "load invariant failed";
  process.exitCode = 1;
} finally {
  const finished = performance.now();
  delay.disable();
  const commandDuration =
    commandEnded > started ? commandEnded - started : finished - started;
  process.stdout.write(
    `${JSON.stringify({
      synthetic: true,
      actors: actorCount,
      commandsPerActor,
      concurrency,
      budgetSeconds,
      successfulCommands,
      verifiedActors,
      errors,
      timedOut,
      failure,
      measuredCommandMs: Math.round(commandDuration),
      measuredTotalMs: started ? Math.round(finished - started) : null,
      successfulCommandsPerSecond:
        commandDuration > 0 && started
          ? Math.round((successfulCommands * 1000000) / commandDuration) / 1000
          : null,
      commandLatencyMs: stats(commandMs),
      verificationActorMs: stats(verificationMs),
      eventLoopDelayMs: {
        p50: delay.percentile(50) / 1e6,
        p95: delay.percentile(95) / 1e6,
        p99: delay.percentile(99) / 1e6,
        max: delay.max / 1e6,
      },
      rssBytes: process.memoryUsage().rss,
    })}\n`,
  );
  await runtime.close();
}
