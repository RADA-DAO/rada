import { test } from "node:test";
import assert from "node:assert/strict";
import { readModuleStream, type ModuleStreamEvent } from "./module-stream.ts";
import { moduleApiAdapter, modulePath } from "./module-api.ts";

function source(parts: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts)
        controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}

await test("stream handles fragmented CRLF, multiline data, comments and incomplete EOF", async () => {
  const events: ModuleStreamEvent[] = [];
  await readModuleStream(
    source([
      ": heartbeat\r",
      '\nevent: changes\r\nid: 7\r\ndata: {"revision":\r',
      '\ndata: "7"}\r\n\r',
      '\nevent: changes\ndata: {"revision":"8"}',
    ]),
    {
      onEvent: (event) => {
        events.push(event);
      },
    },
    () => true,
  );
  assert.deepEqual(events, [
    { event: "changes", id: "7", data: { revision: "7" } },
  ]);
});

await test("stream refuses oversized events and invalid JSON", async () => {
  const options = {
    onEvent() {
      assert.fail("must not emit");
    },
  };
  await assert.rejects(
    readModuleStream(
      source(["data: " + "x".repeat(65536)]),
      options,
      () => true,
    ),
    /stream_too_large/,
  );
  await assert.rejects(
    readModuleStream(source(["data: nope\n\n"]), options, () => true),
    SyntaxError,
  );
});

await test("credential change suppresses in-flight events and cancels reader", async () => {
  let active = true;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      active = false;
      controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readModuleStream(
      body,
      {
        onEvent() {
          assert.fail();
        },
      },
      () => active,
    ),
    /expired/,
  );
  assert.equal(cancelled, true);
});

await test("abort releases a reader waiting for network data", async () => {
  let cancelled = false;
  const abort = new AbortController();
  const pending = readModuleStream(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    {
      signal: abort.signal,
      onEvent() {
        assert.fail();
      },
    },
    () => true,
  );
  abort.abort();
  await pending;
  assert.equal(cancelled, true);
});

await test("reputation queries are scoped, unique and bounded", () => {
  for (const path of [
    "/v1/reputation/items?period=previous_week&cursor=abc_1",
    "/v1/reputation/stream?after=0",
  ])
    assert.equal(modulePath("reputation", path), path);
  for (const path of [
    "/v1/reputation/summary?period=all&period=today",
    "/v1/reputation/items?actor=someone",
    "/v1/reputation/stream?after=-1",
    "/v1/reputation/stream?after=1#secret",
    "/v1/reputation/reports?period=all",
    "/v1/reputation/items?cursor=%2fadmin",
  ])
    assert.throws(() => modulePath("reputation", path));
});

await test("stream auth stays in headers and is limited to reputation stream", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (url, options) => {
    calls++;
    assert.equal(url, "https://api.example/v1/reputation/stream?after=0");
    assert.deepEqual(options?.headers, {
      Authorization: "tma synthetic",
      Accept: "text/event-stream",
    });
    return Promise.resolve(
      new Response(source(["data: {}\n\n"]), {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
  };
  try {
    const api = moduleApiAdapter("https://api.example", () => ({
      Authorization: "tma synthetic",
    })).moduleApi("reputation");
    const options = { onEvent() {} };
    assert.ok(api.stream);
    await api.stream("/v1/reputation/stream?after=0", options);
    await assert.rejects(
      api.stream("/v1/reputation/items", options),
      /invalid_request/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
