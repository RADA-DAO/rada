import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import { createPostgresFixtureRuntime } from "./reputation/postgres-fixture.ts";
import { browserServer } from "./reputation/browser-server.ts";
import {
  realtimeState,
  realtimeClient,
  exactTotal,
  type Write,
} from "./reputation/realtime-client.ts";
import type {
  Changes,
  CommandResult,
  Mission,
  Summary,
} from "../modules/reputation/index.ts";

/** Author-only harness: caller owns queued PostgreSQL lifecycle and ulimit >=4096. */
const integer = (name: string, fallback: number, min: number, max: number) => {
  const raw = process.env[name] ?? String(fallback);
  assert.match(raw, /^\d+$/);
  const value = Number(raw);
  assert.ok(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `invalid ${name}`,
  );
  return value;
};
const actorCount = integer("REPUTATION_REALTIME_ACTORS", 1000, 1, 1000);
const pacedWrites = integer("REPUTATION_REALTIME_WRITES", 100, 1, 1000);
const burstWrites = integer("REPUTATION_REALTIME_BURST", 0, 0, 500);
assert.ok(burstWrites === 0 || burstWrites === 500, "burst must be 0 or 500");
const seconds = integer("REPUTATION_REALTIME_SECONDS", 120, 10, 120);
assert.ok(process.env.PG_TEST_URL, "PG_TEST_URL is required");
const abort = new AbortController();
const deadline = setTimeout(() => {
  abort.abort(new Error("realtime_budget_exhausted"));
}, seconds * 1000);
const interrupt = () => {
  abort.abort(new Error("realtime_interrupted"));
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const started = performance.now();
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
type Runtime = Awaited<ReturnType<typeof createPostgresFixtureRuntime>>;
type Server = Awaited<ReturnType<typeof browserServer>>;
let runtime: Runtime | undefined;
let server: Server | undefined;
const state = realtimeState();
const { streams, currentStreams, observed, writes, streamFailures } = state;
let client: ReturnType<typeof realtimeClient> | undefined;
let connectionsAtWriteStart = 0;
let reconnectRecovered = false;
let unknownResponseRecovered = false;
let summaryChecks = 0;
let isolationChecks = 0;
let pacedDurationMs = 0;
let burstDurationMs = 0;
let streamOpenDurationMs = 0;
let serverClosed = false;
let storeClosed = false;
let failure: string | null = null;
const base = 9000000000000n + BigInt(`0x${randomBytes(5).toString("hex")}`);
const actors = Array.from({ length: actorCount }, (_, index) =>
  String(base + BigInt(index)),
);
const outsideActor = String(base + BigInt(actorCount) + 1n);
async function bounded(
  count: number,
  concurrency: number,
  run: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      for (;;) {
        abort.signal.throwIfAborted();
        const index = next++;
        if (index >= count) return;
        await run(index);
      }
    }),
  );
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
}
async function until(predicate: () => boolean): Promise<void> {
  const end = Math.min(started + seconds * 1000, performance.now() + 15000);
  while (!predicate()) {
    abort.signal.throwIfAborted();
    assert.deepEqual(streamFailures, []);
    assert.ok(
      performance.now() < end,
      "notification/reconnect wait exceeded 15 seconds",
    );
    await pause(10, undefined, { signal: abort.signal });
  }
}

