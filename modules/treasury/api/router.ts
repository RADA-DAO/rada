import type { Hono } from "hono";
import type { TreasuryStore } from "./store.ts";
import { treasuryAddress } from "../../wallet/index.ts";
import { BodyTooLarge, readBoundedJson } from "../../../packages/http/body.ts";
type Auth = (
  c: { req: { header(name: string): string | undefined } },
  privileged: boolean,
) => Promise<string | null>;
const cursor = (v: string | null) => v === null || /^[1-9][0-9]{0,17}$/.test(v);
export function registerTreasuryRoutes(
  app: Hono,
  store: TreasuryStore,
  auth: Auth,
) {
  app.get("/v1/treasury/overview", async (c) => c.json(await store.overview()));
  app.get("/v1/treasury/transactions", async (c) => {
    const q = c.req.query(),
      before = q.before ?? null,
      direction = q.direction ?? null,
      token = q.token ?? null;
    if (
      Object.keys(q).some(
        (k) => !["before", "direction", "token"].includes(k),
      ) ||
      !cursor(before) ||
      (direction !== null && !["in", "out"].includes(direction)) ||
      (token !== null && !["TON", "JPEGPE"].includes(token))
    )
      return c.json({ error: "invalid_query" }, 400);
    const rows = await store.transactions(before, direction, token);
    return c.json({
      transactions: rows.slice(0, 50),
      nextCursor: rows.length > 50 ? rows[49]?.id : null,
    });
  });
  app.get("/v1/treasury/config/history", async (c) => {
    const before = c.req.query("before") ?? null;
    if (!cursor(before)) return c.json({ error: "invalid_cursor" }, 400);
    const rows = await store.history(before);
    return c.json({
      history: rows.slice(0, 50),
      nextCursor: rows.length > 50 ? rows[49]?.version : null,
    });
  });
  app.post("/v1/treasury/config", async (c) => {
    const actor = await auth(c, true);
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "unsupported_type" }, 415);
    try {
      const body = await readBoundedJson(c.req.raw, 4096);
      if (!body || typeof body !== "object" || Array.isArray(body))
        return c.json({ error: "invalid_body" }, 400);
      const v = body as Record<string, unknown>,
        address = treasuryAddress(v.address);
      if (
        Object.keys(v).length !== 3 ||
        !address ||
        typeof v.enabled !== "boolean" ||
        typeof v.reason !== "string" ||
        !v.reason.trim() ||
        v.reason.length > 1000 ||
        /\p{Cc}/u.test(v.reason)
      )
        return c.json({ error: "invalid_body" }, 400);
      await store.configure(actor, address, v.enabled, v.reason.trim());
      return c.json({ result: null });
    } catch (error) {
      if (error instanceof BodyTooLarge)
        return c.json({ error: "too_large" }, 413);
      if (error instanceof SyntaxError)
        return c.json({ error: "invalid_body" }, 400);
      const code = (error as { code?: string }).code;
      if (code === "42501") return c.json({ error: "forbidden" }, 403);
      if (code === "23514") return c.json({ error: "conflict" }, 409);
      throw error;
    }
  });
}
