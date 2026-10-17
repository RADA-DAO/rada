import type { Hono } from "hono";
import type { Action, GovernanceStore } from "./store.ts";
import { parseInput, uuid } from "./validation.ts";

type Authenticated = (
  c: { req: { header(name: string): string | undefined } },
  privileged: boolean,
) => Promise<string | null>;
const base = "/v1/governance";
export function registerGovernanceRoutes(
  app: Hono,
  store: GovernanceStore,
  authenticated: Authenticated,
) {
  app.get(`${base}/proposals`, async (c) => {
    const before = c.req.query("before") ?? null;
    if (before !== null && !uuid(before))
      return c.json({ error: "invalid_cursor" }, 400);
    return c.json({ proposals: await store.list(before) });
  });
  app.get(`${base}/proposals/:id`, async (c) => {
    const id = c.req.param("id");
    if (!uuid(id)) return c.json({ error: "not_found" }, 404);
    const proposal = await store.read(id);
    return proposal
      ? c.json({ proposal })
      : c.json({ error: "not_found" }, 404);
  });
  app.get(`${base}/proposals/:id/votes`, async (c) => {
    const id = c.req.param("id");
    const after = c.req.query("after") ?? "0";
    if (!uuid(id) || !/^\d{1,18}$/.test(after))
      return c.json({ error: "invalid_cursor" }, 400);
    return c.json({ votes: await store.votes(id, after) });
  });
  app.get(`${base}/votes/mine`, async (c) => {
    const actor = await authenticated(c, false);
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    return c.json({ votes: await store.mine(actor) });
  });
  app.get(`${base}/settings`, async (c) =>
    c.json({ settings: await store.settings() }),
  );
  app.get(`${base}/settings/history`, async (c) =>
    c.json({ history: await store.history() }),
  );
  const routes: [string, Action][] = [
    [`${base}/proposals`, "create"],
    [`${base}/settings`, "settings"],
    ...(["open", "withdraw", "vote", "decide", "evidence"] as const).map(
      (action): [string, Action] => [`${base}/proposals/:id/${action}`, action],
    ),
  ];
  for (const [path, action] of routes)
    app.post(path, async (c) => {
      const actor = await authenticated(c, true);
      if (!actor) return c.json({ error: "unauthorized" }, 401);
      const id = c.req.param("id");
      if (id !== undefined && !uuid(id))
        return c.json({ error: "not_found" }, 404);
      if (!c.req.header("content-type")?.startsWith("application/json"))
        return c.json({ error: "unsupported_type" }, 415);
      if (Number(c.req.header("content-length") ?? 0) > 100000)
        return c.json({ error: "too_large" }, 413);
      const raw = await c.req.text();
      if (new TextEncoder().encode(raw).length > 100000)
        return c.json({ error: "too_large" }, 413);
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return c.json({ error: "invalid_body" }, 400);
      }
      const input = parseInput(action, value);
      if (!input) return c.json({ error: "invalid_body" }, 400);
      try {
        const result = await store.write(actor, action, {
          ...input,
          proposal_id: id,
        });
        return c.json(
          { result },
          action === "create" || action === "evidence" ? 201 : 200,
        );
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "42501") return c.json({ error: "forbidden" }, 403);
        if (code === "P0002") return c.json({ error: "not_found" }, 404);
        if (code === "23514" || code === "23505")
          return c.json({ error: "conflict" }, 409);
        if (code === "22023" || code === "22P02")
          return c.json({ error: "invalid_body" }, 400);
        if (
          code === "membership_unavailable" ||
          (error as Error).message === "membership_unavailable"
        )
          return c.json({ error: "membership_unavailable" }, 503);
        throw error;
      }
    });
}
