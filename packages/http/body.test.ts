import assert from "node:assert/strict";
import test from "node:test";
import { BodyTooLarge, readBoundedBody, readBoundedJson } from "./body.ts";

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[reads++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request("https://fixture.invalid", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);
  return { request, reads: () => reads, cancelled: () => cancelled };
}

test("bounded bodies accept an exact byte limit and empty bodies", async () => {
  const { request } = streamed([new Uint8Array([1, 2]), new Uint8Array([3])]);
  assert.deepEqual(
    await readBoundedBody(request, 3),
    new Uint8Array([1, 2, 3]),
  );
  assert.equal(
    (await readBoundedBody(new Request("https://fixture.invalid"), 3)).length,
    0,
  );
});

test("missing and understated lengths stop streaming at the first excess chunk", async () => {
  for (const headers of [{}, { "content-length": "1" }]) {
    const stream = streamed(
      Array.from({ length: 100 }, () => new Uint8Array(16)),
      headers,
    );
    await assert.rejects(readBoundedBody(stream.request, 32), BodyTooLarge);
    assert.equal(stream.reads(), 3);
    assert.equal(stream.cancelled(), true);
    assert.equal(stream.request.body?.locked, false);
  }
});

test("declared excess cancels without reading and JSON limits count UTF-8 bytes", async () => {
  const stream = streamed([new Uint8Array(1)], { "content-length": "100" });
  await assert.rejects(readBoundedBody(stream.request, 32), BodyTooLarge);
  assert.equal(stream.reads(), 0);
  assert.equal(stream.cancelled(), true);
  const json = new TextEncoder().encode('{"name":"éé"}');
  await assert.rejects(
    readBoundedJson(streamed([json]).request, json.length - 1),
    BodyTooLarge,
  );
  assert.deepEqual(
    await readBoundedJson(streamed([json]).request, json.length),
    { name: "éé" },
  );
  await assert.rejects(
    readBoundedJson(streamed([new TextEncoder().encode("{")]).request, 10),
    SyntaxError,
  );
});
