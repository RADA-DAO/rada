import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readModuleStream } from "../../packages/platform-sdk/src/module-stream.ts";
import type {
  Changes,
  CommandResult,
  Mission,
} from "../../modules/reputation/index.ts";
type Observation = {
  actorIndex: number;
  revision: string;
  received: number;
  recordedToEventMs: number;
};
export type Write = {
  actorIndex: number;
  requestId: string;
  mission: Mission;
  start: number;
  acknowledged: number;
  scheduleLag: number;
  receipt: CommandResult | null;
};
type Stream = {
  actorIndex: number;
  controller: AbortController;
  cursor: string;
  done: Promise<void>;
  intentional: boolean;
};
export function realtimeState() {
  const streams: Stream[] = [];
  const currentStreams = new Map<number, Stream>();
  const observed = new Map<string, Observation>();
  const writes: Write[] = [];
  const streamFailures: string[] = [];
  return {
    streams,
    currentStreams,
    observed,
    writes,
    streamFailures,
    currentConnections: 0,
    peakConnections: 0,
  };
}
export const exactTotal = (count: number) => {
  const units = BigInt(count) * 1250n;
  const fraction = String(units % 10000n)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return `${String(units / 10000n)}${fraction ? `.${fraction}` : ""}`;
};
export function realtimeClient(
  origin: string,
  actors: string[],
  signal: AbortSignal,
  state: ReturnType<typeof realtimeState>,
) {
  const { streams, currentStreams, observed, writes, streamFailures } = state;
  const secret = createHmac("sha256", "WebAppData")
    .update("synthetic-fixture-bot-token")
    .digest();
  function authorization(actor: string): string {
    const data = new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: Number(actor) }),
    });
    const check = [...data.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    data.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
    return `tma ${data.toString()}`;
  }
  function actorAt(index: number): string {
    const actor = actors[index];
    assert.ok(actor);
    return actor;
  }
  async function http(
    actor: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", authorization(actor));
    return await fetch(`${origin}/api/v1/reputation${path}`, {
      ...init,
      headers,
      signal: signal,
    });
  }
  async function json<T>(
    actor: string,
    path: string,
    status = 200,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await http(actor, path, init);
    assert.equal(response.status, status, `${path} HTTP status`);
    return (await response.json()) as T;
  }
  async function closeStream(stream: Stream): Promise<void> {
    stream.intentional = true;
    stream.controller.abort();
    await stream.done;
    if (currentStreams.get(stream.actorIndex) === stream)
      currentStreams.delete(stream.actorIndex);
  }
  async function openStream(
    actorIndex: number,
    after = "0",
    lastEventHeader = false,
  ): Promise<Stream> {
    const controller = new AbortController();
    const streamSignal = AbortSignal.any([signal, controller.signal]);
    const response = await fetch(
      `${origin}/api/v1/reputation/stream${lastEventHeader ? "" : `?after=${after}`}`,
      {
        headers: {
          authorization: authorization(actorAt(actorIndex)),
          ...(lastEventHeader ? { "Last-Event-ID": after } : {}),
        },
        signal: streamSignal,
      },
    );
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`stream_http_${String(response.status)}`);
    }
    assert.match(
      response.headers.get("content-type") ?? "",
      /text\/event-stream/,
    );
    assert.ok(response.body);
    const stream: Stream = {
      actorIndex,
      controller,
      cursor: after,
      done: Promise.resolve(),
      intentional: false,
    };
    streams.push(stream);
    currentStreams.set(actorIndex, stream);
    state.currentConnections++;
    state.peakConnections = Math.max(
      state.peakConnections,
      state.currentConnections,
    );
    stream.done = readModuleStream(
      response.body,
      {
        signal: streamSignal,
        onEvent(event) {
          assert.equal(event.event, "changes");
          assert.ok(event.data && typeof event.data === "object");
          const delta = event.data as Changes;
          assert.equal(delta.version, 1);
          assert.equal(delta.resetRequired, false);
          assert.ok(Array.isArray(delta.changes));
          assert.equal(event.id, delta.nextCursor);
          for (const change of delta.changes) {
            assert.ok(
              BigInt(change.revision) > BigInt(stream.cursor),
              "stream revisions must advance",
            );
            assert.equal(change.type, "item");
            assert.ok(
              !observed.has(change.itemId),
              "item emitted twice or leaked to another actor",
            );
            const recordedToEventMs =
              Date.now() - Date.parse(change.recordedAt);
            assert.ok(Number.isFinite(recordedToEventMs));
            observed.set(change.itemId, {
              actorIndex,
              revision: change.revision,
              received: performance.now(),
              recordedToEventMs,
            });
            stream.cursor = change.revision;
          }
          assert.ok(BigInt(delta.nextCursor) >= BigInt(stream.cursor));
          stream.cursor = delta.nextCursor;
        },
      },
      () => true,
    )
      .then(
        () => {
          if (!stream.intentional && !signal.aborted)
            streamFailures.push("unexpected_stream_eof");
        },
        (error: unknown) => {
          if (!stream.intentional && !signal.aborted)
            streamFailures.push(
              error instanceof Error ? error.message : "stream_read_error",
            );
        },
      )
      .finally(() => {
        state.currentConnections--;
      });
    return stream;
  }
  function prepareWrite(actorIndex: number, mission: Mission): Write {
    const write: Write = {
      actorIndex,
      mission,
      requestId: randomUUID(),
      start: 0,
      acknowledged: 0,
      scheduleLag: 0,
      receipt: null,
    };
    writes.push(write);
    return write;
  }
  async function send(write: Write, discard = false): Promise<void> {
    write.start = performance.now();
    const response = await http(
      actorAt(write.actorIndex),
      `/missions/${write.mission.id}/verify`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: write.requestId,
          missionVersion: write.mission.version,
        }),
      },
    );
    write.acknowledged = performance.now();
    assert.equal(response.status, 200);
    if (discard) {
      // The HTTP acknowledgement is deliberately discarded after the server committed.
      await response.body?.cancel();
      write.receipt = await json<CommandResult>(
        actorAt(write.actorIndex),
        `/commands/${write.requestId}`,
      );
    } else write.receipt = (await response.json()) as CommandResult;
    assert.equal(write.receipt.requestId, write.requestId);
    assert.equal(write.receipt.state, "completed");
    assert.equal(write.receipt.item.status, "accepted");
    assert.equal(write.receipt.item.points, "0.125");
  }
  return { actorAt, http, json, closeStream, openStream, prepareWrite, send };
}
