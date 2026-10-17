import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { registerPaymentRoutes } from "./payment-router.ts";
import type { PostgresPaymentStore } from "./payments.ts";

test("payment creation cancels oversized chunked JSON before store access", async () => {
  const app = new Hono();
  registerPaymentRoutes(app, {} as PostgresPaymentStore, () =>
    Promise.resolve("101"),
  );
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(256));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const response = await app.request(
    new Request("https://fixture.invalid/me/payments", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      duplex: "half",
    } as RequestInit),
  );
  assert.equal(response.status, 400);
  assert.equal(reads, 17);
  assert.equal(cancelled, true);
});
