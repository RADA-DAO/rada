import type { Hono } from "hono";
import {
  artworkPath,
  type ArtworkStore,
} from "../../../modules/jpegpe/index.ts";
import type { telegramAuthenticator } from "../../../modules/identity/index.ts";

/** Enrich only already-authorized frog projections, in one metadata-only query. */
export function registerArtworkProjections(
  app: Hono,
  store: ArtworkStore,
  authenticated: ReturnType<typeof telegramAuthenticator>,
) {
  app.use("*", async (c, next) => {
    await next();
    if (
      c.req.method !== "GET" ||
      c.res.status !== 200 ||
      !c.res.headers.get("Content-Type")?.startsWith("application/json") ||
      !(
        /^\/me(?:$|\/frogs$)/.test(c.req.path) ||
        /^\/v1\/(splash|rankings)\//.test(c.req.path)
      )
    )
      return;
    const body: unknown = await c.res.json();
    const frogs: {
      object: Record<string, unknown>;
      id: string;
      camel: boolean;
    }[] = [];
    function visit(value: unknown) {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== "object") return;
      const object = value as Record<string, unknown>;
      const camel = typeof object.frogId === "string";
      const id = camel ? object.frogId : object.frog_id;
      if (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id))
        frogs.push({ object, id, camel });
      Object.values(object).forEach(visit);
    }
    visit(body);
    if (frogs.length) {
      const refs = await store.references(
        [...new Set(frogs.map((f) => f.id))],
        await authenticated(c, false),
      );
      const paths = new Map(
        refs.map((r) => [r.frog_id, artworkPath(r.frog_id, r.sha256)]),
      );
      for (const { object, id, camel } of frogs)
        object[camel ? "artworkUrl" : "artwork_url"] = paths.get(id) ?? null;
    }
    c.res = new Response(JSON.stringify(body), {
      status: c.res.status,
      headers: c.res.headers,
    });
    c.res.headers.delete("Content-Length");
  });
}
