import type { Hono } from "hono";
import { parseReport } from "./sanitize.ts";
import { TokenBucket } from "./rate-limit.ts";
import type { ClientErrorStore } from "./store.ts";

export const MAX_BODY = 4096;

async function boundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_request");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > MAX_BODY) throw new Error("too_large");
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/**
 * Unauthenticated by design (browsers cannot sign a beacon), so it is strict:
 * global rate limit first, then size, then exact schema, then re-sanitization.
 * Register before the staging guard so the guard does not hide failures.
 */
export function registerClientErrorRoutes(
  app: Hono,
  store: ClientErrorStore,
  limiter: TokenBucket = new TokenBucket(60, 60),
) {
  app.post("/v1/client-errors", async (c) => {
    if (!limiter.take()) {
      c.header("Retry-After", "60");
      return c.json({ error: "rate_limited" }, 429);
    }
    // sendBeacon uses text/plain to stay a simple (preflight-free) request.
    if (
      !/^(?:application\/json|text\/plain)(?:\s*;|$)/i.test(
        c.req.header("content-type") ?? "",
      )
    )
      return c.json({ error: "invalid_request" }, 415);
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_BODY) return c.json({ error: "too_large" }, 413);
    let body: unknown;
    try {
      body = await boundedJson(c.req.raw);
    } catch (error) {
      return error instanceof Error && error.message === "too_large"
        ? c.json({ error: "too_large" }, 413)
        : c.json({ error: "invalid_request" }, 400);
    }
    const report = parseReport(body);
    if (!report) return c.json({ error: "invalid_request" }, 400);
    await store.record(report);
    return c.body(null, 204);
  });
}
