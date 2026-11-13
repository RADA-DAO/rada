import { FeedHub, type ReputationRouteOptions } from "./feed.ts";
export type { ReputationRouteOptions };
import type { Context, Hono } from "hono";
import { decodeItemCursor } from "./cursor.ts";
import { readBoundedJson } from "../../../packages/http/body.ts";
import type {
  AppealInput,
  Changes,
  Period,
  ReportInput,
  ReputationStore,
  VerifyInput,
} from "../contract.ts";

type Auth = (
  c: { req: { header(name: string): string | undefined } },
  privileged: boolean,
) => Promise<string | null>;
const uuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const requestId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const revision = (v: string) =>
  /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;
const period = (v: string): v is Period =>
  ["today", "week", "previous_week", "all"].includes(v);
function object(
  v: unknown,
  required: string[],
  optional: string[] = [],
): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    required.every((k) => Object.hasOwn(v, k)) &&
    Object.keys(v).every((k) => required.includes(k) || optional.includes(k))
  );
}
function https(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 2048 || /\s/.test(v)) return false;
  try {
    const u = new URL(v);
    return (
      u.protocol === "https:" && !!u.hostname && !u.username && !u.password
    );
  } catch {
    return false;
  }
}
export function validVerify(v: unknown): v is VerifyInput {
  return (
    object(v, ["requestId", "missionVersion"]) &&
    requestId(v.requestId) &&
    Number.isSafeInteger(v.missionVersion) &&
    Number(v.missionVersion) > 0 &&
    Number(v.missionVersion) <= 2147483647
  );
}
export function validReport(v: unknown): v is ReportInput {
  return (
    object(
      v,
      ["requestId", "title", "description", "occurredAt"],
      ["evidenceUrl"],
    ) &&
    requestId(v.requestId) &&
    text(v.title, 200) &&
    text(v.description, 8000) &&
    typeof v.occurredAt === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(
      v.occurredAt,
    ) &&
    Number.isFinite(Date.parse(v.occurredAt)) &&
    Date.parse(v.occurredAt) <= Date.now() + 300000 &&
    (!Object.hasOwn(v, "evidenceUrl") || https(v.evidenceUrl))
  );
}
export function validAppeal(v: unknown): v is AppealInput {
  return (
    object(v, ["requestId", "message"]) &&
    requestId(v.requestId) &&
    text(v.message, 4000)
  );
}
function error(c: Context, e: unknown): Response {
  const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
  if (code === "23505") return c.json({ error: "conflict" }, 409);
  if (code === "P0002") return c.json({ error: "not_found" }, 404);
  if (
    ["22023", "22P02", "22003", "22007", "22008", "23514", "23502"].includes(
      code,
    )
  )
    return c.json({ error: "invalid_body" }, 400);
  if (code === "28000") return c.json({ error: "unauthorized" }, 401);
  throw e;
}