try {
  runtime = await createPostgresFixtureRuntime(process.env.PG_TEST_URL, 16);
  server = await browserServer(runtime);
  client = realtimeClient(server.origin, actors, abort.signal, state);
  const { actorAt, json, closeStream, openStream, prepareWrite, send } = client;
  const activeRuntime = runtime;
  await bounded(actorCount, 16, async (index) => {
    await activeRuntime.subject(actorAt(index));
  });
  await runtime.subject(outsideActor);
  const fixture = await runtime.fixture();
  const missions: Mission[] = [];
  await bounded(pacedWrites + burstWrites + 2, 8, async (index) => {
    missions[index] = await fixture.seedMission({
      points: "0.125",
      verifier: "acknowledgement",
    });
  });
  const streamOpenStarted = performance.now();
  await bounded(actorCount, 32, async (index) => {
    await openStream(index);
  });
  streamOpenDurationMs = performance.now() - streamOpenStarted;
  // Real HTTP warm reads drain initial actor-scoped auth/subscription/read setup.
  await bounded(actorCount, 16, async (index) => {
    const changes = await json<Changes>(actorAt(index), "/changes?after=0");
    assert.deepEqual(changes.changes, []);
  });
  assert.equal(state.currentConnections, actorCount);
  assert.equal(currentStreams.size, actorCount);
  connectionsAtWriteStart = state.currentConnections;
  const pacedStart = performance.now();
  const paced: Promise<PromiseSettledResult<void>>[] = [];
  for (let index = 0; index < pacedWrites; index++) {
    const planned = pacedStart + index * 10;
    if (performance.now() < planned)
      await pause(planned - performance.now(), undefined, {
        signal: abort.signal,
      });
    const mission = missions[index];
    assert.ok(mission);
    const write = prepareWrite(index % actorCount, mission);
    write.scheduleLag = Math.max(0, performance.now() - planned);
    paced.push(
      send(write).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ),
    );
  }
  const pacedResults = await Promise.all(paced);
  const pacedRejected = pacedResults.find(
    (result) => result.status === "rejected",
  );
  if (pacedRejected?.status === "rejected") throw pacedRejected.reason;
  pacedDurationMs = performance.now() - pacedStart;
  await until(() => observed.size === writes.length);
  assert.equal(state.currentConnections, actorCount);
  if (burstWrites) {
    const burstStart = performance.now();
    await bounded(burstWrites, burstWrites, async (index) => {
      const mission = missions[pacedWrites + index];
      assert.ok(mission);
      await send(prepareWrite(index % actorCount, mission));
    });
    burstDurationMs = performance.now() - burstStart;
    await until(() => observed.size === writes.length);
    assert.equal(state.currentConnections, actorCount);
  }
  const reconnecting = currentStreams.get(0);
  assert.ok(reconnecting);
  const savedCursor = reconnecting.cursor;
  await closeStream(reconnecting);
  assert.equal(state.currentConnections, actorCount - 1);
  const offlineMission = missions[pacedWrites + burstWrites];
  assert.ok(offlineMission);
  const offline = prepareWrite(0, offlineMission);
  await send(offline);
  assert.ok(offline.receipt);
  assert.ok(!observed.has(offline.receipt.item.id));
  await openStream(0, savedCursor, true);
  await until(() => !!offline.receipt && observed.has(offline.receipt.item.id));
  reconnectRecovered = true;
  const unknownMission = missions[pacedWrites + burstWrites + 1];
  assert.ok(unknownMission);
  const unknown = prepareWrite(actorCount - 1, unknownMission);
  await send(unknown, true);
  assert.ok(unknown.receipt);
  const replayed = await json<CommandResult>(
    actorAt(unknown.actorIndex),
    `/missions/${unknownMission.id}/verify`,
    200,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: unknown.requestId,
        missionVersion: unknownMission.version,
      }),
    },
  );
  assert.deepEqual(replayed, unknown.receipt);
  unknownResponseRecovered = true;
  await until(() => observed.size === writes.length);
  assert.equal(state.currentConnections, actorCount);
  assert.deepEqual(streamFailures, []);
  const byActor = new Map<number, Write[]>();
  for (const write of writes) {
    assert.ok(write.receipt);
    const emission = observed.get(write.receipt.item.id);
    assert.ok(emission);
    assert.equal(emission.actorIndex, write.actorIndex, "cross-actor SSE leak");
    const previous = byActor.get(write.actorIndex) ?? [];
    previous.push(write);
    byActor.set(write.actorIndex, previous);
  }
  await bounded(actorCount, 16, async (index) => {
    const expected = byActor.get(index) ?? [];
    const [{ summary }, changes] = await Promise.all([
      json<{ summary: Summary }>(actorAt(index), "/summary?period=all"),
      json<Changes>(actorAt(index), "/changes?after=0"),
    ]);
    assert.equal(summary.totalPoints, exactTotal(expected.length));
    assert.equal(summary.lifetimePoints, exactTotal(expected.length));
    assert.equal(summary.pendingCount, 0);
    assert.equal(summary.revision, String(expected.length));
    const allIds: string[] = [];
    let page = changes;
    for (;;) {
      assert.equal(page.resetRequired, false);
      allIds.push(...page.changes.map((change) => change.itemId));
      if (!page.hasMore) break;
      page = await json<Changes>(
        actorAt(index),
        `/changes?after=${page.nextCursor}`,
      );
    }
    assert.deepEqual(
      allIds.sort(),
      expected
        .map((write) => {
          assert.ok(write.receipt);
          return write.receipt.item.id;
        })
        .sort(),
    );
    assert.equal(currentStreams.get(index)?.cursor, summary.revision);
    summaryChecks++;
  });
  await bounded(writes.length, 16, async (index) => {
    const write = writes[index];
    assert.ok(write?.receipt);
    const other =
      actorCount === 1
        ? outsideActor
        : actorAt((write.actorIndex + 1) % actorCount);
    await json(other, `/items/${write.receipt.item.id}`, 404);
    await json(other, `/commands/${write.requestId}`, 404);
    isolationChecks += 2;
  });
  assert.deepEqual(server.failures, []);
  assert.deepEqual(streamFailures, []);
} catch (error) {
  failure =
    error instanceof Error ? error.message : "realtime_invariant_failed";
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  abort.abort();
  if (client) await Promise.allSettled(streams.map(client.closeStream));
  try {
    await server?.close();
    serverClosed = !!server;
  } catch (error) {
    failure ??=
      error instanceof Error ? error.message : "server_cleanup_failed";
    process.exitCode = 1;
  }
  try {
    await runtime?.close();
    storeClosed = !!runtime;
  } catch (error) {
    failure ??= error instanceof Error ? error.message : "store_cleanup_failed";
    process.exitCode = 1;
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  lag.disable();
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (p: number) => {
      const value =
        sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
      return value === undefined ? null : Math.round(value * 1000) / 1000;
    };
    return {
      count: values.length,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
    };
  };
  const delivered = writes.flatMap((write) => {
    if (!write.receipt) return [];
    const event = observed.get(write.receipt.item.id);
    return event ? [{ write, event }] : [];
  });
  const phaseLatency = (phase: Write[]) => {
    const deliveries = phase.flatMap((write) => {
      const event = write.receipt
        ? observed.get(write.receipt.item.id)
        : undefined;
      return event ? [{ write, event }] : [];
    });
    return {
      httpAcknowledgementMs: stats(
        phase
          .filter((write) => write.acknowledged > 0)
          .map((write) => write.acknowledged - write.start),
      ),
      writeStartToEventMs: stats(
        deliveries.map(({ write, event }) => event.received - write.start),
      ),
      recordedAtToEventMs: stats(
        deliveries.map(({ event }) => event.recordedToEventMs),
      ),
    };
  };
  if (state.currentConnections !== 0) {
    failure ??= "readers_not_closed";
    process.exitCode = 1;
  }
  process.stdout.write(
    `${JSON.stringify({
      synthetic: true,
      transport: "real_http_sse",
      actorCount,
      pacedWrites,
      burstWrites,
      offeredPacedWritesPerSecond: 100,
      connectionsAtWriteStart,
      peakConnections: state.peakConnections,
      finalConnections: state.currentConnections,
      totalStreamInstances: streams.length,
      successfulWrites: writes.filter((write) => write.receipt !== null).length,
      deliveredItems: observed.size,
      summaryChecks,
      isolationChecks,
      reconnectRecovered,
      unknownResponseRecovered,
      streamOpenDurationMs: Math.round(streamOpenDurationMs),
      serverClosed,
      storeClosed,
      pacedLatency: phaseLatency(writes.slice(0, pacedWrites)),
      burstLatency: phaseLatency(
        writes.slice(pacedWrites, pacedWrites + burstWrites),
      ),
      pacedDurationMs: Math.round(pacedDurationMs),
      burstDurationMs: Math.round(burstDurationMs),
      elapsedMs: Math.round(performance.now() - started),
      httpAcknowledgementMs: stats(
        writes
          .filter((write) => write.acknowledged > 0)
          .map((write) => write.acknowledged - write.start),
      ),
      writeStartToEventMs: stats(
        delivered.map(({ write, event }) => event.received - write.start),
      ),
      recordedAtToEventMs: stats(
        delivered.map(({ event }) => event.recordedToEventMs),
      ),
      dispatchLagMs: stats(
        writes.slice(0, pacedWrites).map((write) => write.scheduleLag),
      ),
      eventLoopDelayMs: {
        p50: lag.percentile(50) / 1e6,
        p95: lag.percentile(95) / 1e6,
        p99: lag.percentile(99) / 1e6,
        max: lag.max / 1e6,
      },
      rssBytes: process.memoryUsage().rss,
      streamFailures: streamFailures.slice(0, 8),
      serverFailures: server?.failures.slice(0, 8) ?? [],
      failure,
    })}\n`,
  );
}
