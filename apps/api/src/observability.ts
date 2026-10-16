import type { Context, Hono } from "hono";
import type {
  ClientErrorStore,
  TokenBucket,
} from "../../../modules/ops/index.ts";

// Failure records carry only: time, request id, method, route pattern, error
// class, optional stable code and duration. Never headers, bodies, URLs,
// messages, tokens, initData, Telegram profile data or IPs.
export interface FailureRecord {
  time: string;
  requestId: string;
  method: string;
  route: string;
  errorClass: string;
  errorCode?: string;
  durationMs: number;
}

export interface OpsOptions {
  token?: string | undefined;
  log?: ((line: string) => void) | undefined;
  /** Enables POST /v1/client-errors when present. */
  clientErrors?: ClientErrorStore | undefined;
  clientErrorLimiter?: TokenBucket | undefined;
  /** Shared failure counters, so a digest job can read them. */
  counts?: Map<string, number> | undefined;
}

const MAX_ROUTES = 256;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_METHOD = /^[A-Z]{3,10}$/;
const timings = new WeakMap<Request, { id: string; start: number }>();

export function routePattern(c: Context): string {
  const routes = c.req.matchedRoutes;
  for (let i = routes.length - 1; i >= 0; i--) {
    const path = routes[i]?.path;
    if (path !== undefined && path !== "*" && path !== "/*") return path;
  }
  return "unmatched";
}

export function describeError(error: unknown): {
  errorClass: string;
  errorCode?: string;
} {
  if (typeof error !== "object" || error === null)
    return { errorClass: "NonError" };
  const name = (error as { constructor?: { name?: unknown } }).constructor
    ?.name;
  const code = (error as { code?: unknown }).code;
  return {
    errorClass:
      typeof name === "string" && SAFE_NAME.test(name) ? name : "UnknownError",
    ...(typeof code === "string" && SAFE_CODE.test(code)
      ? { errorCode: code }
      : {}),
  };
}

export function registerRequestId(app: Hono) {
  app.use("*", async (c, next) => {
    // Client-supplied ids are ignored on purpose.
    const id = crypto.randomUUID();
    timings.set(c.req.raw, { id, start: performance.now() });
    c.header("request-id", id);
    await next();
    try {
      c.res.headers.set("request-id", id);
    } catch {
      // Immutable response headers; the pre-set header applies.
    }
  });
}

export function createErrorReporter(options: OpsOptions) {
  const counts = options.counts ?? new Map<string, number>();
  const log = options.log ?? ((line: string) => console.log(line));
  return {
    counts,
    onError(error: unknown, c: Context): Response {
      const timing = timings.get(c.req.raw);
      const route = routePattern(c);
      if (counts.has(route) || counts.size < MAX_ROUTES)
        counts.set(route, (counts.get(route) ?? 0) + 1);
      const record: FailureRecord = {
        time: new Date().toISOString(),
        requestId: timing?.id ?? "unknown",
        method: SAFE_METHOD.test(c.req.method) ? c.req.method : "OTHER",
        route,
        ...describeError(error),
        durationMs: timing
          ? Math.round((performance.now() - timing.start) * 100) / 100
          : 0,
      };
      try {
        log(JSON.stringify(record));
      } catch {
        // Logging must never change the response.
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      };
      if (timing) headers["request-id"] = timing.id;
      return new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers,
      });
    },
  };
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function tokenMatches(expected: string, given: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(expected), digest(given)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 1) ^ (b[i] ?? 2);
  return diff === 0;
}

// Registered before the staging guard: it authenticates with the ops token
// itself and answers 404 to everyone else.
export function registerErrorCounts(
  app: Hono,
  counts: Map<string, number>,
  token?: string | undefined,
) {
  app.get("/health/errors", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !given || !(await tokenMatches(token, given)))
      return c.json({ error: "not_found" }, 404);
    return c.json({ failures: Object.fromEntries(counts) });
  });
}