export function registerReputationRoutes(
  app: Hono,
  store: ReputationStore,
  authenticated: Auth,
  options: ReputationRouteOptions = {},
) {
  const hub = new FeedHub(store, options);
  app.get("/v1/reputation/*", async (c, next) => {
    const actor = await authenticated(c, false);
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    c.set("reputationActor" as never, actor as never);
    c.header("Cache-Control", "private, no-store");
    try {
      await next();
    } catch (e) {
      return error(c, e);
    }
  });
  app.post("/v1/reputation/*", async (c, next) => {
    const actor = await authenticated(c, true);
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    c.set("reputationActor" as never, actor as never);
    c.header("Cache-Control", "private, no-store");
    try {
      await next();
    } catch (e) {
      return error(c, e);
    }
  });
  const guarded =
    (handler: (c: Context) => Response | Promise<Response>) =>
    async (c: Context) => {
      try {
        return await handler(c);
      } catch (e) {
        return error(c, e);
      }
    };
  const get = (
    path: string,
    handler: (c: Context) => Response | Promise<Response>,
  ) => app.get(path, guarded(handler));
  const post = (
    path: string,
    handler: (c: Context) => Response | Promise<Response>,
  ) => app.post(path, guarded(handler));
  const actor = (c: Context) => c.get("reputationActor" as never) as string;
  get("/v1/reputation/overview", async (c) => {
    const view = c.req.query("view") ?? "tasks";
    const p = c.req.query("period") ?? "today";
    const cursor = c.req.query("cursor") ?? null;
    if (view !== "tasks" && view !== "history")
      return c.json({ error: "invalid_view" }, 400);
    if (!period(p)) return c.json({ error: "invalid_period" }, 400);
    if (cursor !== null) {
      try {
        if (view === "history") decodeItemCursor(cursor);
        else if (!uuid(cursor)) throw new Error("invalid_cursor");
      } catch {
        return c.json({ error: "invalid_cursor" }, 400);
      }
    }
    if (!store.overview) return c.json({ error: "unavailable" }, 503);
    return c.json(await store.overview(actor(c), view, p, cursor));
  });
  get("/v1/reputation/appeals/commands/:requestId", async (c) => {
    const id = c.req.param("requestId");
    if (!requestId(id)) return c.json({ error: "invalid_request" }, 400);
    if (!store.appealCommand) return c.json({ error: "unavailable" }, 503);
    const appeal = await store.appealCommand(actor(c), id);
    return appeal ? c.json({ appeal }) : c.json({ error: "not_found" }, 404);
  });
  get("/v1/reputation/detail/:id", async (c) => {
    const id = c.req.param("id");
    const p = c.req.query("period") ?? "today";
    if (!id || !uuid(id)) return c.json({ error: "not_found" }, 404);
    if (!period(p)) return c.json({ error: "invalid_period" }, 400);
    if (!store.detail) return c.json({ error: "unavailable" }, 503);
    const detail = await store.detail(actor(c), id, p);
    return detail ? c.json(detail) : c.json({ error: "not_found" }, 404);
  });
  get("/v1/reputation/summary", async (c) => {
    const p = c.req.query("period") ?? "all";
    if (!period(p)) return c.json({ error: "invalid_period" }, 400);
    return c.json({ summary: await store.summary(actor(c), p) });
  });
  get("/v1/reputation/missions", async (c) => {
    const cursor = c.req.query("cursor") ?? null;
    if (cursor !== null && !uuid(cursor))
      return c.json({ error: "invalid_cursor" }, 400);
    return c.json(await store.missions(actor(c), cursor));
  });
  get("/v1/reputation/items", async (c) => {
    const p = c.req.query("period") ?? "all";
    const cursor = c.req.query("cursor") ?? null;
    if (!period(p)) return c.json({ error: "invalid_period" }, 400);
    if (cursor !== null) {
      try {
        decodeItemCursor(cursor);
      } catch {
        return c.json({ error: "invalid_cursor" }, 400);
      }
    }
    return c.json(await store.items(actor(c), p, cursor));
  });
  get("/v1/reputation/items/:id", async (c) => {
    const id = c.req.param("id");
    if (!id || !uuid(id)) return c.json({ error: "not_found" }, 404);
    const item = await store.item(actor(c), id);
    return item ? c.json({ item }) : c.json({ error: "not_found" }, 404);
  });
  get("/v1/reputation/items/:id/appeals", async (c) => {
    const id = c.req.param("id");
    if (!id || !uuid(id) || !(await store.item(actor(c), id)))
      return c.json({ error: "not_found" }, 404);
    return c.json({ appeals: await store.appeals(actor(c), id) });
  });
  get("/v1/reputation/commands/:requestId", async (c) => {
    const id = c.req.param("requestId");
    if (!requestId(id)) return c.json({ error: "invalid_request" }, 400);
    const result = await store.command(actor(c), id);
    return result
      ? c.json(result, result.state === "checking" ? 202 : 200)
      : c.json({ error: "not_found" }, 404);
  });
  get("/v1/reputation/changes", async (c) => {
    const after = c.req.query("after") ?? "0";
    if (!revision(after)) return c.json({ error: "invalid_revision" }, 400);
    return c.json(await store.changes(actor(c), after));
  });
  get("/v1/reputation/stream", (c) => {
    let after = c.req.query("after") ?? c.req.header("Last-Event-ID") ?? "0";
    if (!revision(after)) return c.json({ error: "invalid_revision" }, 400);
    let finish = () => {};
    let stopped = false;
    const a = actor(c);
    const encoder = new TextEncoder();
    let deliver = (_delta: Changes) => {};
    const detach = hub.attach(a, {
      after: () => after,
      deliver: (delta) => deliver(delta),
      fail: () => finish(),
    });
    if (!detach) return c.json({ error: "stream_limit" }, 429);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const timeout = setTimeout(() => finish(), 55000);
        const heartbeat = setInterval(() => {
          if (!stopped && (controller.desiredSize ?? 0) < -100) finish();
          else if (!stopped)
            controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 15000);
        finish = () => {
          if (stopped) return;
          stopped = true;
          clearTimeout(timeout);
          clearInterval(heartbeat);
          detach();
          c.req.raw.signal.removeEventListener("abort", finish);
          try {
            controller.close();
          } catch {
            /* Already cancelled. */
          }
        };
        deliver = (delta) => {
          if (stopped) return;
          if ((controller.desiredSize ?? 0) < -100) {
            finish();
            return;
          }
          if (delta.changes.length || delta.resetRequired) {
            controller.enqueue(
              encoder.encode(
                `id: ${delta.nextCursor}\nevent: changes\ndata: ${JSON.stringify(delta)}\n\n`,
              ),
            );
            after = delta.nextCursor;
          } else controller.enqueue(encoder.encode(": keepalive\n\n"));
        };
        c.req.raw.signal.addEventListener("abort", finish, { once: true });
        if (c.req.raw.signal.aborted) finish();
      },
      cancel() {
        finish();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "private, no-store",
        "X-Accel-Buffering": "no",
      },
    });
  });
  for (const path of [
    "/missions/:id/verify",
    "/reports",
    "/items/:id/appeals",
  ] as const) {
    post(`/v1/reputation${path}`, async (c) => {
      if (
        c.req
          .header("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase()
          .valueOf() !== "application/json"
      )
        return c.json({ error: "unsupported_type" }, 415);
      let input: unknown;
      try {
        input = await readBoundedJson(c.req.raw, 12288);
      } catch {
        return c.json({ error: "invalid_body" }, 400);
      }
      const id = c.req.param("id");
      if (path !== "/reports" && (!id || !uuid(id)))
        return c.json({ error: "not_found" }, 404);
      if (path === "/missions/:id/verify") {
        if (!validVerify(input)) return c.json({ error: "invalid_body" }, 400);
        const result = await store.verify(actor(c), id!, input);
        return c.json(result, result.state === "checking" ? 202 : 200);
      }
      if (path === "/reports") {
        if (!validReport(input)) return c.json({ error: "invalid_body" }, 400);
        return c.json(await store.report(actor(c), input), 202);
      }
      if (!validAppeal(input)) return c.json({ error: "invalid_body" }, 400);
      return c.json({ appeal: await store.appeal(actor(c), id!, input) });
    });
  }
}
