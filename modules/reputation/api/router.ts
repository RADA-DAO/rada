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

type Subscriber = {
  after(): string;
  deliver(delta: Changes): void;
  fail(): void;
};
export type ReputationRouteOptions = {
  maxClients?: number;
  catchupMs?: number;
};
/** Dirty hints share a LISTEN-backed store subscription per active actor.
 * Periodic durable catch-up recovers dropped hints and disconnected listeners.
 */
class FeedHub {
  private groups = new Map<
    string,
    {
      listeners: Set<Subscriber>;
      timer: ReturnType<typeof setInterval>;
      unsubscribe(): void;
      running: boolean;
      scheduled: boolean;
      dirty: boolean;
      readingAfter: string;
      poll(): void;
    }
  >();
  private clients = 0;
  private store: ReputationStore;
  private maxClients: number;
  private catchupMs: number;
  constructor(store: ReputationStore, options: ReputationRouteOptions) {
    this.store = store;
    this.maxClients = options.maxClients ?? 2048;
    this.catchupMs = options.catchupMs ?? 30000;
    if (
      !Number.isSafeInteger(this.maxClients) ||
      this.maxClients < 1 ||
      this.maxClients > 2048 ||
      !Number.isSafeInteger(this.catchupMs) ||
      this.catchupMs < 1000 ||
      this.catchupMs > 55000
    )
      throw new Error("invalid_reputation_stream_options");
  }
  attach(actor: string, listener: Subscriber): (() => void) | null {
    let group = this.groups.get(actor);
    if (this.clients >= this.maxClients || (group?.listeners.size ?? 0) >= 4)
      return null;
    if (!group) {
      const listeners = new Set<Subscriber>();
      const tick = async () => {
        if (group!.running || !listeners.size) return;
        group!.dirty = false;
        group!.running = true;
        const after = [...listeners]
          .map((l) => l.after())
          .reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
        group!.readingAfter = after;
        try {
          const delta = await this.store.changes(actor, after);
          for (const l of listeners) {
            const cursor = l.after();
            const reset =
              !delta.hasMore && BigInt(cursor) > BigInt(delta.nextCursor);
            l.deliver({
              ...delta,
              changes: delta.changes.filter(
                (c) => BigInt(c.revision) > BigInt(cursor),
              ),
              nextCursor:
                reset || BigInt(delta.nextCursor) > BigInt(cursor)
                  ? delta.nextCursor
                  : cursor,
              resetRequired: reset || delta.resetRequired,
            });
          }
          if (delta.hasMore) group!.dirty = true;
        } catch {
          for (const l of [...listeners]) l.fail();
        } finally {
          group!.running = false;
          if (group!.dirty && listeners.size) group!.poll();
        }
      };
      const poll = () => {
        group!.dirty = true;
        if (group!.running || group!.scheduled || !listeners.size) return;
        group!.scheduled = true;
        queueMicrotask(() => {
          group!.scheduled = false;
          void tick();
        });
      };
      group = {
        listeners,
        timer: setInterval(poll, this.catchupMs),
        unsubscribe: () => {},
        running: false,
        scheduled: false,
        dirty: false,
        readingAfter: "0",
        poll,
      };
      this.groups.set(actor, group);
      group.unsubscribe = this.store.onChange?.(actor, poll) ?? (() => {});
    }
    group.listeners.add(listener);
    this.clients++;
    if (!group.running || BigInt(listener.after()) < BigInt(group.readingAfter))
      group.poll();
    return () => {
      if (!group!.listeners.delete(listener)) return;
      this.clients--;
      if (!group!.listeners.size) {
        clearInterval(group!.timer);
        group!.unsubscribe();
        this.groups.delete(actor);
      }
    };
  }
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
