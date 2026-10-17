import type { Hono } from "hono";
import type { RankingStore } from "./store.ts";
export function registerRankingRoutes(app: Hono, store: RankingStore) {
  app.get("/v1/rankings/holders", async (c) => {
    const query = c.req.query();
    const token = query.token;
    const limit = query.limit ?? "50";
    if (
      Object.keys(query).some(
        (key) => !["token", "limit", "cursor"].includes(key),
      ) ||
      !["TON", "JPEGPE"].includes(token ?? "") ||
      !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limit)
    )
      return c.json({ error: "invalid_query" }, 400);
    let offset = 0,
      revision: string | null = null;
    if (query.cursor !== undefined) {
      const match = /^(TON|JPEGPE):([a-f0-9]{32}):([1-9][0-9]{0,6})$/.exec(
        query.cursor,
      );
      if (!match || match[1] !== token || Number(match[3]) > 1_000_000)
        return c.json({ error: "invalid_cursor" }, 400);
      revision = match[2]!;
      offset = Number(match[3]);
    }
    const page = await store.page(token!, Number(limit), offset, revision);
    if (!page) return c.json({ error: "ranking_changed" }, 409);
    const entries = page.entries.slice(0, Number(limit)).map((entry) => ({
      rank: entry.rank,
      frogName: entry.frogName,
      frogId: entry.frogId,
      amount: entry.amount,
      asOf: entry.asOf,
      stale: entry.stale,
    }));
    return c.json({
      token,
      entries,
      nextCursor:
        page.entries.length > Number(limit)
          ? `${token}:${page.revision}:${offset + Number(limit)}`
          : null,
    });
  });
}
