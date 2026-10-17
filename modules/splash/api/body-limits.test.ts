import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { registerClaimRoutes } from "./claims-router.ts";
import { registerRoundRoutes } from "./rounds-router.ts";
import type { ClaimService } from "./claim-service.ts";
import type { RoundStore } from "./rounds.ts";

const FROG = "11111111-1111-4111-8111-111111111111";
test("JSON routes stop oversized chunked bodies before calling services", async () => {
  const app = new Hono();
  const auth = () => Promise.resolve("101");
  registerClaimRoutes(app, {} as ClaimService, auth);
  registerRoundRoutes(app, {} as RoundStore, auth);
  for (const [path, method, limit, status] of [
    ["/v1/splash/bids", "POST", 1024, 413],
    [`/v1/splash/claims/${FROG}`, "POST", 1024, 413],
    ["/v1/splash/settings/recipient", "PUT", 1024, 413],
  ] as const) {
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
      new Request(`https://fixture.invalid${path}`, {
        method,
        body,
        headers: { "content-type": "application/json" },
        duplex: "half",
      } as RequestInit),
    );
    assert.equal(response.status, status, path);
    assert.equal(reads, limit / 256 + 1, path);
    assert.equal(cancelled, true, path);
  }
});
